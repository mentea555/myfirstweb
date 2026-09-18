// 配额自检：GET /api/quota
// 一次性告诉你：代理有没有带 token、这个 token 是谁的、还剩多少次额度、
// 以及「如果没带 token」时 Vercel 出口 IP 看到的匿名额度是多少。
//
// 说明：
//   - 走 GitHub 的 /rate_limit 端点，该端点本身**不消耗** core 配额，可以随便刷。
//   - 本端点不缓存（no-store），每次都是真实值。
//   - 额外做一次 GET /user，用来确认 token 属于哪个账号（共消耗 1 次配额，可忽略）。
export default async function handler(req, res) {
  const base = {
    'User-Agent': 'mentea-web-proxy',
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28'
  };
  const token = process.env.GH_PROXY_TOKEN;
  const auth = Object.assign({}, base);
  if (token) auth.Authorization = 'Bearer ' + token;

  const pick = (h, j) => {
    const c = (j && j.resources && j.resources.core) || {};
    const reset = Number(c.reset || h.get('x-ratelimit-reset') || 0);
    return {
      limit: c.limit != null ? c.limit : Number(h.get('x-ratelimit-limit')),
      remaining: c.remaining != null ? c.remaining : Number(h.get('x-ratelimit-remaining')),
      used: c.used != null ? c.used : Number(h.get('x-ratelimit-used')),
      reset,
      reset_local: reset
        ? new Date(reset * 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })
        : null,
      reset_in_seconds: reset ? Math.max(0, reset - Math.floor(Date.now() / 1000)) : null
    };
  };

  const out = { token_configured: !!token, checked_at: new Date().toISOString() };

  try {
    // ① 带 token（或没 token 时的匿名）配额
    const r1 = await fetch('https://api.github.com/rate_limit', { headers: auth, cache: 'no-store' });
    const j1 = await r1.json().catch(() => ({}));
    out.proxy = pick(r1.headers, j1);

    // ② token 身份：谁、什么类型、什么时候过期、对这个仓库有没有读权限
    if (token) {
      try {
        const r3 = await fetch('https://api.github.com/user', { headers: auth, cache: 'no-store' });
        const scopes = r3.headers.get('x-oauth-scopes');
        if (r3.ok) {
          const u = await r3.json();
          out.token_login = u.login;
        } else {
          out.token_error = r3.status + ' ' + String(await r3.text()).slice(0, 160);
        }
        out.token_type = scopes ? `classic PAT（scopes: ${scopes}）` : 'fine-grained PAT';
        out.token_expires_at = r3.headers.get('github-authentication-token-expiration') || '不过期';
      } catch (e) {
        out.token_error = String(e.message || e);
      }
    }

    // ③ 不带 token 的匿名额度（诊断用：万一 token 过期/被撤销，会掉到这个池子）
    try {
      const r2 = await fetch('https://api.github.com/rate_limit', { headers: base, cache: 'no-store' });
      const j2 = await r2.json().catch(() => ({}));
      out.anonymous = pick(r2.headers, j2);
    } catch (e) {
      out.anonymous = { error: String(e.message || e) };
    }

    out.verdict = !token
      ? 'WARN：没配 GH_PROXY_TOKEN，正在用 Vercel 出口 IP 的匿名额度（60/h，且与他人共享）'
      : out.proxy.limit >= 5000
        ? `OK：代理已带 token（${out.token_login || '身份未知'}），走账号额度 ${out.proxy.limit}/h`
        : `WARN：带了 token 但额度只有 ${out.proxy.limit}/h，token 可能无效或被降级`;

    res.setHeader('Cache-Control', 'no-store, max-age=0');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.status(200).json(out);
  } catch (e) {
    res.status(502).json({ error: 'upstream ' + String(e.message || e) });
  }
}
