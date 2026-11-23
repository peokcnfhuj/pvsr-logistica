// /api/orders — guarda e busca pedidos da PVSR Logística no servidor.
// Vercel Serverless Function (Node, sem dependências externas).
//
// Por que existe: o "Atualizar pedido" do Adm buscava o pedido só no
// localStorage do aparelho que gerou o link. Um código verdadeiro gerado
// antes dessa função, ou em outro aparelho/navegador, não era encontrado —
// o código sozinho não carrega os dados (eles vivem no token do link).
// Agora a geração também envia o pedido ao servidor (Vercel KV), e a busca
// consulta o servidor quando não acha local: qualquer código verdadeiro
// funciona, de qualquer aparelho.
//
// Banco: Vercel KV (Upstash Redis), via REST. Variáveis de ambiente:
//   KV_REST_API_URL   — URL REST do banco (ex.: https://xxx.upstash.io)
//   KV_REST_API_TOKEN — token REST do banco
// Sem as variáveis, a função responde {ok:false, error:"not_configured"} e
// o site continua funcionando exatamente como antes (só localStorage),
// sem quebrar nada. O dono cria o banco em Vercel > Storage > Create
// Database > KV e liga as variáveis ao projeto (ver RELATORIO).
//
// Rotas:
//   GET  /api/orders?code=PVSR-XXXXXX -> {ok:true, found:true, data:{...}}
//                                     ou {ok:true, found:false}
//   GET  /api/orders?code=<codSF>     -> idem, pelo índice codSF -> ref
//   POST /api/orders  {data:{...}}    -> {ok:true} (salva por 365 dias,
//                                     indexado por ref e por codSF)
// Erros: {ok:false, error:"not_configured"|"invalid"|"missing_code"|
//         "method"|"kv_error"}
//   (o cliente trata qualquer erro como "não achou no servidor" e cai no
//   fallback do link completo.)
//
// O que é guardado: SÓ os dados do pedido (cliente, produto, origem,
// destino, transportadora, códigos, status, previsão, observação),
// indexados pelo código PVSR (chave "pvsr:order:PVSR-XXXXXX"). NUNCA
// senhas, tokens ou credenciais. Os campos passam por lista branca e
// limite de tamanho antes de gravar.

const KV_TTL_SECONDS = 31536000; // 365 dias; depois disso, vale o link completo.
const KEY_PREFIX = "pvsr:order:";
const KEY_CODS_F_PREFIX = "pvsr:order-by-codsf:";
const CODE_RE = /^PVSR-[A-Z0-9]{4,12}$/;
const ANY_CODE_RE = /^[A-Z0-9]{4,32}$/;
const MAX_BODY_BYTES = 16384;
const STRING_FIELDS = ["cliente", "produto", "origem", "destino", "transportadora", "codTransp", "codSF", "linkTransp", "appLink", "appCarrier", "appOrderId", "previsao", "obs", "atualizado"];
const MAX_STR = 500;
const MAX_OBS = 1000;

function kvConfig() {
  var url = process.env.KV_REST_API_URL || "";
  var token = process.env.KV_REST_API_TOKEN || "";
  if (!url || !token) return null;
  return { url: url.replace(/\/+$/, ""), token: token };
}

function sendJson(res, httpStatus, obj) {
  res.writeHead(httpStatus, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(obj));
}

// Uma chamada ao REST do Upstash: POST na URL base com o comando em array.
// Ex.: ["GET","pvsr:order:PVSR-ABC123"] -> {result:"{...}"|null}
//      ["SET","pvsr:order:PVSR-ABC123","{...}","EX","31536000"] -> {result:"OK"}
async function kvCommand(cfg, command) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    const res = await fetch(cfg.url, {
      method: "POST",
      headers: { Authorization: "Bearer " + cfg.token, "Content-Type": "application/json" },
      body: JSON.stringify(command),
      signal: ctrl.signal,
    });
    if (!res.ok) return { error: "kv_http_" + res.status };
    const j = await res.json();
    if (j && j.error) return { error: String(j.error) };
    return { result: (j || {}).result };
  } catch (e) {
    return { error: "kv_fetch_failed" };
  } finally {
    clearTimeout(timer);
  }
}

// Valida e limpa os dados do pedido: só os campos conhecidos entram,
// com tamanho limitado. Devolve null se o pedido for inválido.
function cleanData(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  var ref = String(input.ref || "").trim().toUpperCase();
  if (!CODE_RE.test(ref)) return null;
  var s = parseInt(input.s, 10);
  if (isNaN(s)) s = 0;
  s = Math.max(0, Math.min(6, s));
  var v = parseInt(input.v, 10);
  if (isNaN(v) || (v !== 1 && v !== 2)) v = 2;
  var out = { v: v, ref: ref, s: s };
  STRING_FIELDS.forEach(function (f) {
    var val = input[f];
    if (typeof val !== "string") val = "";
    var max = f === "obs" ? MAX_OBS : MAX_STR;
    if (val.length > max) val = val.slice(0, max);
    out[f] = val;
  });
  // Códigos da transportadora são normalizados (maiúsculas, sem espaços
  // nem traços) para a busca por codSF funcionar como digitado.
  out.codSF = String(out.codSF || "").replace(/[\s-]/g, "").toUpperCase();
  out.codTransp = String(out.codTransp || "").replace(/[\s-]/g, "").toUpperCase();
  return out;
}

async function kvGetData(cfg, ref) {
  var r = await kvCommand(cfg, ["GET", KEY_PREFIX + ref]);
  if (r.error) return { error: r.error };
  if (r.result === null || r.result === undefined) return { found: false };
  var data = null;
  try { data = JSON.parse(r.result); } catch (e) { data = null; }
  if (!data || data.ref !== ref) return { found: false };
  return { found: true, data: data };
}

async function handleGet(req, res, cfg) {
  var raw = String((req.query && req.query.code) || "").trim().toUpperCase();
  if (!raw) return sendJson(res, 400, { ok: false, error: "missing_code" });
  // O código PVSR tem traço (PVSR-XXXXXX) e a chave no KV também;
  // o código da transportadora não tem traço. Por isso o teste PVSR
  // usa a forma com traço e o índice codSF usa a forma sem traço.
  var dashCode = raw.replace(/\s+/g, "");
  var code = dashCode.replace(/-/g, "");
  if (!ANY_CODE_RE.test(code)) return sendJson(res, 400, { ok: false, error: "invalid" });
  if (!cfg) return sendJson(res, 200, { ok: false, error: "not_configured" });
  // Código PVSR: busca direta pela chave do pedido.
  if (CODE_RE.test(dashCode)) {
    var direct = await kvGetData(cfg, dashCode);
    if (direct.error) return sendJson(res, 200, { ok: false, error: "kv_error" });
    if (!direct.found) return sendJson(res, 200, { ok: true, found: false });
    return sendJson(res, 200, { ok: true, found: true, data: direct.data });
  }
  // Código da transportadora: o índice codSF -> ref resolve o pedido.
  var ptr = await kvCommand(cfg, ["GET", KEY_CODS_F_PREFIX + code]);
  if (ptr.error) return sendJson(res, 200, { ok: false, error: "kv_error" });
  if (ptr.result === null || ptr.result === undefined) return sendJson(res, 200, { ok: true, found: false });
  var ref = String(ptr.result).trim().toUpperCase();
  if (!CODE_RE.test(ref)) return sendJson(res, 200, { ok: true, found: false });
  var byRef = await kvGetData(cfg, ref);
  if (byRef.error) return sendJson(res, 200, { ok: false, error: "kv_error" });
  if (!byRef.found) return sendJson(res, 200, { ok: true, found: false });
  return sendJson(res, 200, { ok: true, found: true, data: byRef.data });
}

async function handlePost(req, res, cfg) {
  var body = req.body;
  if (typeof body === "string") {
    if (body.length > MAX_BODY_BYTES) return sendJson(res, 400, { ok: false, error: "invalid" });
    try { body = JSON.parse(body); } catch (e) { return sendJson(res, 400, { ok: false, error: "invalid" }); }
  }
  var data = cleanData(body && body.data);
  if (!data) return sendJson(res, 400, { ok: false, error: "invalid" });
  if (!cfg) return sendJson(res, 200, { ok: false, error: "not_configured" });
  var value = JSON.stringify(data);
  var r = await kvCommand(cfg, ["SET", KEY_PREFIX + data.ref, value, "EX", String(KV_TTL_SECONDS)]);
  if (r.error) return sendJson(res, 200, { ok: false, error: "kv_error" });
  if (r.result !== "OK") return sendJson(res, 200, { ok: false, error: "kv_error" });
  // Índice secundário: código da transportadora (codSF) -> código PVSR.
  // Se o codSF mudar numa atualização, o ponteiro antigo continua
  // apontando para o mesmo pedido (o ref não muda) — segue válido.
  // Se o ponteiro falhar, o pedido já está salvo; não quebra a geração.
  if (data.codSF) {
    try {
      await kvCommand(cfg, ["SET", KEY_CODS_F_PREFIX + data.codSF, data.ref, "EX", String(KV_TTL_SECONDS)]);
    } catch (e) { /* índice secundário é melhor esforço */ }
  }
  return sendJson(res, 200, { ok: true });
}

module.exports = async function handler(req, res) {
  try {
    var method = (req.method || "GET").toUpperCase();
    var cfg = kvConfig();
    if (method === "GET") return await handleGet(req, res, cfg);
    if (method === "POST") return await handlePost(req, res, cfg);
    res.setHeader("Allow", "GET, POST");
    return sendJson(res, 405, { ok: false, error: "method" });
  } catch (e) {
    return sendJson(res, 200, { ok: false, error: "kv_error" });
  }
};
