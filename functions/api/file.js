// 单文件代理：前端走本站代理 → GitHub Contents API（带 PAT，5000/h）
// 自动把 GitHub 返回的 base64 内容解码成 UTF-8 文本，省去前端再 decode。
//
// 【移植说明】Vercel `handler(req,res)` 版 → Cloudflare Pages Functions 版。
//   ★ 唯一的运行时差异：Vercel 用 Node 的 `Buffer.from(x,'base64')` 解码，
//     Workers 运行时没有 Buffer（除非开 nodejs_compat），改用 atob + TextDecoder。
//     这是全站唯一一处 Node 专有代码。
//
// 用法：GET /api/file?path=content/notes/2026-09-18-xxx.md[&ref=main]
// 返回：纯文本（Content-Type: text/plain; charset=utf-8）
//
// 与 /api/contents 的差别：本端点保证返回「文件内容」（文本），而不是 JSON 元数据。
//
// 安全约束同 /api/contents。

function text(body, status, extra) {
  return new Response(body, {
    status: status || 200,
    headers: Object.assign({ 'Content-Type': 'text/plain; charset=utf-8' }, extra || {})
  });
}

// base64 → UTF-8 文本。等价于 Node 的 Buffer.from(b64,'base64').toString('utf-8')。
// atob 按规范会先剔除空白字符（GitHub 返回的 base64 带换行，这里不用额外处理）。
function b64ToText(b64) {
  const bin = atob(String(b64).replace(/\s+/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder('utf-8').decode(bytes);
}

export async function onRequest(context) {
  const request = context.request;
  const env = context.env || {};
  const q = new URL(request.url).searchParams;

  const raw = String(q.get('path') || '').replace(/^\/+|\/+$/g, '');
  if (!raw) return text('missing path', 400);
  if (raw.indexOf('..') >= 0 || raw.indexOf('//') >= 0) return text('invalid path', 400);
  if (!/^[A-Za-z0-9._\-/%\u4e00-\u9fff]+$/.test(raw)) return text('invalid path', 400);
  const ref = String(q.get('ref') || 'main').replace(/[^A-Za-z0-9._\-/]/g, '');

  const headers = {
    'User-Agent': 'mentea-web-proxy',
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28'
  };
  const token = env.GH_PROXY_TOKEN;
  if (token) headers.Authorization = 'Bearer ' + token;

  const pathEnc = raw.split('/').map(encodeURIComponent).join('/');

  try {
    const url = `https://api.github.com/repos/mentea555/myfirstweb/contents/${pathEnc}?ref=${ref}`;
    const r = await fetch(url, { headers });

    const outHeaders = {};

    // ★ 透传 GitHub 亲手返回的配额头（就是「查配额响应头」要看的那些）
    //   直连本端点时可见；若带了 &t= 走 MISS，就是这一秒的真实值。
    //   X-GitHub-Quota-Limit / -Remaining / -Used / -Reset
    for (const k of ['Limit', 'Remaining', 'Used', 'Reset']) {
      const v = r.headers.get('x-ratelimit-' + k.toLowerCase());
      if (v) outHeaders['X-GitHub-Quota-' + k] = v;
    }
    if (!r.ok) {
      const t = await r.text();
      return text(t, r.status, outHeaders);
    }
    const j = await r.json();
    if (!j || !j.content || j.encoding !== 'base64') {
      return text('file content not available', 404, outHeaders);
    }

    let txt = b64ToText(j.content);

    // 简单 mojibake 自愈（双保险，前端还有一层 repairMojibake）
    if (/[\u00C0-\u00FF][\u00C0-\u00FF]/.test(txt) && /[\u4E00-\u9FFF]/.test(txt) === false) {
      try {
        const bytes = Uint8Array.from(txt, (c) => c.charCodeAt(0));
        const fixed = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        if ((fixed.match(/[\u4E00-\u9FFF]/g) || []).length > 0) txt = fixed;
      } catch (_) {}
    }

    // ★ 缓存策略（主人 2026-09-18 定：改完正文要「几秒内」全站生效）：
    //   s-maxage=5 → 边缘 CDN 只缓存 5 秒。主人后台一发布，5 秒后任何人刷新都是新内容。
    //   故意不设 max-age：访客浏览器不缓存，也就不会自己留旧副本。
    //   故意不设 stale-while-revalidate：那会让「过期后第一个访客」先拿到旧内容
    //     （先发旧的、后台再悄悄拉新的），主人自己刷新就会遇到「怎么还是老的」——要不得。
    //   stale-if-error=600 → GitHub 万一抽风，10 分钟内还能拿旧内容顶着。
    outHeaders['Cache-Control'] = 'public, s-maxage=5, stale-if-error=600';
    outHeaders['Access-Control-Allow-Origin'] = '*';

    return text(txt, 200, outHeaders);
  } catch (e) {
    return text('upstream ' + String(e.message || e), 502);
  }
}
