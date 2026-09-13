// netlify/functions/precios.js
//
// Esta función corre en el servidor (no en el navegador del usuario).
// Recibe una lista de destinos, y para cada uno consulta el precio más
// barato encontrado en el próximo año desde Mallorca (PMI) y desde
// Nueva York (NYC), usando la API de Travelpayouts.

const ORIGENES = [
  { codigo: "PMI", nombre: "Mallorca" },
  { codigo: "NYC", nombre: "Nueva York" }
];

exports.handler = async function (event) {
  // Solo aceptamos peticiones POST con un body { destinos: ["Tokio (NRT)", ...] }
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
    destinos = body.destinos; // Ej: [{ ciudad: "Tokio", codigoIATA: "NRT" }, ...]
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: "Body inválido" }) };
  }

  if (!Array.isArray(destinos) || destinos.length === 0) {
    return { statusCode: 400, body: JSON.stringify({ error: "No se enviaron destinos" }) };
  }

  try {
    const resultados = await Promise.all(
      destinos.map((destino) => buscarPrecioDestino(destino, token))
    );
    return {
      statusCode: 200,
      body: JSON.stringify({ resultados })
    };
  } catch (error) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Error consultando precios", detalle: String(error) })
    };
  }
};

// Consulta el precio más barato del año para un destino, desde cada origen
async function buscarPrecioDestino(destino, token) {
  const porOrigen = {};

  for (const origen of ORIGENES) {
    const precio = await consultarPrecioMasBarato(origen.codigo, destino.codigoIATA, token);
    porOrigen[origen.codigo] = precio; // { precio, fecha } o null si no se encontró
  }

  const pmi = porOrigen.PMI;
  const nyc = porOrigen.NYC;
  const total = pmi && nyc ? pmi.precio + nyc.precio : null;

  return {
    ciudad: destino.ciudad,
    codigoIATA: destino.codigoIATA,
    precioDesdeMallorca: pmi,
    precioDesdeNuevaYork: nyc,
    totalCombinado: total
  };
}

// Llama a la API de Travelpayouts y devuelve el ticket más barato encontrado
// en el próximo año para una ruta específica
async function consultarPrecioMasBarato(origen, destino, token) {
  const url = new URL("https://api.travelpayouts.com/aviasales/v3/get_latest_prices");
  url.searchParams.set("origin", origen);
  url.searchParams.set("destination", destino);
  url.searchParams.set("currency", "usd");
  url.searchParams.set("period_type", "year");
  url.searchParams.set("one_way", "true");
  url.searchParams.set("sorting", "price");
  url.searchParams.set("show_to_affiliates", "true");
  url.searchParams.set("limit", "1");
  url.searchParams.set("token", token);

  const respuesta = await fetch(url.toString());
  const datos = await respuesta.json();

  if (!datos.success || !Array.isArray(datos.data) || datos.data.length === 0) {
    return null;
  }

  const ticket = datos.data[0];
  return {
    precio: ticket.value,
    fecha: ticket.depart_date
  };
}