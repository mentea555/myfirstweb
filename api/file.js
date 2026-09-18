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
    // ★ 缓存策略（主人 2026-09-18 定：改完正文要「几秒内」全站生效）：
    //   s-maxage=5 → Vercel CDN 只缓存 5 秒。主人后台一发布，5 秒后任何人刷新都是新内容。
    //   故意不设 max-age：访客浏览器不缓存，也就不会自己留旧副本。
    //   故意不设 stale-while-revalidate：那会让「过期后第一个访客」先拿到旧内容
    //     （先发旧的、后台再悄悄拉新的），主人自己刷新就会遇到「怎么还是老的」——要不得。
    //   代价：TTL 从 120s 降到 5s 后，同一篇文章的回源次数约为原来的 24 倍。
    //     本站日常访客不多，实测一次刷新约 20 次请求、账号额度 5000/h，绰绰有余。
    //     想随时看剩余额度：GET /api/quota（或看响应头 X-GitHub-Quota-*）。
    //   stale-if-error=600 → GitHub 万一抽风，10 分钟内还能拿旧内容顶着（不支持则被忽略）。
    res.setHeader('Cache-Control', 'public, s-maxage=5, stale-if-error=600');
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.status(200).send(text);
  } catch (e) {
    res.status(502).send('upstream ' + String(e.message || e));
  }
}