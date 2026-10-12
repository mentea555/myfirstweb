// 列目录代理：前端走本站代理 → GitHub Contents API（带 PAT，5000/h）
// 不带 token 时自动降级到未认证请求（60/h，但前端会有兜底）。
//
// 【移植说明】Vercel `handler(req,res)` 版 → Cloudflare Pages Functions 版。
//   逻辑一致，仅入口签名与响应构造方式不同。
//
// 用法：GET /api/contents?path=content/notes[&ref=main]
// 返回：原样转发 GitHub Contents API JSON（数组 = 目录，单对象 = 文件）
//
// 安全：
//   - path 仅允许「字母数字 / . _ - / % xx 中文编码 + 中文 Unicode」与 /
//   - 不允许 ..  /  //  / 以 / 开头（防止越权读到仓库外的资源）
//   - token 仅在环境变量里，仓库里没有，也不会泄露到前端

function text(body, status, extra) {
  return new Response(body, {
    status: status || 200,
    headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, extra || {})
  });
}

export async function onRequest(context) {
  const request = context.request;
  const env = context.env || {};
  const q = new URL(request.url).searchParams;

  const raw = String(q.get('path') || '').replace(/^\/+|\/+$/g, '');
  if (!raw) return text(JSON.stringify({ error: 'missing path' }), 400);
  if (raw.indexOf('..') >= 0 || raw.indexOf('//') >= 0) return text(JSON.stringify({ error: 'invalid path' }), 400);
  if (!/^[A-Za-z0-9._\-/%\u4e00-\u9fff]+$/.test(raw)) return text(JSON.stringify({ error: 'invalid path' }), 400);
  const ref = String(q.get('ref') || 'main').replace(/[^A-Za-z0-9._\-/]/g, '');

  const headers = {
    'User-Agent': 'mentea-web-proxy',
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28'
  };
  const token = env.GH_PROXY_TOKEN;
  if (token) headers.Authorization = 'Bearer ' + token;

  // 路径里有中文：按段 encode，保留 /
  const pathEnc = raw.split('/').map(encodeURIComponent).join('/');

  try {
    const url = `https://api.github.com/repos/mentea555/myfirstweb/contents/${pathEnc}?ref=${ref}`;
    const r = await fetch(url, { headers });
    const body = await r.text();

    const outHeaders = {};

    // ★ 透传 GitHub 亲手返回的配额头（X-GitHub-Quota-Limit / -Remaining / -Used / -Reset）
    for (const k of ['Limit', 'Remaining', 'Used', 'Reset']) {
      const v = r.headers.get('x-ratelimit-' + k.toLowerCase());
      if (v) outHeaders['X-GitHub-Quota-' + k] = v;
    }
    // 让浏览器/边缘缓存 30s，主人刷新不会把配额打爆
    outHeaders['Cache-Control'] = 'public, max-age=30, s-maxage=30';
    // CORS：自家站点不严格，但给个 * 方便调试
    outHeaders['Access-Control-Allow-Origin'] = '*';

    return text(body, r.status, outHeaders);
  } catch (e) {
    return text(JSON.stringify({ error: 'upstream ' + String(e.message || e) }), 502);
  }
}
