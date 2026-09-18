// 单文件代理：前端走本站代理 → GitHub Contents API（带 PAT，5000/h）
// 自动把 GitHub 返回的 base64 内容解码成 UTF-8 文本，省去前端再 decode。
//
// 用法：GET /api/file?path=content/notes/2026-09-18-xxx.md[&ref=main]
// 返回：纯文本（Content-Type: text/plain; charset=utf-8）
//
// 与 /api/contents 的差别：本端点保证返回「文件内容」（文本），而不是 JSON 元数据。
//
// 安全约束同 /api/contents。
export default async function handler(req, res) {
  const raw = String(req.query.path || '').replace(/^\/+|\/+$/g, '');
  if (!raw) return res.status(400).send('missing path');
  if (raw.indexOf('..') >= 0 || raw.indexOf('//') >= 0) return res.status(400).send('invalid path');
  if (!/^[A-Za-z0-9._\-/%\u4e00-\u9fff]+$/.test(raw)) return res.status(400).send('invalid path');
  const ref = String(req.query.ref || 'main').replace(/[^A-Za-z0-9._\-/]/g, '');

  const headers = {
    'User-Agent': 'mentea-web-proxy',
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28'
  };
  const token = process.env.GH_PROXY_TOKEN;
  if (token) headers.Authorization = 'Bearer ' + token;

  const pathEnc = raw.split('/').map(encodeURIComponent).join('/');

  try {
    const url = `https://api.github.com/repos/mentea555/myfirstweb/contents/${pathEnc}?ref=${ref}`;
    const r = await fetch(url, { headers });
    // ★ 透传 GitHub 亲手返回的配额头（就是「查配额响应头」要看的那些）
    //   直连本端点时可见；若带了 &t= 走 MISS，就是这一秒的真实值。
    //   X-GitHub-Quota-Limit / -Remaining / -Used / -Reset
    for (const k of ['Limit', 'Remaining', 'Used', 'Reset']) {
      const v = r.headers.get('x-ratelimit-' + k.toLowerCase());
      if (v) res.setHeader('X-GitHub-Quota-' + k, v);
    }
    if (!r.ok) {
      const t = await r.text();
      return res.status(r.status).setHeader('Content-Type', 'text/plain; charset=utf-8').send(t);
    }
    const j = await r.json();
    if (!j || !j.content || j.encoding !== 'base64') {
      return res.status(404).send('file content not available');
    }
    // base64 → utf-8（Node Buffer 自动按字节解）
    const buf = Buffer.from(j.content, 'base64');
    // 简单 mojibake 自愈（双保险，前端还有一层 repairMojibake）
    let text = buf.toString('utf-8');
    if (/[\u00C0-\u00FF][\u00C0-\u00FF]/.test(text) && /[\u4E00-\u9FFF]/.test(text) === false) {
      try {
        const bytes = Uint8Array.from(text, (c) => c.charCodeAt(0));
        const fixed = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        if ((fixed.match(/[\u4E00-\u9FFF]/g) || []).length > 0) text = fixed;
      } catch (_) {}
    }
    // ★ 缓存策略（省 GitHub 配额的关键）：
    //   s-maxage=120  → Vercel CDN 缓存 120 秒。同一篇文章 2 分钟内被多少人看，
    //                   GitHub 那边只算 1 次。
    //   stale-while-revalidate=600 → 缓存过期后继续发旧的（访客秒开），
    //                   同时在后台悄悄拉新的，访客永远不用等。
    //   不设 max-age：访客浏览器不缓存，主人在后台改完 2 分钟内即可全站生效。
    res.setHeader('Cache-Control', 'public, s-maxage=120, stale-while-revalidate=600');
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.status(200).send(text);
  } catch (e) {
    res.status(502).send('upstream ' + String(e.message || e));
  }
}