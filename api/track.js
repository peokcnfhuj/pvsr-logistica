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
// FORMATO REAL CONFIRMADO (22/11/2026, chamada ao vivo):
//   GET /api/v0/me/orders?page=N devolve {data:[...], meta:{total, per_page,
//   page, last_page}} — 20 pedidos por página. Cada pedido traz: tracking
//   (código Super Frete, ex. SLGE5HGESUGJJ), order_id (ULID, ex.
//   01M81NESY1119DPEF8KBFWPXAJ), status, carrier, price, delivery {min,max
//   em dias}, from/to {city, state, ...} e pudo. NÃO há campo "id" (é
//   "order_id") e NÃO há o código da transportadora em lugar nenhum — a API
//   da Super Frete não expõe o código próprio da transportadora. Por isso o
//   site tem que sincronizar com o código Super Frete, nunca com o código
//   da transportadora (ver o patch do front no relatório).
//   GET /api/v0/order/{order_id} devolve 200 com o HTML do site da Super
//   Frete, não JSON — o detalhe por pedido NÃO serve para enriquecer a
//   resposta; origem/destino (cidade/UF) vêm do próprio item da lista.
//
// A lista de envios fica em cache em memória por 5 min (melhor esforço em
// serverless: vale quando a instância está quente) e TODAS as páginas são
// buscadas em paralelo; o resultado "live" de cada código também fica em
// cache por 5 min. Já o "not_found" fica em cache só por 3 min — um envio
// criado agora aparece no rastreio logo, sem ficar "escondido" por minutos.
// A lista e o resultado têm o mesmo prazo: se a lista ficasse mais tempo
// em cache, o resultado "live" de 5 min releria uma lista velha e o prazo
// de 5 min não valeria nada. O botão "Atualizar agora" do site passa
// fresh=1 e força uma consulta nova à Super Frete, regravando os dois
// caches — a fonte continua sendo a Super Frete, que repassa a
// movimentação da transportadora com atraso; nada aqui é "tempo real".
//
// ENTREGAS POR APLICATIVO (Uber / 99 / Lalamove):
//   Nenhum dos três tem rastreio público por código: o destinatário
//   acompanha por um LINK ao vivo por entrega. O site aceita esse link
//   colado (pelo Adm ou pelo cliente) e mostra o cartão com o botão
//   "Ver rastreio ao vivo" — o link oficial nunca é construído à mão.
//   GET /api/track?lalamove=<id> — consulta a Lalamove API v3
//     (GET /v3/orders/{orderId}, auth HMAC-SHA256). Só funciona com
//     LALAMOVE_API_KEY e LALAMOVE_API_SECRET na Vercel; sem elas,
//     {state:"no_token"} e o site mostra só o link. O <id> é o ID
//     numérico do pedido (12 a 19 dígitos) ou, como melhor esforço,
//     o código do shareLink (?BR...); se a Lalamove não reconhecer,
//     {state:"not_found"}.
//   GET /api/track?uber=<deliveryId> — Uber Direct API (OAuth 2.0,
//     escopo eats.deliveries). DORMENTE: precisa de UBER_DIRECT_CLIENT_ID,
//     UBER_DIRECT_CLIENT_SECRET e UBER_DIRECT_CUSTOMER_ID, que o dono
//     ainda não tem. O código está pronto: basta criar as variáveis.
//   GET /api/track?n99=<orderId> — 99Entrega API (OAuth 2.0, escopo
//     entrega.order). DORMENTE: precisa de N99_CLIENT_ID e
//     N99_CLIENT_SECRET, que o dono ainda não tem. Idem: basta criar.
//   Status mapeados para os 7 do site (ver mapLalamoveStatus,
//   mapUberStatus, map99Status). CANCELED/REJECTED/EXPIRED e outros
//   sem correspondência devolvem {state:"error"} e o site mantém o
//   status manual do Adm. Nenhuma credencial de aplicativo é lida
//   no frontend: só aqui, no servidor, via variável de ambiente.

const crypto = require("crypto");

const SF_ORDERS_URL = "https://api.superfrete.com/api/v0/me/orders";
const SF_ORDER_URL = "https://api.superfrete.com/api/v0/order/";
const LALA_BASE = "https://rest.lalamove.com";
const UBER_AUTH_URL = "https://auth.uber.com/oauth/v2/token";
const UBER_API_BASE = "https://api.uber.com";
const N99_AUTH_URL = "https://entrega.99app.com/entrega-openplatform/oauth/v2/token";
const N99_API_BASE = "https://entrega.99app.com/entrega-openplatform";
const USER_AGENT = "PVSR Logistica 1.0 (pedro.reis1@uscsonline.com.br)";

// Orçamento total da função: o plano Hobby da Vercel limita a função a 10 s.
const OVERALL_BUDGET_MS = 8000;
const FETCH_TIMEOUT_MS = 4000;
// 1ª rodada busca as páginas 1..5 em paralelo (até 100 envios). Se o meta
// disser que há mais páginas, uma 2ª rodada busca o resto, até 10 páginas
// (200 envios) — acima disso a lista é considerada incompleta e um código
// não achado devolve "error", nunca um "not_found" falso.
const FIRST_ROUND_PAGES = 5;
const MAX_TOTAL_PAGES = 10;

// Cache em memória da lista de envios: válido por 5 minutos. Melhor esforço —
// instâncias serverless frias não guardam o cache, mas quando a instância está
// quente as consultas repetidas respondem na hora, sem chamar a Super Frete.
// O token NUNCA é guardado aqui: só a lista pública de envios (código, status,
// transportadora), que já é o que a função devolve ao site. O prazo é o mesmo
// do resultado "live" (5 min): a lista é a fonte do resultado.
const ORDERS_CACHE_TTL_MS = 5 * 60 * 1000;
let ordersCache = { fetchedAt: 0, list: null };

// Cache do resultado por código: "live" vale por 5 min; "not_found" vale
// só por 3 min, para um envio criado agora ser achado logo. Erro e falta
// de token NÃO são cacheados. Com fresh=1 na query, a leitura do cache é
// ignorada e o resultado novo regrava o cache (ver o handler).
const RESULT_CACHE_TTL_MS = 5 * 60 * 1000;
const NOT_FOUND_CACHE_TTL_MS = 3 * 60 * 1000;
const resultCache = new Map();

function cacheResult(code, out) {
  const ttl = out && out.state === "not_found" ? NOT_FOUND_CACHE_TTL_MS : RESULT_CACHE_TTL_MS;
  if (resultCache.size > 500) resultCache.clear();
  resultCache.set(code, { fetchedAt: Date.now(), ttl, out });
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

// Uma chamada JSON qualquer (GET ou POST): devolve {ok, status, body} sem
// jogar erro em HTTP 4xx/5xx, para o chamador decidir (404 = não achado).
async function fetchJsonOnce(url, options, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(function () { ctrl.abort(); }, timeoutMs);
  try {
    const r = await fetch(url, Object.assign({}, options, { signal: ctrl.signal }));
    let body = null;
    try { body = await r.json(); } catch (e) { body = null; }
    return { ok: r.ok, status: r.status, body: body };
  } finally { clearTimeout(timer); }
}

// Como fetchWithRetry, mas para as APIs dos aplicativos: repete uma vez só
// em timeout; erro HTTP volta como {ok:false} para o chamador decidir.
async function fetchJsonRetry(url, options, deadline) {
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const remaining = deadline - Date.now();
    if (remaining <= 500) break;
    const timeoutMs = Math.min(FETCH_TIMEOUT_MS, remaining);
    try {
      return await fetchJsonOnce(url, options, timeoutMs);
    } catch (e) {
      lastErr = e;
      if (!e || e.name !== "AbortError") throw e;
    }
  }
  throw lastErr || new Error("fetch failed");
}

/* ---------- Lalamove API v3 (ativa quando há credencial) ----------
   Auth HMAC-SHA256 oficial: SIGNATURE =
   HmacSHA256Hex(<TIMESTAMP>\r\n<MÉTODO>\r\n<PATH>\r\n\r\n<BODY>, SECRET);
   header "Authorization: hmac <KEY>:<TIMESTAMP>:<SIGNATURE>", mais
   "Market: BR" e "Request-ID: <nonce>". Chaves no Partner Portal da
   Lalamove (aba Developers); produção em rest.lalamove.com. */
function lalamoveSignature(secret, timestamp, method, path, body) {
  const msg = timestamp + "\r\n" + method + "\r\n" + path + "\r\n" + "\r\n" + body;
  return crypto.createHmac("sha256", secret).update(msg).digest("hex");
}

function mapLalamoveStatus(raw) {
  const s = String(raw || "").toUpperCase().trim();
  if (s === "COMPLETED") return 6;
  if (s === "ON_GOING" || s === "PICKED_UP") return 4;
  if (s === "ASSIGNING_DRIVER") return 1;
  return -1; // CANCELED, REJECTED, EXPIRED e outros: sem correspondência
}

async function fetchLalamoveOrder(orderId, deadline) {
  const key = process.env.LALAMOVE_API_KEY;
  const secret = process.env.LALAMOVE_API_SECRET;
  if (!key || !secret) return { state: "no_token" };
  const path = "/v3/orders/" + encodeURIComponent(orderId);
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const requestId = crypto.randomUUID ? crypto.randomUUID() :
    Date.now() + "-" + Math.random().toString(36).slice(2);
  const signature = lalamoveSignature(secret, timestamp, "GET", path, "");
  const headers = {
    Authorization: "hmac " + key + ":" + timestamp + ":" + signature,
    Market: "BR",
    "Request-ID": requestId,
    Accept: "application/json",
  };
  try {
    const r = await fetchJsonRetry(LALA_BASE + path, { method: "GET", headers: headers }, deadline);
    if (r.status === 404) return { state: "not_found" };
    if (!r.ok || !r.body) return { state: "error" };
    const d = (r.body && typeof r.body === "object")
      ? (r.body.data && typeof r.body.data === "object" ? r.body.data : r.body) : {};
    const status = mapLalamoveStatus(d.status);
    if (status < 0) return { state: "error" };
    const out = { state: "live", status: status, carrier: "lalamove" };
    const share = firstString(d, ["shareLink"]);
    if (share) out.shareLink = share;
    return out;
  } catch (e) {
    return { state: "error" };
  }
}

/* ---------- Uber Direct API (DORMENTE — sem credencial ainda) ----------
   OAuth 2.0 client_credentials: POST auth.uber.com/oauth/v2/token
   (grant_type=client_credentials, scope=eats.deliveries) e depois
   GET api.uber.com/v1/customers/{customer_id}/deliveries/{delivery_id}.
   Para ligar: criar UBER_DIRECT_CLIENT_ID, UBER_DIRECT_CLIENT_SECRET e
   UBER_DIRECT_CUSTOMER_ID na Vercel (credenciais na aba Developer do
   dashboard direct.uber.com). Sem elas, {state:"no_token"} e o site
   mostra só o link. NÃO há API para o Uber Envios de consumidor. */
let uberTokenCache = { token: null, expiresAt: 0 };

async function uberDirectToken(deadline) {
  const now = Date.now();
  if (uberTokenCache.token && now < uberTokenCache.expiresAt) return uberTokenCache.token;
  const clientId = process.env.UBER_DIRECT_CLIENT_ID;
  const clientSecret = process.env.UBER_DIRECT_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  const body = new URLSearchParams({
    client_id: clientId, client_secret: clientSecret,
    grant_type: "client_credentials", scope: "eats.deliveries",
  }).toString();
  const r = await fetchJsonRetry(UBER_AUTH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: body,
  }, deadline);
  if (!r.ok || !r.body || !r.body.access_token) throw new Error("uber token failed");
  const expiresIn = parseInt(r.body.expires_in, 10);
  uberTokenCache = {
    token: r.body.access_token,
    expiresAt: now + (isNaN(expiresIn) ? 3600 : expiresIn) * 1000 - 60000,
  };
  return uberTokenCache.token;
}

function mapUberStatus(raw) {
  const s = String(raw || "").toLowerCase().trim();
  if (s === "delivered") return 6;
  if (s === "dropoff") return 5;
  if (s === "pickup_complete") return 4;
  if (s === "pickup") return 3;
  if (s === "pending") return 1;
  return -1; // canceled, returned e outros: sem correspondência
}

async function fetchUberDirectDelivery(deliveryId, deadline) {
  const customerId = process.env.UBER_DIRECT_CUSTOMER_ID;
  if (!customerId) return { state: "no_token" };
  try {
    const token = await uberDirectToken(deadline);
    if (!token) return { state: "no_token" };
    const r = await fetchJsonRetry(
      UBER_API_BASE + "/v1/customers/" + encodeURIComponent(customerId) +
      "/deliveries/" + encodeURIComponent(deliveryId),
      { method: "GET", headers: { Authorization: "Bearer " + token, Accept: "application/json" } },
      deadline);
    if (r.status === 404) return { state: "not_found" };
    if (!r.ok || !r.body) return { state: "error" };
    const status = mapUberStatus(r.body.status);
    if (status < 0) return { state: "error" };
    const out = { state: "live", status: status, carrier: "uber" };
    const tu = firstString(r.body, ["tracking_url"]);
    if (tu) out.trackingUrl = tu;
    const eta = firstString(r.body, ["dropoff_eta", "pickup_eta"]);
    if (eta) out.eta = eta.slice(0, 10);
    return out;
  } catch (e) {
    return { state: "error" };
  }
}

/* ---------- 99Entrega API (DORMENTE — sem credencial ainda) ----------
   OAuth 2.0 client_credentials: POST entrega.99app.com/entrega-openplatform/
   oauth/v2/token (scope=entrega.order, token de 2h) e depois
   GET .../v2/order/detail?order_id=<id> (ou ?external_order_id=).
   Para ligar: criar N99_CLIENT_ID e N99_CLIENT_SECRET na Vercel
   (conta de desenvolvedor no site da 99Entrega, com aprovação). Sem
   elas, {state:"no_token"} e o site mostra só o link. NÃO há API para
   corridas do app de passageiro comum — só para 99Entrega empresas. */
let n99TokenCache = { token: null, expiresAt: 0 };

async function n99Token(deadline) {
  const now = Date.now();
  if (n99TokenCache.token && now < n99TokenCache.expiresAt) return n99TokenCache.token;
  const clientId = process.env.N99_CLIENT_ID;
  const clientSecret = process.env.N99_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  const body = new URLSearchParams({
    client_id: clientId, client_secret: clientSecret,
    grant_type: "client_credentials", scope: "entrega.order",
  }).toString();
  const r = await fetchJsonRetry(N99_AUTH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: body,
  }, deadline);
  if (!r.ok || !r.body || !r.body.access_token) throw new Error("99 token failed");
  const expiresIn = parseInt(r.body.expires_in, 10);
  n99TokenCache = {
    token: r.body.access_token,
    expiresAt: now + (isNaN(expiresIn) ? 7200 : expiresIn) * 1000 - 60000,
  };
  return n99TokenCache.token;
}

function map99Status(raw) {
  const s = String(raw || "").toLowerCase().trim();
  if (s === "completed") return 6;
  if (s === "delivering" || s === "sendback") return 4;
  if (s === "finding" || s === "waiting") return 1;
  return -1; // canceled, closed, sendbackCompleted e outros: sem correspondência
}

async function fetch99Order(orderId, deadline) {
  try {
    const token = await n99Token(deadline);
    if (!token) return { state: "no_token" };
    const url = N99_API_BASE + "/v2/order/detail?order_id=" + encodeURIComponent(orderId);
    const r = await fetchJsonRetry(url, {
      method: "GET", headers: { Authorization: "Bearer " + token, Accept: "application/json" },
    }, deadline);
    if (r.status === 404) return { state: "not_found" };
    if (!r.ok || !r.body) return { state: "error" };
    const d = (r.body && typeof r.body === "object")
      ? (r.body.data && typeof r.body.data === "object" ? r.body.data : r.body) : {};
    const status = map99Status(d.status);
    if (status < 0) return { state: "error" };
    const out = { state: "live", status: status, carrier: "99" };
    const tl = firstString(d, ["tracking_link"]);
    if (tl) out.trackingLink = tl;
    return out;
  } catch (e) {
    return { state: "error" };
  }
}

// Última página da lista, lida do meta da 1ª página ({data, meta:{last_page}}).
// Sem meta, assume as páginas da 1ª rodada (não afirma que a lista acabou).
function lastPageOf(body) {
  if (Array.isArray(body)) return FIRST_ROUND_PAGES;
  if (!body || typeof body !== "object") return 1;
  const meta = body.meta && typeof body.meta === "object" ? body.meta : null;
  const v = (meta && (meta.last_page || meta.total_pages)) ||
    body.last_page || body.total_pages || FIRST_ROUND_PAGES;
  const n = parseInt(v, 10);
  return isNaN(n) || n < 1 ? 1 : n;
}

// Lista TODOS os envios da conta: usa o cache em memória quando válido e,
// senão, busca as páginas em paralelo (a API da Super Frete é lenta por
// chamada; em paralelo o tempo total é o da página mais lenta, não a soma).
// Só guarda no cache quando TODAS as páginas existentes vieram — lista
// parcial nunca é cacheada, para não "esconder" um envio por 5 min.
// Retorna {list, complete}: complete=false quando alguma página que deveria
// existir falhou (ou quando há mais páginas que o teto) — nesse caso um
// código não achado devolve "error", nunca "not_found".
// Com forceRefresh=true, ignora o cache da lista e busca de novo.
async function fetchOrdersList(headers, deadline, forceRefresh) {
  const now = Date.now();
  if (!forceRefresh && ordersCache.list && now - ordersCache.fetchedAt < ORDERS_CACHE_TTL_MS) {
    return { list: ordersCache.list, complete: true };
  }
  const all = [];
  let complete = true;

  // 1ª rodada: páginas 1..5 em paralelo.
  const first = await Promise.allSettled(
    Array.from({ length: FIRST_ROUND_PAGES }, function (_, i) {
      return fetchWithRetry(SF_ORDERS_URL + "?page=" + (i + 1), headers, deadline);
    })
  );
  // A 1ª página tem que vir: sem ela não há lista confiável.
  if (first[0].status !== "fulfilled") throw new Error("orders fetch failed");
  const lastPage = lastPageOf(first[0].value);
  for (let i = 0; i < first.length; i++) {
    const pageNum = i + 1;
    const r = first[i];
    if (r.status === "fulfilled") {
      for (const o of extractList(r.value)) all.push(o);
    } else if (pageNum <= lastPage) {
      // Falha numa página que deveria existir: lista incompleta.
      complete = false;
    }
    // Falha numa página além da última: a API não tem essa página; ignora.
  }

  // 2ª rodada: se houver mais páginas que a 1ª rodada, busca o resto.
  const totalPages = Math.min(lastPage, MAX_TOTAL_PAGES);
  if (lastPage > FIRST_ROUND_PAGES) {
    if (lastPage > MAX_TOTAL_PAGES) complete = false;
    if (Date.now() < deadline - 500) {
      const rest = await Promise.allSettled(
        Array.from({ length: totalPages - FIRST_ROUND_PAGES }, function (_, i) {
          return fetchWithRetry(
            SF_ORDERS_URL + "?page=" + (FIRST_ROUND_PAGES + i + 1), headers, deadline);
        })
      );
      for (let i = 0; i < rest.length; i++) {
        const r = rest[i];
        if (r.status === "fulfilled") {
          for (const o of extractList(r.value)) all.push(o);
        } else {
          complete = false;
        }
      }
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
    if (body.id || body.order_id || body.tracking || body.tracking_code) return [body];
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

// Todos os códigos pelos quais um pedido pode ser achado, já normalizados:
// o código Super Frete ("tracking") e o order_id — a API não expõe o código
// próprio da transportadora, então ele não pode ser casado aqui.
function codeCandidates(order) {
  const out = [];
  const push = function (v) {
    if (typeof v === "string" && v.trim()) {
      const n = normCode(v);
      if (n && out.indexOf(n) === -1) out.push(n);
    }
  };
  for (const k of ["tracking", "tracking_code", "trackingCode", "code", "order_id", "orderId"]) {
    push(order[k]);
  }
  const nested = order.tracking;
  if (nested && typeof nested === "object") {
    for (const k of ["code", "tracking_code", "trackingCode", "number"]) push(nested[k]);
  }
  return out;
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

  // fresh=1 (botão "Atualizar agora" do site): ignora a leitura dos caches
  // e força uma consulta nova à fonte, regravando o cache com o resultado.
  // Sem ele, vale o cache de 5 min (live) / 3 min (not_found).
  const fresh = String((req.query && req.query.fresh) || "").trim() === "1";

  // Entregas por aplicativo (sem ?code=): ?lalamove=, ?uber= e ?n99=.
  // Cada uma só consulta a API oficial quando as credenciais estão nas
  // variáveis de ambiente; sem elas, {state:"no_token"} e o site mostra
  // só o link do aplicativo (ver o comentário no topo do arquivo).
  const lala = String((req.query && req.query.lalamove) || "").trim();
  if (lala) {
    if (!/^[A-Za-z0-9]{4,64}$/.test(lala)) return sendJson(res, 400, { state: "error" });
    const key = "lala:" + lala;
    const hit = resultCache.get(key);
    if (!fresh && hit && Date.now() - hit.fetchedAt < hit.ttl) return sendJson(res, 200, hit.out);
    const out = await fetchLalamoveOrder(lala, deadline);
    if (out.state === "live" || out.state === "not_found") cacheResult(key, out);
    return sendJson(res, 200, out);
  }
  const uberId = String((req.query && req.query.uber) || "").trim();
  if (uberId) {
    if (!/^[A-Za-z0-9_\-]{3,64}$/.test(uberId)) return sendJson(res, 400, { state: "error" });
    const key = "uber:" + uberId;
    const hit = resultCache.get(key);
    if (!fresh && hit && Date.now() - hit.fetchedAt < hit.ttl) return sendJson(res, 200, hit.out);
    const out = await fetchUberDirectDelivery(uberId, deadline);
    if (out.state === "live" || out.state === "not_found") cacheResult(key, out);
    return sendJson(res, 200, out);
  }
  const n99Id = String((req.query && req.query.n99) || "").trim();
  if (n99Id) {
    if (!/^[0-9]{6,20}$/.test(n99Id)) return sendJson(res, 400, { state: "error" });
    const key = "n99:" + n99Id;
    const hit = resultCache.get(key);
    if (!fresh && hit && Date.now() - hit.fetchedAt < hit.ttl) return sendJson(res, 200, hit.out);
    const out = await fetch99Order(n99Id, deadline);
    if (out.state === "live" || out.state === "not_found") cacheResult(key, out);
    return sendJson(res, 200, out);
  }

  const code = normCode((req.query && req.query.code) || "");
  if (!code || code.length > 64) {
    return sendJson(res, 400, { state: "error" });
  }

  const token = process.env.SUPERFRETE_TOKEN;
  if (!token) {
    return sendJson(res, 200, { state: "no_token" });
  }

  // Resultado em cache: "live" vale 5 min, "not_found" só 3 min.
  // Com fresh=1, pula a leitura do cache e consulta a Super Frete de novo.
  const cachedResult = resultCache.get(code);
  if (!fresh && cachedResult && Date.now() - cachedResult.fetchedAt < cachedResult.ttl) {
    return sendJson(res, 200, cachedResult.out);
  }

  const headers = {
    Authorization: "Bearer " + token,
    "User-Agent": USER_AGENT,
    Accept: "application/json",
  };

  try {
    // 1) Lista TODOS os envios da conta (com cache + páginas em paralelo)
    // e procura pelo código de rastreio (ou pelo order_id). Com fresh=1,
    // a lista também é buscada de novo, não só o resultado por código.
    const { list, complete } = await fetchOrdersList(headers, deadline, fresh);
    let found = null;
    for (const order of list) {
      if (order && typeof order === "object" &&
          codeCandidates(order).indexOf(code) !== -1) {
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

    // Origem/destino (só cidade/UF) vêm do próprio item da lista — o
    // detalhe por pedido não devolve JSON (ver o comentário no topo).
    const origin = placeOf(found, ["from", "origin", "sender", "origin_address", "sender_address"]);
    if (origin) out.origin = origin;
    const destination = placeOf(found, ["to", "destination", "recipient", "destination_address", "recipient_address"]);
    if (destination) out.destination = destination;

    // 2) Detalhe do pedido (melhor esforço): previsão e última movimentação.
    // Na prática o endpoint devolve o HTML do site da Super Frete, então
    // quase sempre cai no catch e o rastreio segue só com o status — sem
    // quebrar. O campo real é "order_id", não "id".
    const detailId = found.order_id || found.id;
    if (detailId && deadline - Date.now() > 2000) {
      try {
        const detail = await fetchWithRetry(
          SF_ORDER_URL + encodeURIComponent(String(detailId)),
          headers,
          deadline
        );
        const d = (detail && typeof detail === "object" && !Array.isArray(detail))
          ? (detail.data && typeof detail.data === "object" ? detail.data : detail)
          : {};
        if (!out.origin) {
          const o2 = placeOf(d, ["origin", "from", "sender", "origin_address", "sender_address"]);
          if (o2) out.origin = o2;
        }
        if (!out.destination) {
          const d2 = placeOf(d, ["destination", "to", "recipient", "destination_address", "recipient_address"]);
          if (d2) out.destination = d2;
        }
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
