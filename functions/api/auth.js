// OAuth 入口（Decap CMS 的 GitHub 登录跳转）
//
// 【移植说明】Vercel `handler(req,res)` 版 → Cloudflare Pages Functions 版。
//   `res.redirect(302, url)` → `Response.redirect(url, 302)`
//   `process.env.X` → `context.env.X`
//
// ★ 回调地址由「当前请求的 host」推导，所以换成 pages.dev 测试域名时也能正常登录，
//   绑上自定义域名后自动变成 https://menteaweb.com/api/callback，不用改代码。

export async function onRequest(context) {
  const request = context.request;
  const env = context.env || {};

  const clientId = env.GITHUB_CLIENT_ID;
  const redirectUri = `https://${new URL(request.url).host}/api/callback`;
  const authUrl = `https://github.com/login/oauth/authorize?client_id=${clientId}&scope=repo&redirect_uri=${encodeURIComponent(redirectUri)}`;

  return Response.redirect(authUrl, 302);
}
