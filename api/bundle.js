// 打包代理：一次请求把 content/ 下「全部文件」拿回来。
//
// 为什么需要它：
//   前端首页/画廊页渲染时要读 1 个目录清单 + 3~4 个配置 + 每篇文章的正文。
//   走 /api/file 逐个读，20 篇文章就是 20 次 GitHub REST 调用，每次都扣配额。
//   GitHub 的 **GraphQL** 允许一次请求带回任意多个文件，且配额按「点数」算：
//   实测 2026-09-18 —— 21 个文件（5 个配置 + 16 篇文章，共 7.3KB）只花 1 点。
//   ⇒ 一次页面加载从 20 次配额降到 1 次，等于把 5000/h 的可用页面加载数提高 20 倍。
//
// 用法：GET /api/bundle
// 返回：{ ok, ref, count, files: { "content/xxx.json": "文本", ... }, fetchedAt }
//
// 安全：本端点**不接受任何路径参数**，查询里写死了 owner/repo/content 目录，
//       不存在路径穿越问题，比 /api/file 更安全。
//
// 缓存：与 /api/file 同策略（s-maxage=5），主人改完 5 秒内全站生效。
export default async function handler(req, res) {
  const token = process.env.GH_PROXY_TOKEN;
  if (!token) {
    // 没配 token 时匿名 GraphQL 会直接 401，不如早点说清楚，让前端安静降级到逐文件的老路。
    return res.status(503).json({ ok: false, error: 'GH_PROXY_TOKEN not configured' });
  }

  const ref = String(req.query.ref || 'main').replace(/[^A-Za-z0-9._\-/]/g, '') || 'main';

  const query = `
query Bundle($owner: String!, $repo: String!, $expr: String!) {
  rateLimit { cost remaining limit resetAt }
  repository(owner: $owner, name: $repo) {
    object(expression: $expr) {
      ... on Tree {
        entries {
          name
          type
          object {
            ... on Blob { byteSize text }
            ... on Tree {
              entries {
                name
                type
                object { ... on Blob { byteSize text } }
              }
            }
          }
        }
      }
    }
  }
}`;

  try {
    const r = await fetch('https://api.github.com/graphql', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + token,
        'Content-Type': 'application/json',
        'User-Agent': 'mentea-web-bundle'
      },
      body: JSON.stringify({
        query,
        variables: { owner: 'mentea555', repo: 'myfirstweb', expr: ref + ':content' }
      })
    });

    if (!r.ok) {
      const t = await r.text();
      return res.status(502).json({ ok: false, error: 'github ' + r.status, detail: t.slice(0, 300) });
    }

    const j = await r.json();
    if (j.errors) {
      return res.status(502).json({ ok: false, error: 'graphql', detail: JSON.stringify(j.errors).slice(0, 400) });
    }

    const rl = (j.data && j.data.rateLimit) || {};
    const tree = j.data && j.data.repository && j.data.repository.object;
    const entries = (tree && tree.entries) || [];

    const files = {};
    let total = 0;
    const keep = (p, text) => {
      if (typeof text !== 'string') return;
      if (!/\.(md|mdx|json)$/i.test(p)) return;   // 只带前端用得到的文本文件，图片之类走图床
      if (p.indexOf('..') >= 0) return;
      files[p] = text;
      total++;
    };

    for (const e of entries) {
      if (!e || !e.object) continue;
      if (e.type === 'blob') {
        keep('content/' + e.name, e.object.text);
      } else if (e.type === 'tree' && Array.isArray(e.object.entries)) {
        for (const s of e.object.entries) {
          if (s && s.type === 'blob' && s.object) keep('content/' + e.name + '/' + s.name, s.object.text);
        }
      }
    }

    // 透传配额点数（GraphQL 的额度在 body 里，不像 REST 那样在响应头）
    if (typeof rl.limit === 'number' && typeof rl.remaining === 'number') {
      res.setHeader('X-GitHub-Quota-Limit', String(rl.limit));
      res.setHeader('X-GitHub-Quota-Remaining', String(rl.remaining));
      res.setHeader('X-GitHub-Quota-Used', String(rl.limit - rl.remaining));
      res.setHeader('X-GitHub-Quota-Cost', String(rl.cost != null ? rl.cost : 1));
      if (rl.resetAt) res.setHeader('X-GitHub-Quota-Reset', String(rl.resetAt));
    }
    res.setHeader('X-Bundle-Files', String(total));

    // 与 /api/file 完全一致的时效承诺：改完 5 秒内全站生效
    res.setHeader('Cache-Control', 'public, s-maxage=5, stale-if-error=600');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.status(200).json({ ok: true, ref, count: total, files, fetchedAt: new Date().toISOString() });
  } catch (e) {
    return res.status(502).json({ ok: false, error: 'upstream ' + String(e.message || e) });
  }
}
