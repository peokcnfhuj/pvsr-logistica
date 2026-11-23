// /api/panel-probe — teste: a rede da Vercel alcança o painel da linha?
// Sem credenciais: só verifica a assinatura do bloqueio (raiz 307 para o
// Google + 404 vazio = rede recusada). Se a rede for aceita, a raiz devolve
// outra coisa (200/403/página) e o passo seguinte testa com credencial
// passada pelo servidor (nunca neste arquivo).
module.exports = async function handler(req, res) {
  const targets = [
    'http://nactip.com/',
    'http://nactip.com/get.php',
    'http://nactip.com/player_api.php',
  ];
  const out = {};
  for (const u of targets) {
    try {
      const c = new AbortController();
      const t = setTimeout(() => c.abort(), 10000);
      const r = await fetch(u, { method: 'GET', redirect: 'manual', signal: c.signal });
      clearTimeout(t);
      const text = await r.text();
      out[u] = { status: r.status, location: r.headers.get('location') || null, bytes: text.length, sample: text.slice(0, 120) };
    } catch (e) {
      out[u] = { error: String((e && e.message) || e) };
    }
  }
  res.status(200).json(out);
};
