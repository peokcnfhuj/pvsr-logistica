// /api/track — consulta o status de um envio na Super Frete pelo código de rastreio.
// Vercel Serverless Function (Node, sem dependências externas).
//
// O token da API da Super Frete fica SÓ na variável de ambiente SUPERFRETE_TOKEN
// (Vercel > Settings > Environment Variables). Ele NUNCA aparece no frontend nem
// nesta resposta. Sem o token, a função responde {state:"no_token"} e o site usa
// o status manual do Adm, como antes.
//
// Respostas:
//   {state:"live", status, carrier?, origin?, destination?, eta?, lastEvent?}
//     status: índice de 0 a 6 nos 7 status do site
//       0 Objeto em preparo · 1 Esperando a transportadora · 2 Objeto postado
//       3 Coletado · 4 Em trânsito · 5 Saiu para entrega · 6 Entregue
//     origin/destination: só cidade/UF — nunca endereço, nome, CPF ou telefone.
//     lastEvent: {date, city, label} da última movimentação, quando a API traz.
//   {state:"not_found"} — o código não está nos envios da conta.
//   {state:"no_token"}  — SUPERFRETE_TOKEN não configurado na Vercel.
//   {state:"error"}     — a Super Frete falhou, demorou demais ou o status dela
//                         não tem correspondência nos 7 do site.
//
// A lista de envios fica em cache em memória por 30 min (melhor esforço em
// serverless: vale quando a instância está quente) e as páginas são buscadas
// em paralelo; o resultado de cada código também fica em cache por 30 min —
// consultas repetidas respondem na hora, sem chamar a API de novo.
//
// Aviso: o formato de resposta de GET /api/v0/me/orders não foi confirmado com
// uma chamada real (a única tentativa ao vivo deu timeout na conexão lenta). O
// código abaixo aceita os formatos mais prováveis (array direto ou dentro de
// data/orders/results/items) e vários nomes de campo — se a Super Frete mudar o
// formato, a função cai em "error" e o site mantém o status manual, sem quebrar.

const SF_ORDERS_URL = "https://api.superfrete.com/api/v0/me/orders";
const SF_ORDER_URL = "https://api.superfrete.com/api/v0/order/";
const USER_AGENT = "PVSR Logistica 1.0 (pedro.reis1@uscsonline.com.br)";

// Orçamento total da função: o plano Hobby da Vercel limita a função a 10 s.
const OVERALL_BUDGET_MS = 8000;
const FETCH_TIMEOUT_MS = 4000;
const MAX_PAGES = 3;

// Cache em memória da lista de envios: válido por 30 minutos. Melhor esforço —
// instâncias serverless frias não guardam o cache, mas quando a instância está
// quente as consultas repetidas respondem na hora, sem chamar a Super Frete.
// O token NUNCA é guardado aqui: só a lista pública de envios (código, status,
// transportadora), que já é o que a função devolve ao site.
const ORDERS_CACHE_TTL_MS = 30 * 60 * 1000;
let ordersCache = { fetchedAt: 0, list: null };

// Cache do resultado por código (live e not_found), válido por 30 min:
// consulta repetida do mesmo código responde na hora, sem chamar a API de
// novo — nem a lista, nem o detalhe. Erro e falta de token NÃO são cacheados.
const RESULT_CACHE_TTL_MS = 30 * 60 * 1000;
const resultCache = new Map();

function cacheResult(code, out) {
  if (resultCache.size > 500) resultCache.clear();
  resultCache.set(code, { fetchedAt: Date.now(), out });
}

function sendJson(res, httpStatus, obj) {
  res.writeHead(httpStatus, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(obj));
}

function normCode(code) {
  return String(code || "").replace(/[\s-]/g, "").toUpperCase();
}

// Uma tentativa com timeout; na 1ª falha por timeout, tenta de novo uma vez
// (a API da Super Frete já provou ser lenta na 1ª chamada e rápida no retry).
async function fetchWithRetry(url, headers, deadline) {
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const remaining = deadline - Date.now();
    if (remaining <= 500) break;
    const timeoutMs = Math.min(FETCH_TIMEOUT_MS, remaining);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const r = await fetch(url, { method: "GET", headers, signal: ctrl.signal });
      clearTimeout(timer);
      if (!r.ok) throw new Error("http " + r.status);
      return await r.json();
    } catch (e) {
      clearTimeout(timer);
      lastError = e;
      // Só repete quando foi timeout; erro HTTP (401/403/404) não adianta repetir.
      if (!e || e.name !== "AbortError") break;
    }
  }
  throw lastError || new Error("fetch failed");
}

// Lista todos os envios da conta: usa o cache em memória quando válido e,
// senão, busca as páginas em paralelo em vez de uma por vez (a API da Super
// Frete é lenta por chamada; em paralelo o tempo total é o da página mais
// lenta, não a soma). Só guarda no cache quando TODAS as páginas vieram —
// lista parcial nunca é cacheada, para não "esconder" um envio por 30 min.
// Retorna {list, complete}: complete=false quando alguma página falhou.
async function fetchOrdersList(headers, deadline) {
  const now = Date.now();
  if (ordersCache.list && now - ordersCache.fetchedAt < ORDERS_CACHE_TTL_MS) {
    return { list: ordersCache.list, complete: true };
  }
  const results = await Promise.allSettled(
    Array.from({ length: MAX_PAGES }, function (_, i) {
      return fetchWithRetry(SF_ORDERS_URL + "?page=" + (i + 1), headers, deadline);
    })
  );
  // A 1ª página tem que vir: sem ela não há lista confiável.
  if (results[0].status !== "fulfilled") throw new Error("orders fetch failed");
  const all = [];
  let complete = true;
  for (const r of results) {
    if (r.status === "fulfilled") {
      for (const o of extractList(r.value)) all.push(o);
    } else {
      complete = false;
    }
  }
  if (complete) ordersCache = { fetchedAt: Date.now(), list: all };
  return { list: all, complete };
}

function extractList(body) {
  if (Array.isArray(body)) return body;
  if (body && typeof body === "object") {
    for (const key of ["data", "orders", "results", "items"]) {
      if (Array.isArray(body[key])) return body[key];
    }
    // Um único pedido em vez de lista.
    if (body.id || body.tracking || body.tracking_code) return [body];
  }
  return [];
}

function firstString(obj, keys) {
  if (!obj || typeof obj !== "object") return "";
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
}

function trackingOf(order) {
  let t = firstString(order, ["tracking", "tracking_code", "trackingCode", "code"]);
  if (t) return t;
  const nested = order.tracking;
  if (nested && typeof nested === "object") {
    return firstString(nested, ["code", "tracking_code", "trackingCode", "number"]);
  }
  return "";
}

function carrierOf(order) {
  let c = firstString(order, ["carrier", "carrier_name", "carrierName", "transportadora"]);
  if (c) return c;
  for (const key of ["company", "carrier"]) {
    const nested = order[key];
    if (nested && typeof nested === "object") {
      c = firstString(nested, ["name", "fantasy_name", "company"]);
      if (c) return c;
    } else if (typeof nested === "string" && nested.trim()) {
      return nested.trim();
    }
  }
  return "";
}

function statusOf(order) {
  let s = firstString(order, ["status"]);
  if (s) return s;
  const nested = order.tracking;
  if (nested && typeof nested === "object") {
    return firstString(nested, ["status"]);
  }
  return "";
}

// Mapeia o status da Super Frete para os 7 status do site (-1 = sem correspondência).
function mapStatus(raw) {
  const s = String(raw || "").toLowerCase().trim().replace(/_/g, " ");
  if (!s) return -1;
  if (s.indexOf("deliver") === 0 || s === "entregue") return 6;
  if (s.indexOf("out for") === 0 || s.indexOf("saiu") === 0) return 5;
  if (s.indexOf("transit") > -1 || s.indexOf("trânsito") > -1 || s.indexOf("transito") > -1) return 4;
  if (s.indexOf("collect") === 0 || s.indexOf("colet") === 0) return 3;
  if (s.indexOf("post") === 0) return 2;
  if (s.indexOf("released") === 0 || s.indexOf("generated") === 0 || s.indexOf("liberad") === 0 ||
      s.indexOf("aguardando") === 0 || s.indexOf("waiting") === 0) return 1;
  if (s.indexOf("created") === 0 || s.indexOf("pending") === 0 || s.indexOf("pendente") === 0 ||
      s.indexOf("prepar") === 0) return 0;
  return -1;
}

// Origem/destino: só cidade/UF. Texto livre de endereço NUNCA volta — pode ser
// rua e número do remetente/destinatário. Objeto sem cidade/estado é descartado.
function cityStateOf(value) {
  if (!value || typeof value !== "object") return "";
  const city = firstString(value, ["city", "cidade"]);
  const state = firstString(value, ["state", "uf", "estado"]);
  if (city && state) return city + "/" + state.toUpperCase();
  if (city) return city;
  return "";
}

function placeOf(order, keys) {
  for (const k of keys) {
    const v = order[k];
    const cs = cityStateOf(v);
    if (cs) return cs;
  }
  return "";
}

function lastEventOf(order) {
  let arr = null;
  for (const key of ["tracking_history", "history", "events", "tracking_events", "movements"]) {
    if (Array.isArray(order[key]) && order[key].length) { arr = order[key]; break; }
  }
  if (!arr) {
    const t = order.tracking;
    if (t && typeof t === "object") {
      for (const key of ["history", "events"]) {
        if (Array.isArray(t[key]) && t[key].length) { arr = t[key]; break; }
      }
    }
  }
  if (!arr) return null;
  const ev = arr[arr.length - 1];
  if (!ev || typeof ev !== "object") return null;
  const label = firstString(ev, ["description", "label", "status", "event", "message"]).slice(0, 140);
  if (!label) return null;
  const out = { label };
  const date = firstString(ev, ["date", "created_at", "createdAt", "timestamp", "updated_at"]);
  if (date) out.date = date.slice(0, 10);
  const city = firstString(ev, ["city", "cidade"]) ||
    cityStateOf(ev.location || ev.address || null);
  if (city) out.city = city;
  return out;
}

module.exports = async function handler(req, res) {
  const deadline = Date.now() + OVERALL_BUDGET_MS;

  if (req.method && req.method !== "GET") {
    return sendJson(res, 405, { state: "error" });
  }

  const code = normCode((req.query && req.query.code) || "");
  if (!code || code.length > 64) {
    return sendJson(res, 400, { state: "error" });
  }

  const token = process.env.SUPERFRETE_TOKEN;
  if (!token) {
    return sendJson(res, 200, { state: "no_token" });
  }

  // Resultado em cache (30 min): responde na hora, sem chamar a API.
  const cachedResult = resultCache.get(code);
  if (cachedResult && Date.now() - cachedResult.fetchedAt < RESULT_CACHE_TTL_MS) {
    return sendJson(res, 200, cachedResult.out);
  }

  const headers = {
    Authorization: "Bearer " + token,
    "User-Agent": USER_AGENT,
    Accept: "application/json",
  };

  try {
    // 1) Lista os envios da conta (com cache + páginas em paralelo) e
    // procura pelo código de rastreio.
    const { list, complete } = await fetchOrdersList(headers, deadline);
    let found = null;
    for (const order of list) {
      if (order && typeof order === "object" && normCode(trackingOf(order)) === code) {
        found = order;
        break;
      }
    }

    if (!found) {
      // Lista incompleta (alguma página falhou): não afirmar "não encontrado".
      if (complete) cacheResult(code, { state: "not_found" });
      return sendJson(res, 200, { state: complete ? "not_found" : "error" });
    }

    const status = mapStatus(statusOf(found));
    if (status < 0) {
      return sendJson(res, 200, { state: "error" });
    }

    const out = { state: "live", status };
    const carrier = carrierOf(found);
    if (carrier) out.carrier = carrier;

    // 2) Detalhe do pedido (melhor esforço): origem, destino, previsão e
    // última movimentação. Se falhar, o rastreio segue só com o status.
    if (found.id && deadline - Date.now() > 2000) {
      try {
        const detail = await fetchWithRetry(
          SF_ORDER_URL + encodeURIComponent(String(found.id)),
          headers,
          deadline
        );
        const d = (detail && typeof detail === "object" && !Array.isArray(detail))
          ? (detail.data && typeof detail.data === "object" ? detail.data : detail)
          : {};
        const origin = placeOf(d, ["origin", "from", "sender", "origin_address", "sender_address"]);
        if (origin) out.origin = origin;
        const destination = placeOf(d, ["destination", "to", "recipient", "destination_address", "recipient_address"]);
        if (destination) out.destination = destination;
        const eta = firstString(d, ["delivery_date", "estimated_delivery", "delivery_forecast", "eta", "deliveryDate"]);
        if (eta) out.eta = eta.slice(0, 10);
        const ev = lastEventOf(d) || lastEventOf(found);
        if (ev) out.lastEvent = ev;
      } catch (e) {
        // Detalhe indisponível: segue com os dados da lista.
      }
    }
    if (!out.lastEvent) {
      const ev = lastEventOf(found);
      if (ev) out.lastEvent = ev;
    }

    cacheResult(code, out);
    return sendJson(res, 200, out);
  } catch (e) {
    return sendJson(res, 200, { state: "error" });
  }
};
