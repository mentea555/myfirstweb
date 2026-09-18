/**
 * 验证：新增的 /api/contents + /api/file 代理被前端正确调用，
 *       且四路降级链路（代理 → GitHub API → jsDelivr → 缓存）在代理挂掉时仍能兜底。
 *
 * 用法：node tools/verify-proxy-routes.js
 */
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9414;
const CDP_PORT = 9415;
const ROOT = 'C:/Users/nanaq/WorkBuddy/2026-09-16-21-56-39/repo';
const OUT = 'C:/Users/nanaq/WorkBuddy/2026-09-16-21-56-39/shots';
fs.mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.css': 'text/css; charset=utf-8' };

function ghApi(apiPath, query) {
  return new Promise((resolve, reject) => {
    const q = Object.entries(query || {}).map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v)).join('&');
    const req = https.request({
      host: 'api.github.com', method: 'GET',
      path: '/repos/mentea555/myfirstweb/' + apiPath + (q ? '?' + q : ''),
      headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/vnd.github+json' }
    }, (r) => {
      let body = '';
      r.on('data', (c) => body += c);
      r.on('end', () => resolve({ status: r.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

let proxyMode = 'ok';

function startServer() {
  return new Promise((res) => {
    const srv = http.createServer((req, resp) => {
      const u = new URL(req.url, 'http://127.0.0.1:' + PORT);
      if (u.pathname === '/api/contents') {
        if (proxyMode === 'down') return json(resp, 503, { error: 'simulated proxy down' });
        const dir = u.searchParams.get('path') || '';
        return ghApi('contents/' + dir, { ref: 'main' }).then(({ status, body }) => {
          resp.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=30' });
          resp.end(body);
        }).catch((e) => json(resp, 502, { error: e.message }));
      }
      if (u.pathname === '/api/file') {
        if (proxyMode === 'down') return text(resp, 503, 'simulated proxy down');
        const p = u.searchParams.get('path') || '';
        return ghApi('contents/' + p, { ref: 'main' }).then(({ status, body }) => {
          if (status !== 200) { resp.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); return resp.end(body); }
          const j = JSON.parse(body);
          if (!j || !j.content) return text(resp, 404, 'no content');
          text(resp, 200, Buffer.from(j.content, 'base64').toString('utf-8'));
        }).catch((e) => text(resp, 502, e.message));
      }
      fs.readFile(path.join(ROOT, u.pathname), (err, buf) => {
        if (err) { resp.writeHead(404); return resp.end('not found'); }
        const ext = path.extname(u.pathname);
        resp.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
        resp.end(buf);
      });
    });
    srv.listen(PORT, '127.0.0.1', () => res(srv));
  });
}
function json(r, code, obj) { r.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' }); r.end(JSON.stringify(obj)); }
function text(r, code, txt) { r.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8', 'Access-Control-Allow-Origin': '*' }); r.end(txt); }

function cdpGet(port, p) {
  return new Promise((res, rej) => {
    http.get('http://127.0.0.1:' + port + p, (r) => {
      let body = ''; r.on('data', (c) => body += c); r.on('end', () => { try { res(JSON.parse(body)); } catch (e) { rej(e); } });
    }).on('error', rej);
  });
}

(async () => {
  let pass = 0, fail = 0;
  const t = (name, ok, hint) => { if (ok) { pass++; console.log('PASS  ' + name + (hint ? '  (' + hint + ')' : '')); } else { fail++; console.log('FAIL  ' + name + (hint ? '  (' + hint + ')' : '')); } };

  const server = await startServer();
  console.log('Server up on 127.0.0.1:' + PORT);
  const udd = 'C:\\Users\\nanaq\\AppData\\Local\\Temp\\cdp-proxy-' + Date.now();
  console.log('[debug] CDP_PORT =', CDP_PORT, 'udd =', udd);
  const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=' + CDP_PORT, '--user-data-dir=' + udd,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
  chrome.on('error', (e) => console.error('[chrome spawn error]', e));
  chrome.on('exit', (c, sig) => console.error('[chrome exit]', c, sig));
  await sleep(2600);
  console.log('[debug] cdpGet on port', CDP_PORT);
  let tg; for (let i = 0; i < 30; i++) { try { tg = await cdpGet(CDP_PORT, '/json/list'); break; } catch (e) { if (i % 5 === 0) console.error('[cdpGet retry]', i, e.message); await sleep(400); } }
  if (!tg) { console.error('Chrome 启动失败'); chrome.kill(); server.close(); process.exit(2); }
  const sock = new WebSocket(tg.find((t) => t.type === 'page').webSocketDebuggerUrl);
  let idc = 0; const pend = new Map();
  await new Promise((r) => sock.on('open', r));
  const send = (m, p) => new Promise((res) => { const id = ++idc; pend.set(id, res); sock.send(JSON.stringify({ id, method: m, params: p || {} })); });
  sock.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
  });
  await send('Page.enable');

  /* ===== Case A: 代理正常 ===== */
  console.log('\n========== Case A: 代理正常 ==========');
  proxyMode = 'ok';
  await send('Page.navigate', { url: 'http://127.0.0.1:' + PORT + '/gallery/index.html' });
  await sleep(11000);
  const A = await evalJS(send, `(() => {
    const tiles = Array.from(document.querySelectorAll('.tile'));
    const errBox = document.querySelector('.status-box');
    return {
      tiles: tiles.length,
      err: errBox && errBox.textContent.includes('加载失败')
    };
  })()`);
  t('A1. 代理正常时画廊渲染至少 11 张卡片', A.tiles >= 11, 'tiles=' + A.tiles + ', err=' + A.err);
  await shot(send, 'gallery-proxy-A.png');

  /* ===== Case B: 代理挂掉 ===== */
  console.log('\n========== Case B: 代理挂掉（应降级到 GitHub API） ==========');
  proxyMode = 'down';
  const reqLog = [];
  sock.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.method === 'Network.requestWillBeSent') reqLog.push(m.params.request.url);
  });
  await send('Network.enable');
  await send('Page.navigate', { url: 'http://127.0.0.1:' + PORT + '/gallery/index.html?bust=' + Date.now() });
  await sleep(13000);
  const B = await evalJS(send, `(() => {
    const tiles = Array.from(document.querySelectorAll('.tile'));
    const errBox = document.querySelector('.status-box');
    return {
      tiles: tiles.length,
      err: errBox && errBox.textContent.includes('加载失败')
    };
  })()`);
  t('B1. 代理挂掉后仍能渲染（靠 GitHub API 兜底）', B.tiles >= 3 && !B.err, 'tiles=' + B.tiles + ', err=' + B.err);
  const hitProxy = reqLog.some((u) => u.indexOf('/api/contents') >= 0 || u.indexOf('/api/file') >= 0);
  const hitGithub = reqLog.some((u) => u.indexOf('api.github.com') >= 0);
  t('B2. 前端确实尝试了 /api/*', hitProxy, '');
  t('B3. /api/* 失败后切换到 api.github.com 或 jsDelivr', hitGithub || reqLog.some((u) => u.indexOf('data.jsdelivr.com') >= 0), '');
  await shot(send, 'gallery-proxy-B.png');

  sock.close(); chrome.kill(); server.close();
  console.log('\n========== 汇总 ==========');
  console.log('PASS: ' + pass + ' / FAIL: ' + fail);
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(2); });

async function evalJS(send, expr) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
  if (r.exceptionDetails) {
    console.log('[evalJS exception]', JSON.stringify(r.exceptionDetails).slice(0, 600));
    throw new Error('JS 异常');
  }
  // CDP 协议：send() 已经把外层 result 拆掉，r.result.result 才是 Runtime.evaluate 的真返回
  const inner = (r.result && r.result.result) || r.result;
  const v = inner && inner.value;
  if (v && typeof v === 'object' && v.type === 'object' && 'value' in v) return v.value;
  return v;
}
async function shot(send, name) {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  const inner = (r.result && r.result.result) || r.result;
  const data = inner && inner.data;
  if (!data) { console.log('[shot empty]', JSON.stringify(r).slice(0, 300)); return; }
  fs.writeFileSync(path.join(OUT, name), Buffer.from(data, 'base64'));
}