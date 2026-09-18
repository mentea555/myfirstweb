// 列目录代理：前端走本站代理 → GitHub Contents API（带 PAT，5000/h）
// 不带 token 时自动降级到未认证请求（60/h，但前端会有 jsDelivr 兜底）。
//
// 用法：GET /api/contents?path=content/notes[&ref=main]
// 返回：原样转发 GitHub Contents API JSON（数组 = 目录，单对象 = 文件）
//
// 安全：
//   - path 仅允许「字母数字 / . _ - / % xx 中文编码 + 中文 Unicode」与 /
//   - 不允许 ..  /  //  / 以 / 开头（防止越权读到仓库外的资源）
//   - token 仅在 Vercel 环境变量里，仓库里没有，也不会泄露到前端
export default async function handler(req, res) {
  const raw = String(req.query.path || '').replace(/^\/+|\/+$/g, '');
  if (!raw) return res.status(400).json({ error: 'missing path' });
  if (raw.indexOf('..') >= 0 || raw.indexOf('//') >= 0) return res.status(400).json({ error: 'invalid path' });
  if (!/^[A-Za-z0-9._\-/%\u4e00-\u9fff]+$/.test(raw)) return res.status(400).json({ error: 'invalid path' });
  const ref = String(req.query.ref || 'main').replace(/[^A-Za-z0-9._\-/]/g, '');

  const headers = {
    'User-Agent': 'mentea-web-proxy',
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28'
  };
  const token = process.env.GH_PROXY_TOKEN;
  if (token) headers.Authorization = 'Bearer ' + token;

  // 路径里有中文：按段 encode，保留 /
  const pathEnc = raw.split('/').map(encodeURIComponent).join('/');

  try {
    const url = `https://api.github.com/repos/mentea555/myfirstweb/contents/${pathEnc}?ref=${ref}`;
    const r = await fetch(url, { headers });
    const text = await r.text();
    // 让浏览器/CDN 短暂缓存 30s，主人刷新不会把配额打爆
    res.setHeader('Cache-Control', 'public, max-age=30, s-maxage=30');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    // CORS：自家站点不严格，但给个 * 方便调试
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.status(r.status).send(text);
  } catch (e) {
    res.status(502).json({ error: 'upstream ' + String(e.message || e) });
  }
}