// 配额自检：GET /api/quota
// 直接问 GitHub「这个代理现在还剩多少次额度」，并告诉你代理有没有带上 token。
//
// 判读：
//   limit = 5000 → 代理带了 GH_PROXY_TOKEN，用主人账号的额度（推荐）
//   limit = 60   → 代理没带 token，正在用 Vercel 出口 IP 的匿名额度（所有 Vercel 用户共享）
//
// 说明：
//   - 走 GitHub 的 /rate_limit 端点，该端点本身**不消耗** core 配额，可以随便刷。
//   - 本端点不缓存（no-store），每次都是真实值。
export default async function handler(req, res) {
  const headers = {
    'User-Agent': 'mentea-web-proxy',
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28'
  };
  const token = process.env.GH_PROXY_TOKEN;
  if (token) headers.Authorization = 'Bearer ' + token;

  try {
    const r = await fetch('https://api.github.com/rate_limit', { headers });
    const j = await r.json().catch(() => ({}));
    const c = (j && j.resources && j.resources.core) || {};
    const reset = Number(c.reset || r.headers.get('x-ratelimit-reset') || 0);
    const limit = c.limit != null ? c.limit : Number(r.headers.get('x-ratelimit-limit'));
    const remaining = c.remaining != null ? c.remaining : Number(r.headers.get('x-ratelimit-remaining'));

    res.setHeader('Cache-Control', 'no-store, max-age=0');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.status(200).json({
      token_configured: !!token,
      verdict: token
        ? 'OK：代理已带 token，走主人账号的额度'
        : 'WARN：代理没带 token，正在用 Vercel 出口 IP 的匿名额度（60/h）',
      quota_source: token ? 'GitHub 账号（5000/h）' : 'Vercel 出口 IP（匿名 60/h）',
      core: {
        limit,
        remaining,
        used: c.used != null ? c.used : Number(r.headers.get('x-ratelimit-used')),
        reset,
        reset_local: reset
          ? new Date(reset * 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })
          : null,
        reset_in_seconds: reset ? Math.max(0, reset - Math.floor(Date.now() / 1000)) : null
      },
      checked_at: new Date().toISOString()
    });
  } catch (e) {
    res.status(502).json({ error: 'upstream ' + String(e.message || e) });
  }
}
