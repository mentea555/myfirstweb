// 配额自检：GET /api/quota
// 一次性告诉你：代理有没有带 token、这个 token 是谁的、还剩多少次额度。
//
// ★ 重要（2026-09-18 实测）：GitHub 的 /rate_limit 端点**响应本身会被缓存**，
//   它给出的 used/remaining 可能是几分钟前的旧值（实测显示 used=0，而同刻真实值是 used=104）。
//   所以本端点额外发一次**真实请求**，读那次响应自带的 x-ratelimit-* 头 —— 那才是真值。
//   合计消耗 1 次配额（5000/h 里可忽略）。
//
//   - /rate_limit 端点本身不消耗配额，可以随便刷。
//   - 本端点不缓存（no-store）。
export default async function handler(req, res) {
  const base = {
    'User-Agent': 'mentea-web-proxy',
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28'
  };
  const token = process.env.GH_PROXY_TOKEN;
  const auth = Object.assign({}, base);
  if (token) auth.Authorization = 'Bearer ' + token;

  const fromHeaders = (h) => {
    const reset = Number(h.get('x-ratelimit-reset') || 0);
    return {
      limit: Number(h.get('x-ratelimit-limit')),
      remaining: Number(h.get('x-ratelimit-remaining')),
      used: Number(h.get('x-ratelimit-used')),
      reset,
      reset_local: reset
        ? new Date(reset * 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })
        : null,
      reset_in_seconds: reset ? Math.max(0, reset - Math.floor(Date.now() / 1000)) : null
    };
  };

  const out = { token_configured: !!token, checked_at: new Date().toISOString() };

  try {
    // ① token 身份：谁、什么类型、什么时候过期
    if (token) {
      try {
        const ru = await fetch('https://api.github.com/user', { headers: auth, cache: 'no-store' });
        const scopes = ru.headers.get('x-oauth-scopes');
        if (ru.ok) out.token_login = (await ru.json()).login;
        else out.token_error = ru.status + ' ' + String(await ru.text()).slice(0, 160);
        out.token_type = scopes ? `classic PAT（scopes: ${scopes}）` : 'fine-grained PAT';
        out.token_expires_at = ru.headers.get('github-authentication-token-expiration') || '不过期';
      } catch (e) {
        out.token_error = String(e.message || e);
      }
    }

    // ② ★ 真值：发一次真实请求，读它自带的配额头
    try {
      const rl = await fetch('https://api.github.com/repos/mentea555/myfirstweb', {
        headers: auth,
        cache: 'no-store'
      });
      out.live = fromHeaders(rl.headers);
      out.live.note = '这是「刚刚这一次真实请求」时 GitHub 返回的配额头，可信';
    } catch (e) {
      out.live = { error: String(e.message || e) };
    }

    // ③ 参考值：/rate_limit 端点（可能带缓存，仅供对照）
    try {
      const r1 = await fetch('https://api.github.com/rate_limit?cb=' + Date.now(), {
        headers: auth,
        cache: 'no-store'
      });
      const j1 = await r1.json().catch(() => ({}));
      const c = (j1.resources && j1.resources.core) || {};
      out.rate_limit_endpoint = {
        limit: c.limit,
        remaining: c.remaining,
        used: c.used,
        note: 'GitHub 对 /rate_limit 的响应有缓存，这里的 used/remaining 可能滞后，别当准数'
      };
    } catch (e) {
      out.rate_limit_endpoint = { error: String(e.message || e) };
    }

    // ④ 不带 token 的匿名额度（诊断用）
    if (!token) {
      try {
        const r2 = await fetch('https://api.github.com/rate_limit?cb=' + Date.now(), {
          headers: base,
          cache: 'no-store'
        });
        out.anonymous = fromHeaders(r2.headers);
      } catch (e) {
        out.anonymous = { error: String(e.message || e) };
      }
    }

    const live = out.live || {};
    out.verdict = !token
      ? 'WARN：没配 GH_PROXY_TOKEN，正在用 Vercel 出口 IP 的匿名额度（60/h，且与他人共享）'
      : live.limit >= 5000
        ? `OK：代理已带 token（${out.token_login || '身份未知'}），走账号额度 ${live.limit}/h，本小时已用 ${live.used}`
        : `WARN：带了 token 但额度只有 ${live.limit}/h，token 可能无效或被降级`;

    // ⑤ 自检本身就让主人看一眼透传头，与 /api/file 的 X-GitHub-Quota-* 同源
    if (live.limit) {
      res.setHeader('X-GitHub-Quota-Limit', String(live.limit));
      res.setHeader('X-GitHub-Quota-Remaining', String(live.remaining));
      res.setHeader('X-GitHub-Quota-Used', String(live.used));
      res.setHeader('X-GitHub-Quota-Reset', String(live.reset));
    }
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.status(200).json(out);
  } catch (e) {
    res.status(502).json({ error: 'upstream ' + String(e.message || e) });
  }
}
