/**
 * 轮播图「槽位」增强（不是自定义 widget，是给内置 boolean 开关加外挂）
 * ============================================================
 * 加载方式：/admin/index.html 的 loadPlugins 里，CMS.init() 之前。
 *
 * 【为什么不用自定义 widget？】
 *   第一版写的是自定义 widget（widget: carousel_slot），逻辑都对，但实测发现
 *   **Decap 传给自定义控件的 value 是 `undefined`**，`props.onChange(true)` 调用了、
 *   不报错、组件也重渲染了，值就是写不回 entry（window.__csDebug 里看得一清二楚）。
 *   与其赌版本差异，不如走**内置 boolean** —— 值怎么存和主人现在用的完全一样，
 *   我们只在外层做「显示占用 + 满员拦截」，一行都不碰 Decap 的存值机制。
 *
 * 【为什么要做这件事】
 *   前端首页的规则（index.html 的 buildCarouselSlides）是：
 *     勾了 carousel 的每一篇 → 把**每一张图**（封面 + 正文插图）都摊成一张卡
 *     → 最后 slice(0, slide_limit) 截断
 *   也就是 **后台开关是「笔记级」的，前端坑位是「图片级」的**。
 *   勾一篇带 10 张插图的笔记，8 个位置当场被它一篇吃完，后面勾的连一张都进不去 ——
 *   主人看到的「根本不知道哪一张是哪一篇」就是这么来的。
 *
 * 【这个增强做了什么】
 *   · 开关右边显示占用：`轮播 5/8`
 *   · 下面按**前端真实顺序**列出「哪些进去了、各占第几张、各几张图」
 *   · 告诉主人本篇有图几张、能排到第几位、会不会被上限挤掉
 *   · ★ 位置已满时点开关 → **拦下**（捕获阶段掐掉这次点击）并弹出提示，
 *        要求先关掉上面某一篇
 *   · ★ 本篇一张图都没有时提醒（勾了也不会出现，最容易白忙的一种）
 *
 * 【★ 必须先搞清楚：Decap 的 boolean 字段不是 checkbox】
 *   它在 DOM 里是 `<button role="switch" aria-checked="true|false">`
 *   （打包文件里只有一处 `role:"switch"`，组件 = StyledToggle
 *     + ToggleBackground(BooleanBackground) + ToggleHandle）。
 *   所以：找开关不能找 `input[type=checkbox]`（页面上**根本没有**），
 *         读值也不能读 `input.checked`，只能读 `aria-checked`；
 *         而且它**没有 change 事件**，一切都得挂在 click 上。
 */

(function () {
  'use strict';

  var HARD_MAX = 20;                 // 与前端 CAROUSEL_HARD_MAX 一致
  var DEFAULT_LIMIT = 8;             // 与前端 slide_limit 默认值一致
  var NOTES_PREFIX = 'content/notes/';
  var FIELD_LABEL = '加入首页轮播图';
  var INDEX_TTL_MS = 10000;          // 同一批操作里别反复拉（每次拉 = 1 点 GitHub 配额）

  /* ============================================================
     一、工具
     ============================================================ */

  /** 极简 frontmatter 解析：只取我们关心的几个键 */
  function parseFrontmatter(raw) {
    var text = String(raw || '');
    var m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
    if (!m) return { data: {}, body: text };
    var data = {};
    m[1].split(/\r?\n/).forEach(function (line) {
      if (/^\s*#/.test(line) || !line.trim()) return;
      var i = line.indexOf(':');
      if (i < 0) return;
      var k = line.slice(0, i).trim();
      if (!k || /[\s\[\{]/.test(k)) return;
      var v = line.slice(i + 1).trim();
      if (/^".*"$/.test(v) || /^'.*'$/.test(v)) v = v.slice(1, -1);
      if (v === 'true' || v === 'True') data[k] = true;
      else if (v === 'false' || v === 'False') data[k] = false;
      else data[k] = v;
    });
    return { data: data, body: text.slice(m[0].length) };
  }

  /**
   * 收集一篇笔记会贡献的图 —— **必须与前端 collectPostImages 同规则**，
   * 否则后台算出来的位数跟首页对不上，等于白做。
   */
  function collectImages(cover, body) {
    var out = [];
    function push(u) {
      var s = String(u == null ? '' : u).trim();
      if (!s) return;
      if (/^(javascript|data|vbscript):/i.test(s)) return;
      if (out.indexOf(s) !== -1) return;
      out.push(s);
    }
    push(cover);
    var re = /!\[[^\]]*\]\(\s*(<[^>\s]+>|[^)\s]+)/g;
    var b = String(body || '');
    var m;
    while ((m = re.exec(b))) push(String(m[1]).replace(/^<|>$/g, ''));
    return out;
  }

  function normalizePath(p) {
    var s = String(p || '').replace(/^\/+/, '');
    if (!s) return '';
    if (s.indexOf('content/') === 0) return s;
    return NOTES_PREFIX + s.replace(/^.*\//, '');
  }

  /* ============================================================
     二、全站索引
     ============================================================ */

  var S = {
    promise: null,
    fetchedAt: 0,
    ready: false,
    error: '',
    limit: DEFAULT_LIMIT,
    posts: [],
    inputRef: null,      // 上一次找到的那个开关按钮，留着复用（见 findSwitch）
    hit: '',             // 它是用哪一招找到的，只给验证脚本看
    switchCount: 0,      // 页面上 role="switch" 的个数，排查用
    listeners: []
  };

  function notify() {
    S.listeners.slice().forEach(function (fn) {
      try { fn(); } catch (e) {}
    });
  }

  function matchPost(p) {
    var list = S.posts || [];
    if (!p) return '';
    var i;
    for (i = 0; i < list.length; i++) if (list[i].path === p) return list[i].path;
    if (!/\.mdx?$/i.test(p)) {
      for (i = 0; i < list.length; i++) {
        if (list[i].path === p + '.md' || list[i].path === p + '.mdx') return list[i].path;
      }
    }
    var base = p.split('/').pop().replace(/\.mdx?$/i, '');
    for (i = 0; i < list.length; i++) {
      if (list[i].path.split('/').pop().replace(/\.mdx?$/i, '') === base) return list[i].path;
    }
    return '';
  }

  function buildIndex(files) {
    var cfg = {};
    try { cfg = JSON.parse(files['content/carousel.json'] || '{}'); } catch (e) { cfg = {}; }
    var n = Number(cfg.slide_limit);
    /* 与前端 buildCarouselSlides 的 `Math.max(1, Math.min(20, num(cfg.slide_limit, 8) || 8))` 对齐；
       非正数 / 非数字一律当默认 8（那边 `|| 8` 也是这个效果）。
       取 floor 是因为前端最后是 `slides.slice(0, limit)`，2.7 张 = 2 张。 */
    S.limit = Math.max(1, Math.min(HARD_MAX, isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_LIMIT));

    var posts = [];
    Object.keys(files).forEach(function (p) {
      if (p.indexOf(NOTES_PREFIX) !== 0 || !/\.mdx?$/i.test(p)) return;
      var fm = parseFrontmatter(files[p]);
      var d = fm.data || {};
      if (d.draft === true) return;
      posts.push({
        path: p,
        title: String(d.title || p.slice(NOTES_PREFIX.length)),
        date: String(d.date || ''),
        featured: d.featured === true,
        carousel: d.carousel === true,
        images: collectImages(d.thumbnail, fm.body)
      });
    });
    posts.sort(function (a, b) {
      if (a.featured !== b.featured) return a.featured ? -1 : 1;
      return new Date(b.date || 0) - new Date(a.date || 0);
    });
    S.posts = posts;
    S.ready = true;
    S.error = '';
  }

  function loadIndex(force) {
    var fresh = S.ready && Date.now() - S.fetchedAt < INDEX_TTL_MS;
    if (fresh && !force) return S.promise || Promise.resolve(S);
    if (S.promise && !force) return S.promise;

    S.fetchedAt = Date.now();
    S.promise = fetch('/api/bundle', { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)); })
      .then(function (j) {
        if (!j || j.ok !== true || !j.files) throw new Error('返回格式异常');
        buildIndex(j.files);
        notify();
        return S;
      })
      .catch(function (e) {
        S.error = String((e && e.message) || e);
        S.ready = false;
        notify();
        return S;
      });
    return S.promise;
  }

  /**
   * 按前端的截断规则算槽位。
   * @param {string} extraPath 把这一篇也当成「已勾」来试算
   */
  function computeLayout(extraPath) {
    var limit = S.limit;
    var slot = 0;
    var entries = [];
    (S.posts || []).forEach(function (p) {
      var on = p.carousel || (!!extraPath && p.path === extraPath);
      if (!on) return;
      var before = slot;
      var count = 0;
      p.images.forEach(function () {
        slot++;
        if (slot <= limit) count++;
      });
      entries.push({
        path: p.path, title: p.title, total: p.images.length,
        from: before + 1, count: count, cut: p.images.length - count
      });
    });
    var used = Math.min(slot, limit);
    return {
      limit: limit, used: used, slotRaw: slot,
      overflow: Math.max(0, slot - limit),
      entries: entries, full: used >= limit
    };
  }

  /* ============================================================
     三、提示浮层
     ============================================================ */

  function toast(title, lines, kind) {
    var old = document.getElementById('cs-toast');
    if (old && old.parentNode) old.parentNode.removeChild(old);

    var box = document.createElement('div');
    box.id = 'cs-toast';
    box.className = 'cs-toast cs-toast-' + (kind || 'warn');
    var hd = document.createElement('div');
    hd.className = 'cs-toast-title';
    hd.textContent = title;
    box.appendChild(hd);
    (lines || []).forEach(function (t) {
      var p = document.createElement('div');
      p.className = 'cs-toast-line';
      p.textContent = t;
      box.appendChild(p);
    });
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'cs-toast-ok';
    btn.textContent = '知道了';
    btn.onclick = function () { if (box.parentNode) box.parentNode.removeChild(box); };
    box.appendChild(btn);
    document.body.appendChild(box);
    setTimeout(function () { if (box.parentNode) box.parentNode.removeChild(box); }, 9000);
  }

  /* ============================================================
     四、样式
     ============================================================ */

  var STYLE_ID = 'cs-style';
  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var s = document.createElement('style');
    s.id = STYLE_ID;
    s.textContent = [
      '.cs-panel{flex:0 0 100%;width:100%;box-sizing:border-box;margin-top:2px}',
      '.cs-badge{display:inline-block;font-size:12px;font-weight:600;padding:3px 9px;border-radius:999px;',
      '  background:#eef0f7;color:#4a5069;white-space:nowrap;vertical-align:middle}',
      '.cs-badge.full{background:#fdecec;color:#c0392b}',
      '.cs-badge.muted{background:#f3f4f8;color:#8a90a6;font-weight:500}',
      '.cs-detail{margin-top:9px;font-size:12.5px;line-height:1.85;color:#5b6178}',
      '.cs-list{margin:2px 0 0;padding:0;list-style:none}',
      '.cs-list li{display:flex;gap:8px;align-items:baseline;padding:1px 0}',
      '.cs-slot{flex:0 0 auto;font-variant-numeric:tabular-nums;color:#8a90a6;font-size:11.5px;min-width:66px}',
      '.cs-name{flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#2b2f45}',
      '.cs-list li.cs-here .cs-name{font-weight:700;color:#3d43c4}',
      '.cs-list li.cs-here .cs-slot{color:#3d43c4}',
      '.cs-n{flex:0 0 auto;color:#8a90a6;font-size:11.5px}',
      '.cs-warn{margin-top:7px;padding:7px 10px;border-radius:8px;background:#fdf3e7;color:#9a5b12;font-size:12.5px;line-height:1.7}',
      '.cs-note{margin-top:6px;color:#8a90a6;font-size:12px;line-height:1.7}',
      '.cs-err{padding:7px 10px;border-radius:8px;background:#f3f4f8;color:#8a90a6;font-size:12.5px}',
      '.cs-refresh{margin-top:6px;border:0;background:none;color:#6366f1;font-size:12px;cursor:pointer;padding:2px 0}',
      '.cs-refresh:hover{text-decoration:underline}',
      '.cs-blocked-hint{margin-top:7px;padding:7px 10px;border-radius:8px;background:#fdecec;color:#c0392b;font-size:12.5px;line-height:1.7}',
      '.cs-toast{position:fixed;z-index:100000;right:24px;bottom:24px;max-width:min(430px,calc(100vw - 48px));',
      '  background:#fff;border-radius:12px;padding:15px 17px 13px;box-shadow:0 10px 34px rgba(20,24,45,.18);',
      '  border:1px solid #e6e8f2;font-size:13px;line-height:1.8;color:#2b2f45}',
      '.cs-toast-title{font-weight:700;font-size:13.5px;margin-bottom:6px}',
      '.cs-toast-warn .cs-toast-title{color:#c0392b}',
      '.cs-toast-info .cs-toast-title{color:#4a5069}',
      '.cs-toast-line{color:#5b6178}',
      '.cs-toast-ok{margin-top:11px;border:0;border-radius:8px;background:#6366f1;color:#fff;font-size:12.5px;',
      '  font-weight:600;padding:7px 15px;cursor:pointer}',
      '.cs-toast-ok:hover{filter:brightness(.95)}',
    ].join('\n');
    document.head.appendChild(s);
  }

  /* ============================================================
     五、找到那个开关 / 读出它当前的值
     ============================================================ */

  /** 当前编辑的是哪一篇（hash 里 slug 不带 .md，要宽容匹配） */
  function currentPath() {
    var m = /#\/collections\/[^/]+\/entries\/(.+)$/.exec(location.hash || '');
    if (!m) return '';
    var slug = m[1];
    try { slug = decodeURIComponent(slug); } catch (e) { /* 有裸 % 时解不开，直接用原文 */ }
    return matchPost(normalizePath(slug));
  }

  /**
   * ★★ Decap 的 boolean 字段**根本没有 checkbox** —— 这一点踩过坑：
   *   它把开关渲染成一个 `<button role="switch" aria-checked="true|false">`
   *   （打包文件里就一处 `role:"switch"`，组件叫 StyledToggle / ToggleContainer，
   *    里面是 ToggleBackground + ToggleHandle 两个 span）。
   *   所以第一版拿 `input[type=checkbox]` 找，**永远找不到**（哪怕字段标题就在页面上）。
   *   判断开 / 关只能读 `aria-checked`；这也是那个 Toggle 组件自己维护的状态。
   */
  var SWITCH_SEL = 'button[role="switch"]';

  function isOn(btn) {
    return !!btn && btn.getAttribute('aria-checked') === 'true';
  }

  /**
   * 找到「加入首页轮播图」那个开关按钮。
   *
   * ⚠️ 必须「记住上一次找到的那一个」，不能每次都从头搜：
   *   我们会在同一个字段卡片里插入自己的面板，面板会把该卡片的 textContent 撑大 ——
   *   任何「按卡片文字长度判断」的启发式都会在第一次渲染之后失效，
   *   结果是面板停止刷新、满员拦截也不再生效。所以先认缓存，
   *   元素被 React 换掉了（isConnected === false）才重新找。
   */
  function findSwitch() {
    /* ① 缓存 */
    if (S.inputRef && S.inputRef.isConnected) return S.inputRef;

    var btns = document.querySelectorAll(SWITCH_SEL);
    S.switchCount = btns.length;
    var btn = null;
    var hit = '';
    var i, j;

    /* ② 主力：让每个开关往上爬，找「**只包含它这一个开关**、且文字里有字段名」的卡片。
          「只有一个开关」这个条件很关键 —— 它自动把编辑器的富文本/源码切换按钮
          （也是 role="switch"）以及别的字段都排除掉了。 */
    for (i = 0; i < btns.length && !btn; i++) {
      var el = btns[i];
      for (j = 0; j < 8 && el; j++) {
        if (el.querySelectorAll && el.querySelectorAll(SWITCH_SEL).length === 1 &&
            (el.textContent || '').indexOf(FIELD_LABEL) >= 0) {
          btn = btns[i];
          hit = 'field-card';
          break;
        }
        el = el.parentNode;
      }
    }

    /* ③ 兜底：先按字段标题文字找（Decap 会在标题后补「 (optional)」，所以按前缀匹配），
          再往上取它卡片里的第一个开关 */
    if (!btn) {
      var all = document.querySelectorAll('#root *');
      var leaf = null;
      for (i = 0; i < all.length; i++) {
        var e2 = all[i];
        if (e2.children.length) continue;                   // 只看叶子，便宜且准
        var t2 = (e2.textContent || '').replace(/\s+/g, ' ').trim();
        if (t2.indexOf(FIELD_LABEL) !== 0) continue;
        if (t2.length > FIELD_LABEL.length + 24) continue;
        leaf = e2;
        break;
      }
      if (leaf) {
        var up = leaf;
        for (j = 0; j < 6 && up; j++) {
          var f2 = up.querySelector ? up.querySelector(SWITCH_SEL) : null;
          if (f2) { btn = f2; hit = 'label-text'; break; }
          up = up.parentNode;
        }
      }
    }

    if (!btn) return null;
    S.inputRef = btn;
    S.hit = hit;
    try { btn.setAttribute('data-cs-switch', '1'); } catch (e) {}
    return btn;
  }

  function containerOf(input) {
    /* ① Decap 的字段卡片（FieldLabel / ControlContainer） */
    var el = input;
    for (var i = 0; i < 8 && el; i++) {
      if (el.className && typeof el.className === 'string' &&
          /ControlContainer|FieldLabel/.test(el.className)) return el;
      el = el.parentNode;
    }
    /* ② 兜底：往上找「恰好只含这一个开关、且文字里有字段名」的那一层，
          和 findSwitch 用的是同一套判据，保证面板就挂在字段上、不会跑到别的字段下 */
    el = input.parentNode;
    for (var j = 0; j < 8 && el; j++) {
      if (el.querySelectorAll && el.querySelectorAll(SWITCH_SEL).length === 1 &&
          (el.textContent || '').indexOf(FIELD_LABEL) >= 0) return el;
      el = el.parentNode;
    }
    /* ③ 再兜底：别停在 button / label 上（点面板里的按钮会连带点开关） */
    var up = input.parentNode;
    while (up && (up.tagName === 'BUTTON' || up.tagName === 'LABEL')) up = up.parentNode;
    return up || input.parentNode;
  }

  /* ============================================================
     六、渲染面板
     ============================================================ */

  function panelFor(input) {
    var box = containerOf(input);
    if (!box) return null;
    var panel = box.querySelector('.cs-panel');
    if (!panel) {
      panel = document.createElement('div');
      panel.className = 'cs-panel';
      box.appendChild(panel);
    }
    return panel;
  }

  /**
   * 画面板。返回 html 字符串（**不自己写进 DOM**）——
   * 交给 tick() 去比对「跟上一帧一样就不动」，避免自触发 MutationObserver 空转。
   *
   * ★ 关键区分：**界面上的开关位置**（live）与**已保存的内容**（savedOn）是两回事。
   *   · 首页只看「已保存的 carousel 字段」（/api/bundle 拿到的就是它）
   *   · 而 switch 是 Decap 自己维护的界面状态，改一下还没 Publish 时两者就不一致
   *   ⇒ 面板以「已保存」为准（这才是首页真正的样子），并在两者不一致时明确说出来。
   */
  function renderPanel(input) {
    var live = isOn(input);                                // 界面上开关现在的位置
    var path = currentPath();
    var real = computeLayout('');                          // 已保存状态下的占位（= 首页现在显示的样子）

    var savedPost = null;
    (S.posts || []).forEach(function (p) { if (p.path === path) savedPost = p; });
    var savedOn = !!(savedPost && savedPost.carousel);     // 已保存的这一篇有没有勾

    var active = live || savedOn;                          // 现在（savedOn）或保存后（live）会不会占位
    var withMe = path ? computeLayout(path) : real;        // 把「本篇算进去」的预演
    var mine = null;
    for (var i = 0; i < withMe.entries.length; i++) {
      if (withMe.entries[i].path === path) { mine = withMe.entries[i]; break; }
    }
    var proj = active ? withMe : real;

    var html = '';

    /* 徽标 */
    if (!S.ready) {
      html += '<span class="cs-badge muted">' + (S.error ? '读不到清单' : '核对中…') + '</span>';
    } else {
      html += '<span class="cs-badge' + (proj.full ? ' full' : '') + '">轮播 ' + proj.used + '/' + proj.limit + '</span>';
    }

    html += '<div class="cs-detail">';

    if (!S.ready) {
      html += '<div class="cs-err">' +
        (S.error
          ? '读不到内容清单（' + escapeHtml(S.error) + '），这次不拦你 —— 请自行确认轮播位置还够。'
          : '正在核对全站轮播占用…') +
        '</div>';
    } else {
      var vis = proj.entries.filter(function (x) { return x.count > 0; });
      if (vis.length) {
        html += '<ul class="cs-list">';
        vis.forEach(function (x) {
          var range = x.total === 1 ? '第 ' + x.from + ' 张' : '第 ' + x.from + '-' + (x.from + x.total - 1) + ' 张';
          var here = x.path === path ? 'cs-here' : '';
          html += '<li class="' + here + '"><span class="cs-slot">' + range + '</span>' +
            '<span class="cs-name" title="' + escapeHtml(x.title) + '">' + escapeHtml(x.title) + '</span>' +
            '<span class="cs-n">' + x.total + ' 张</span></li>';
        });
        html += '</ul>';
      } else {
        html += '<div>现在还没有任何笔记加入轮播。</div>';
      }

      if (proj.overflow > 0) {
        html += '<div class="cs-warn">还有 ' + proj.overflow + ' 张被上限挤掉了，首页上看不到 —— 想都显示出来，去「前端页面设置 → 首页轮播图」把上限调大。</div>';
      }

      if (mine) {
        if (mine.total === 0) {
          html += '<div class="cs-warn">⚠️ 这一篇没有封面、正文里也没有插图，勾了不会出现在轮播里。</div>';
        } else if (active) {
          html += '<div>本篇 ' + mine.total + ' 张图里，有 ' + mine.count + ' 张进入轮播（第 ' + mine.from + '-' + (mine.from + mine.total - 1) + ' 位）' +
            (mine.cut > 0 ? '，另外 ' + mine.cut + ' 张被上限挤掉。' : '。') + '</div>';
        } else {
          html += '<div>勾上后：本篇 ' + mine.total + ' 张图将排在第 ' + mine.from + '-' + (mine.from + mine.total - 1) + ' 位' +
            (mine.count < mine.total ? '（其中有 ' + mine.cut + ' 张会超出上限、显示不出来）' : '') + '。</div>';
        }
      }

      /* ★ 界面开关 ≠ 已保存内容：说清楚以谁为准，免得主人以为「勾了/取了却没用」 */
      if (S.ready && path && live !== savedOn) {
        if (live && !savedOn) {
          html += '<div class="cs-note">开关刚改成「加入」，按 Publish 保存后首页才会跟着变。</div>';
        } else {
          html += '<div class="cs-warn">⚠️ 这个开关现在显示「未加入」，但已保存的内容里它是「已加入轮播」；首页只看已保存的 —— 想真去掉，要按 Publish 保存这一篇。</div>';
        }
      }

      if (active && proj.full && !real.full) {
        html += '<div class="cs-warn">保存后轮播就满了（' + proj.used + '/' + proj.limit + '），之后想再加别的笔记会被拦下。</div>';
      }

      if (real.full && !active) {
        html += '<div class="cs-blocked-hint">⚠️ 位置已满（' + real.used + '/' + real.limit + '）：现在点这个开关会被拦下。要在已经加入轮播的那一篇里把它关掉，空出位置再来。</div>';
      }
    }

    html += '<button type="button" class="cs-refresh">↻ 重新核对</button>';
    html += '</div>';

    return html;
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* ============================================================
     七、拦截：满员时掐掉这次点击
     ============================================================ */

  /**
   * 用**捕获阶段**监听：document 在 React 的事件根节点之上，
   * 这里 stopPropagation 就能让 React 收不到这次 click
   * ⇒ Decap 那个 Toggle 的 onClick 不会跑 ⇒ `aria-checked` 原样不动（开关没被点）。
   * 比去改 React 的内部 state 可靠得多。
   *
   * ⚠️ 开关是 `<button role="switch">`，**没有 change 事件**，
   *    所以「勾上了但这篇没图」的提醒也得挂在这个 click 上。
   */
  function onDocClickCapture(e) {
    var el = e.target;
    if (!el || !el.closest) return;

    var btn = el.closest(SWITCH_SEL);
    if (!btn || btn !== findSwitch()) return;   // 只管「加入首页轮播图」这一个

    if (isOn(btn)) return;                      // 关掉永远放行

    var path = currentPath();

    /* ① 满员：拦下。
          ⚠️ 例外：这一篇「已保存的内容」里本来就是勾着的（savedOn）——
             再点一次开并不会多占位置（它早就算在 used 里了），拦它就是误拦。 */
    if (S.ready) {
      var savedOn = false;
      (S.posts || []).forEach(function (p) { if (p.path === path) savedOn = p.carousel; });
      var real = computeLayout('');
      if (real.full && !savedOn) {
        e.preventDefault();
        e.stopPropagation();
        if (e.stopImmediatePropagation) e.stopImmediatePropagation();

        var names = real.entries
          .filter(function (x) { return x.count > 0; })
          .map(function (x) { return '「' + x.title + '」占 ' + x.count + ' 张'; });
        window.__csDebug = {
          at: Date.now(), action: 'BLOCKED(capture)', on: false,
          ready: S.ready, used: real.used, limit: real.limit, full: real.full, path: path
        };
        toast(
          '轮播图位置已满（' + real.used + '/' + real.limit + '），这一篇加不进去',
          ['先到已经加入轮播的那几篇里，把它们的「加入首页轮播图」关掉，空出位置再回来勾这一篇。']
            .concat(names.length ? ['当前占位：' + names.join('、')] : [])
            .concat(['（想一次显示更多张，也可以去「前端页面设置 → 首页轮播图」把「最多显示几张」调大）']),
          'warn'
        );
        return;
      }
    }

    /* ② 放行。但这篇一张图都没有的话，勾了也是白勾 —— 顺口提醒一下（不拦） */
    if (S.ready && path) {
      var total = 0;
      (S.posts || []).forEach(function (p) { if (p.path === path) total = p.images.length; });
      if (total === 0) {
        setTimeout(function () {
          toast(
            '这一篇没有图片',
            [
              '轮播里的每一张都来自笔记中的图片（封面，或正文里插入的图）。',
              '这篇既没设封面、正文里也没有插图，所以勾了也不会出现在轮播里。',
              '如果确实想让它上轮播，先给它加一张封面再回来勾。',
            ],
            'info'
          );
        }, 160);
      }
    }
  }

  /* ============================================================
     八、启动
     ============================================================ */

  var lastInput = null;

  function tick() {
    var input = findSwitch();
    if (!input) { S.inputRef = null; return; }
    if (input !== lastInput) {
      lastInput = input;
      S.inputRef = input;
    }
    var panel = panelFor(input);
    if (!panel) return;

    var html = renderPanel(input);
    /* ★ 跟上一帧一样就一个字都不动：否则我们自己写 DOM 会再次触发
       MutationObserver → 又 tick → 又写 DOM，白白空转还把按钮焦点洗掉。 */
    if (panel.__csHtml === html) return;
    panel.__csHtml = html;
    panel.innerHTML = html;
    var btn = panel.querySelector('.cs-refresh');
    if (btn) {
      btn.onclick = function (e) {
        e.preventDefault();
        loadIndex(true);
      };
    }
  }

  ensureStyle();
  /* 开关是 <button role="switch">，只有 click 可用（没有 change 事件） */
  document.addEventListener('click', onDocClickCapture, true);
  window.addEventListener('hashchange', function () {
    lastInput = null;
    setTimeout(function () { loadIndex(false); }, 200);
  });
  window.addEventListener('focus', function () { loadIndex(false); });

  /* 索引到位 / 更新后重画一次 */
  S.listeners.push(tick);
  loadIndex();

  /* 轮询 + MutationObserver 双保险：Decap 的 React 会整块替换 DOM */
  var timer = setInterval(tick, 700);
  if (window.MutationObserver) {
    var mo = new MutationObserver(function () {
      if (tickTimer) return;
      tickTimer = setTimeout(function () {
        tickTimer = 0;
        tick();
      }, 250);
    });
    var tickTimer = 0;
    var begin = function () {
      var root = document.getElementById('root') || document.body;
      mo.observe(root, { childList: true, subtree: true });
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', begin);
    else begin();
  }
  window.addEventListener('beforeunload', function () { clearInterval(timer); });

  window.__carouselSlotsReady = true;
  /* 只读诊断口（验证脚本与排查用，不参与逻辑） */
  window.__carouselSlots = {
    state: S,
    layout: computeLayout,
    findSwitch: findSwitch,
    refresh: function () { return loadIndex(true); }
  };
})();
