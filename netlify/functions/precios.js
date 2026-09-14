// netlify/functions/precios.js
//
// Esta función corre en el servidor (no en el navegador del usuario).
// Recibe una lista de destinos (cada uno con su temporada preferida), y para
// cada uno busca, dentro de esa temporada, las fechas donde AMBOS orígenes
// (Mallorca y Nueva York) tienen vuelos baratos y cercanos entre sí en el
// calendario. Devuelve hasta 3 combinaciones de fecha para comparar, cada
// una con su link directo de compra en Aviasales.

const TOLERANCIA_DIAS = 5;       // qué tan cerca deben caer las 2 fechas para contar como "el mismo viaje"
const OPCIONES_A_DEVOLVER = 3;   // cuántas combinaciones de fecha mostrar por destino
const PAUSA_ENTRE_LLAMADAS_MS = 300; // para no exceder el límite de la API (60 consultas/minuto)

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Método no permitido" };
  }

  const token = process.env.TRAVELPAYOUTS_TOKEN;
  if (!token) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Falta configurar TRAVELPAYOUTS_TOKEN en Netlify" })
    };
  }

  let destinos;
  try {
    const body = JSON.parse(event.body);
    destinos = body.destinos; // [{ ciudad, codigoIATA, temporada }, ...]
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: "Body inválido" }) };
  }

  if (!Array.isArray(destinos) || destinos.length === 0) {
    return { statusCode: 400, body: JSON.stringify({ error: "No se enviaron destinos" }) };
  }

  try {
    const resultados = [];
    // Procesamos los destinos uno por uno (no en paralelo) para no exceder
    // el límite de peticiones por minuto de la API.
    for (const destino of destinos) {
      const resultado = await buscarOpcionesDestino(destino, token);
      resultados.push(resultado);
    }
    return { statusCode: 200, body: JSON.stringify({ resultados }) };
  } catch (error) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Error consultando precios", detalle: String(error) })
    };
  }
};

// Busca, para un destino, las mejores combinaciones de fecha entre ambos orígenes
async function buscarOpcionesDestino(destino, token) {
  const meses = mesesParaTemporada(destino.temporada);

  const opcionesPMI = await buscarOpcionesPorMeses("PMI", destino.codigoIATA, meses, token);
  await pausa(PAUSA_ENTRE_LLAMADAS_MS);
  const opcionesNYC = await buscarOpcionesPorMeses("NYC", destino.codigoIATA, meses, token);
  await pausa(PAUSA_ENTRE_LLAMADAS_MS);

  const combinaciones = emparejarFechas(opcionesPMI, opcionesNYC);

  return {
    ciudad: destino.ciudad,
    codigoIATA: destino.codigoIATA,
    temporada: destino.temporada,
    opciones: combinaciones,
    sinCoincidencias: combinaciones.length === 0
  };
}

// Consulta precios para una ruta a lo largo de varios meses (uno por uno) y
// devuelve la lista combinada, ordenada del más barato al más caro.
async function buscarOpcionesPorMeses(origen, destino, meses, token) {
  let todas = [];
  for (const mes of meses) {
    const opciones = await consultarMes(origen, destino, mes, token);
    todas = todas.concat(opciones);
    await pausa(PAUSA_ENTRE_LLAMADAS_MS);
  }
  todas.sort((a, b) => a.precio - b.precio);
  return todas.slice(0, 15); // nos quedamos con las 15 más baratas encontradas
}

// Llama a la API GraphQL de Travelpayouts para un mes específico
async function consultarMes(origen, destino, mesISO, token) {
  const query = `{
    prices_one_way(
      params: {
        origin: "${origen}"
        destination: "${destino}"
        depart_months: "${mesISO}"
      }
      paging: { limit: 5, offset: 0 }
      sorting: VALUE_ASC
    ) {
      departure_at
      value
      ticket_link
    }
  }`;

  const respuesta = await fetch("https://api.travelpayouts.com/graphql/v1/query", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Access-Token": token
    },
    body: JSON.stringify({ query })
  });

  const datos = await respuesta.json();
  const lista = datos?.data?.prices_one_way;
  if (!Array.isArray(lista)) return [];

  return lista.map((t) => ({
    precio: t.value,
    fecha: t.departure_at,
    link: "https://www.aviasales.com/search" + t.ticket_link
  }));
}

// Empareja las opciones de ambos orígenes cuando sus fechas caen cerca
function emparejarFechas(opcionesA, opcionesB) {
  const pares = [];

  for (const a of opcionesA) {
    for (const b of opcionesB) {
      const dias = diferenciaEnDias(a.fecha, b.fecha);
      if (dias <= TOLERANCIA_DIAS) {
        pares.push({
          fechaMallorca: a.fecha,
          precioMallorca: a.precio,
          linkMallorca: a.link,
          fechaNuevaYork: b.fecha,
          precioNuevaYork: b.precio,
          linkNuevaYork: b.link,
          total: a.precio + b.precio,
          diferenciaDias: dias
        });
      }
    }
  }

  // Más barato primero; si hay empate, preferimos la fecha más cercana entre ambos
  pares.sort((x, y) => x.total - y.total || x.diferenciaDias - y.diferenciaDias);

  // Evitar mostrar 3 combinaciones casi idénticas: exigimos que difieran
  // al menos 10 días entre sí en la fecha de Mallorca
  const seleccionadas = [];
  for (const par of pares) {
    const yaHayCercana = seleccionadas.some(
      (s) => diferenciaEnDias(s.fechaMallorca, par.fechaMallorca) < 10
    );
    if (!yaHayCercana) seleccionadas.push(par);
    if (seleccionadas.length >= OPCIONES_A_DEVOLVER) break;
  }

  return seleccionadas;
}

function diferenciaEnDias(fechaISO1, fechaISO2) {
  const ms = Math.abs(new Date(fechaISO1) - new Date(fechaISO2));
  return Math.round(ms / (1000 * 60 * 60 * 24));
}

// Traduce la temporada elegida a una lista de meses (YYYY-MM-01) dentro
// del próximo año
function mesesParaTemporada(temporada) {
  const mesesPorTemporada = {
    primavera: [3, 4, 5],
    verano: [6, 7, 8],
    otono: [9, 10, 11],
    invierno: [12, 1, 2],
    cualquiera: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]
  };
  const mesesBuscados = mesesPorTemporada[temporada] || mesesPorTemporada.cualquiera;

  const hoy = new Date();
  const resultado = [];

  // Recorremos los próximos 12 meses y nos quedamos con los que coincidan
  // con la temporada pedida
  for (let i = 1; i <= 12; i++) {
    const fecha = new Date(hoy.getFullYear(), hoy.getMonth() + i, 1);
    const mesNumero = fecha.getMonth() + 1;
    if (mesesBuscados.includes(mesNumero)) {
      const yyyy = fecha.getFullYear();
      const mm = String(mesNumero).padStart(2, "0");
      resultado.push(`${yyyy}-${mm}-01`);
    }
  }

  return resultado;
}

function pausa(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
