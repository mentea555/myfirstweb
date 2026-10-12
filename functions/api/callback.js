// OAuth 回调（Decap CMS 的 GitHub 登录第二步）
//
// 【移植说明】Vercel `handler(req,res)` 版 → Cloudflare Pages Functions 版。
//   `req.query.code` → `new URL(request.url).searchParams.get('code')`
//   `res.send(html)` → `new Response(html, { headers })`
//
// ★ 这里返回的是一次性 OAuth code 换来的 access_token，**绝对不能进任何缓存**。
//   原 Vercel 版没显式声明，靠 Vercel 对未声明缓存头的 POST/动态响应不缓存兜底；
//   这里显式加 no-store，避免被边缘缓存后令牌泄漏给第二个访客。

export async function onRequest(context) {
  const request = context.request;
  const env = context.env || {};

  const code = new URL(request.url).searchParams.get('code');
  const clientId = env.GITHUB_CLIENT_ID;
  const clientSecret = env.GITHUB_CLIENT_SECRET;

  try {
    const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json'
      },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        code
      })
    });
    const data = await tokenRes.json();

    const content = `
      <script>
        const receiveMessage = (message) => {
          window.opener.postMessage(
            'authorization:github:success:${JSON.stringify({
              token: data.access_token,
              provider: 'github'
            })}',
            message.origin
          );
          window.removeEventListener("message", receiveMessage, false);
        };
        window.addEventListener("message", receiveMessage, false);
        window.opener.postMessage("authorizing:github", "*");
      </script>
    `;

    return new Response(content, {
      status: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store, max-age=0'
      }
    });
  } catch (err) {
    return new Response(String(err.message || err), {
      status: 500,
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store, max-age=0'
      }
    });
  }
}
