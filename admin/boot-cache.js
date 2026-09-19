/*
 * boot-cache.js —— 后台「读请求」内存缓存（专治「每点一下都转圈」）
 * ============================================================
 * 背景（实测数据，见 .workbuddy/memory/TRAPS.md「后台加载提速」）：
 *   在真后台里逐个点集合卡片测过 —— 「前端页面设置」这个集合下有 5 个单文件
 *   （首页内容 / 全站基础设置 / 关于我页面 / 画廊页面 / 首页轮播图）。
 *   · 进列表页       → 不发请求（Decap 自己把 entries 缓存在 store 里了）
 *   · 点开任一张卡片 → ★ 每次都重新发 2 个请求（内容 + 媒体）
 *   · 再点一次同一张 → ★ 还是重新发 2 个请求
 *   本地代理只要 10 来毫秒看不出来，但线上走的是 api.github.com，
 *   每个请求 200~600ms ⇒ 就是主人看到的那个转圈「loading entry」。
 *
 * 为什么不能在 Decap 内部拦：
 *   Decap 每次导航都会无条件 dispatch loadEntry / loadEntries，
 *   没有「已加载过就跳过」的开关，也没有主题/插件接口能改它的 store。
 *   但它所有请求都走 window.fetch ⇒ 在这里包一层是最省事、最贴合的切入点。
 *
 * ⚠️⚠️ 缓存键必须区分两种后端（踩过一次，笔记列表直接变「No Entries」）：
 *   · 线上 github 后端：一个资源一个 URL ⇒ 用 URL 当键就够了。
 *   · 本地 decap-server：★ 只有一个 URL（/api/v1），所有动作都 POST 到它，
 *     真正区分「取列表 / 取单篇 / 取媒体」的是 body 里的 action。
 *     只按 URL 做键的话，requests 序列是先 info 再 entriesByFolder，
 *     后者会命中 info 的缓存 ⇒ Decap 把 {repo, publish_modes, type}
 *     当成 entries 解析 ⇒ 列表空掉。所以代理类请求的键必须带上 body。
 *
 * 三条安全线（防止缓存把内容搞脏）：
 *   1. 只缓存「读」：api.github.com 的 GET，以及本地代理 POST 里 action
 *      属于读动作的那些。
 *   2. 任何写请求（PUT/POST 写动作/DELETE/PATCH）一发出就**清空整个缓存**
 *      —— 发布完立刻读到的就是最新内容，不会出现「刚存完还显示旧的」。
 *   3. 缓存只在**内存**里，刷新页面即清空。遇到「怎么还是旧内容」，
 *      按一次 F5 就一定是干净的。
 *
 * 可调：
 *   window.__ADMIN_CACHE_TTL = 毫秒   （默认 5 分钟；设 0 表示不缓存）
 *   window.__adminCache      = 诊断对象（.size() / .keys() / .clear() / .stats）
 */
(function () {
  'use strict';

  var w = window;
  if (w.__adminCache) return;

  var orig = w.fetch;
  if (typeof orig !== 'function') return;

  var rawTtl = Number(w.__ADMIN_CACHE_TTL);
  var TTL = isFinite(rawTtl) && rawTtl >= 0 ? rawTtl : 5 * 60 * 1000;
  var MAX = 200;                 /* 最多记 200 条，防止长会话内存膨胀 */

  var store = new Map();
  var stats = { hit: 0, miss: 0, cleared: 0, stored: 0 };

  var PROXY_ACTION = /"action"\s*:\s*"([A-Za-z]+)"/;
  var READ_ACTION = /^(getEntry|entriesByFolder|entriesByFiles|entriesByCollection|getMedia|getAsset|getFiles|info|getDeployPreview)$/;

  function urlOf(input) {
    if (typeof input === 'string') return input;
    if (input && typeof input.url === 'string') return input.url;
    return '';
  }
  function initOf(input, init) {
    if (init && typeof init === 'object') return init;
    if (input && typeof input === 'object' && input !== null) return input;
    return {};
  }

  /*
   * 判定是不是「只读请求」，顺便告诉调用方键怎么拼：
   *   返回 'url'  → 用 URL 当键（github 后端）
   *   返回 'body' → 用 URL + body 当键（本地代理，同 URL 多动作）
   *   返回 null   → 不是读请求，不缓存
   */
  function readKind(url, method, body) {
    if (/api\.github\.com/i.test(url)) return method === 'GET' ? 'url' : null;
    if (/\/api\/v1(\/|$|\?)/i.test(url)) {
      if (method === 'GET') return 'url';
      if (method !== 'POST') return null;
      var m = PROXY_ACTION.exec(body);
      return m && READ_ACTION.test(m[1]) ? 'body' : null;
    }
    return null;
  }

  w.fetch = function (input, init) {
    var url = urlOf(input);
    var opt = initOf(input, init);
    var method = String(opt.method || 'GET').toUpperCase();
    var body = typeof opt.body === 'string' ? opt.body : '';

    /*
     * ⚠️ 一律用 orig.apply(w, …)，不要用 this ——
     * 本文件是 'use strict'，而调用方（Decap 打包后的代码）多半也是严格模式，
     * 裸调 fetch(...) 时 this 是 undefined ⇒ 原生 fetch 会抛
     * "Failed to execute 'fetch' on 'Window': Illegal invocation"。
     */
    var kind = TTL > 0 ? readKind(url, method, body) : null;

    if (!kind) {
      /* 写操作 → 整盘清空，保证下一次读拿到的是最新的 */
      if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS' && store.size) {
        store.clear();
        stats.cleared++;
      }
      return orig.apply(w, arguments);
    }

    var key = kind === 'body' ? url + '|' + body : url;

    var hit = store.get(key);
    if (hit) {
      if (Date.now() - hit.t < TTL) {
        stats.hit++;
        return Promise.resolve(hit.res.clone());
      }
      store.delete(key);
    }

    stats.miss++;
    return orig.apply(w, arguments).then(function (res) {
      if (res && res.ok) {
        try {
          if (store.size >= MAX) store.delete(store.keys().next().value);
          store.set(key, { t: Date.now(), res: res.clone() });
          stats.stored++;
        } catch (e) { /* clone 失败就算了，不能影响正常请求 */ }
      }
      return res;
    });
  };

  w.__adminCache = {
    ttl: TTL,
    stats: stats,
    size: function () { return store.size; },
    keys: function () { return Array.from(store.keys()); },
    clear: function () { store.clear(); }
  };
})();
