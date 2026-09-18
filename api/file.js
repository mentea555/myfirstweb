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
  if (!/^[A-Za-z0-9._\-/%]+$/.test(raw)) return res.status(400).send('invalid path');
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
    res.setHeader('Cache-Control', 'public, max-age=120, s-maxage=120');
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.status(200).send(text);
  } catch (e) {
    res.status(502).send('upstream ' + String(e.message || e));
  }
}