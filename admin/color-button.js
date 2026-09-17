/*
 * ============================================================
 * 后台正文编辑器：给 richtext 工具栏注入一个「🎨 颜色」按钮
 * ============================================================
 *
 * 目的：主人写文章时，选中一段文字 → 点「颜色」→ 选个色，这段字就变色了。
 *
 * 背景（为什么绕这么大圈）：
 *   Decap 的 richtext widget 内部是 Slate.js，官方没有任何「行内工具栏按钮」
 *   的注册 API（schema 里 buttons 白名单写死了 14 个，没有颜色）。
 *   所以只能自己往工具栏塞按钮。
 *
 * ★ 最关键的坑（实测踩过，别再踩）：
 *   Decap 存盘时，写进 .md 的是 **Slate 的 model**，不是 DOM。
 *   所以：
 *     · document.execCommand('insertText')  → 只改 DOM，**存盘会丢**
 *     · 手动派发 beforeinput 事件          → 同上，**存盘会丢**
 *     · editor.deleteFragment()+insertText() → ✅ 改的是 model，**能存进去**
 *   验证方法：切到 Markdown 模式看 textarea —— 它是从 model 序列化出来的。
 *   （用 execCommand 时，界面上字变了、切 Markdown 却还是旧的，就是这个原因）
 *
 * 所以真正的插入动作走 Slate：从编辑区元素的 React fiber 上取到
 * `memoizedProps.editor`（Slate 的 editor 实例），然后：
 *     editor.deleteFragment();          // 删掉选中的原文
 *     editor.insertText(短代码);         // 插入 {{<c:#hex>}}原文{{</c>}}
 *
 * 短代码语法与 index.html 里的 TC_RE 严格对应，改一处必须改两处：
 *     {{<c:#ff7a7a>}}文字{{</c>}}
 *     {{c:#ff7a7a}}文字{{/c}}            （短写法也认）
 */
(function () {
  'use strict';

  // ---------- 预设颜色（写得克制一点，够用就行） ----------
  var PRESET = [
    { name: '默认', value: '' },
    { name: '红', value: '#e5484d' },
    { name: '橙', value: '#f76808' },
    { name: '黄', value: '#ffb224' },
    { name: '绿', value: '#30a46c' },
    { name: '青', value: '#12a594' },
    { name: '蓝', value: '#0090ff' },
    { name: '紫', value: '#8e4ec6' },
    { name: '粉', value: '#e93d82' },
    { name: '灰', value: '#8b8d98' },
  ];

  var BTN_ID = 'tc-color-btn';
  var POP_ID = 'tc-color-pop';
  var mounted = false;
  var slateEditor = null;    // 缓存 Slate editor 实例
  var savedRange = null;     // 缓存的 DOM 选区

  /* ---------------- 样式（一次性注入） ---------------- */
  function injectStyle() {
    if (document.getElementById('tc-color-style')) return;
    var css = [
      '#' + BTN_ID + '{',
      '  display:inline-flex;align-items:center;gap:5px;',
      '  height:30px;padding:0 10px;margin:0 2px;',
      '  border:1px solid rgba(0,0,0,.14);border-radius:6px;',
      '  background:#fff;color:#313d4f;cursor:pointer;',
      '  font-size:12px;font-family:inherit;line-height:1;white-space:nowrap;',
      '}',
      '#' + BTN_ID + ':hover{background:#f3f4f6;border-color:rgba(0,0,0,.24);}',
      '#' + BTN_ID + ' .tc-sw{width:12px;height:12px;border-radius:3px;background:linear-gradient(135deg,#e5484d,#0090ff);}',

      '#' + POP_ID + '{',
      '  position:fixed;z-index:2147483000;',
      '  background:#fff;border:1px solid rgba(0,0,0,.12);border-radius:10px;',
      '  box-shadow:0 10px 34px rgba(0,0,0,.18);padding:10px;width:196px;',
      '  font-family:inherit;',
      '}',
      '#' + POP_ID + ' .tc-title{font-size:11px;color:#7a8493;margin:0 0 8px;font-weight:600;letter-spacing:.3px;}',
      '#' + POP_ID + ' .tc-grid{display:grid;grid-template-columns:repeat(5,1fr);gap:6px;}',
      '#' + POP_ID + ' .tc-item{',
      '  width:100%;aspect-ratio:1/1;border-radius:6px;cursor:pointer;',
      '  border:1px solid rgba(0,0,0,.12);position:relative;',
      '}',
      '#' + POP_ID + ' .tc-item:hover{transform:scale(1.1);}',
      '#' + POP_ID + ' .tc-item.tc-none{background:#fff;color:#98a1b0;font-size:9px;display:flex;align-items:center;justify-content:center;}',
      '#' + POP_ID + ' .tc-row{display:flex;gap:6px;align-items:center;margin-top:9px;}',
      '#' + POP_ID + ' .tc-row input{',
      '  flex:1;min-width:0;height:27px;padding:0 7px;box-sizing:border-box;',
      '  border:1px solid rgba(0,0,0,.16);border-radius:6px;font-size:12px;font-family:inherit;',
      '}',
      '#' + POP_ID + ' .tc-row button{',
      '  height:27px;padding:0 10px;border:0;border-radius:6px;',
      '  background:#6366f1;color:#fff;font-size:12px;font-weight:600;cursor:pointer;font-family:inherit;',
      '}',
      '#' + POP_ID + ' .tc-tip{margin-top:8px;font-size:11px;color:#98a1b0;line-height:1.5;}',
    ].join('\n');
    var st = document.createElement('style');
    st.id = 'tc-color-style';
    st.textContent = css;
    document.head.appendChild(st);
  }

  /* ---------------- 找到「正文编辑器」的 toolbar 容器 ---------------- */
  /*
   * ⚠️ 这里踩过坑，说明一下：
   *   Decap 后台里 class 带 ToolbarContainer 的元素有两处 ——
   *     ① 页面顶栏（返回链接 / Publish 按钮），即 ...ToolbarSubSectionFirst 那一支
   *     ② 正文编辑器自己的按钮条（Bold / Italic / Code …）
   *   第一版按「第一个可见的 ToolbarContainer」去抓，结果注到了顶栏上（y≈36），
   *   而真正该在的位置是编辑器按钮条（y≈690 一带）。
   *
   *   可靠的判据：**从正文编辑区出发往上找**。
   *   实测 DOM 层级是：
   *     BUTTON.StyledToolbarButton  ← 单个格式按钮
   *       └ DIV（无 class，装着 10 个按钮）
   *         └ DIV.ToolbarContainer   ← ★ 要的就是它
   *           └ DIV.EditorControlBar
   *             └ DIV.cms-editor-visual
   */
  function findToolbar() {
    var ed = findEditable();
    if (ed) {
      // 从编辑区往上爬，找 EditorControlBar / cms-editor-visual 里的 ToolbarContainer
      var n = ed;
      for (var d = 0; d < 8 && n; d++) {
        var tb = n.querySelector && n.querySelector('[class*="ToolbarContainer"]');
        if (tb && tb.getClientRects().length) return tb;
        n = n.parentElement;
      }
    }
    // 兜底：找带 title 的格式按钮（Bold/Italic/…），再上溯
    var fmt = document.querySelector('[title="Bold"],[title="Italic"],[title="Code"]');
    if (fmt) {
      var p = fmt.parentElement;
      for (var k = 0; k < 4 && p; k++) {
        if (/ToolbarContainer/.test(String(p.className || ''))) return p;
        p = p.parentElement;
      }
      if (fmt.parentElement) return fmt.parentElement;
    }
    return null;
  }

  /* ---------------- 找 contenteditable 编辑区（仅作兜底/诊断用） ---------------- */
  function findEditable() {
    var cands = document.querySelectorAll('.slate-editor, [data-slate-editor="true"], [contenteditable="true"]');
    for (var i = 0; i < cands.length; i++) {
      if (cands[i].getClientRects().length) return cands[i];
    }
    return null;
  }

  /* ---------------- 颜色值合法性 ---------------- */
  var COLOR_RE = /^(#[0-9a-fA-F]{3,8}|[a-zA-Z]{3,20})$/;
  function safeColor(v) {
    var s = String(v || '').trim();
    return COLOR_RE.test(s) ? s : '';
  }

  /* ==========================================================
     选区缓存
     ----------------------------------------------------------
     为什么必须缓存：
       色板是弹在 document.body 上的独立浮层。用户「选中文字 → 点按钮 →
       点色块」的过程中，点色块会让浏览器把焦点移出编辑区，
       等到 execCommand 执行时 **window.getSelection() 已经空了**，
       于是什么都插不进去（实测踩过这个坑，表现为「点了没反应」）。

     做法：在打开色板的瞬间把 range 存下来；applyColor 时先把缓存的
     range 恢复回 Selection，再执行插入。
     ========================================================== */
  var savedRange = null;

  function saveSelection() {
    var sel = window.getSelection();
    if (sel && sel.rangeCount > 0 && String(sel).length) {
      savedRange = sel.getRangeAt(0).cloneRange();
      return true;
    }
    return false;
  }

  function restoreSelection() {
    if (!savedRange) return false;
    try {
      var sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(savedRange);
      return true;
    } catch (e) {
      return false;
    }
  }

  /* ==========================================================
     取 Slate editor 实例
     ----------------------------------------------------------
     Decap 把 Slate 的 editor 对象作为 props 传下去，React 会把它挂在
     组件 fiber 的 memoizedProps 上。所以从编辑区 DOM 元素拿 __reactFiber$
     再往上/往下遍历，就能捞到它。

     判据要写严一点，避免抓到别的东西：
       · 有 apply 方法（Slate editor 必有）
       · 有 children 数组
       · 有 insertText / deleteFragment
     ========================================================== */
  function getSlateEditor() {
    // 拿过就复用，并校验它还在树里（换文章/切模式会重建）
    if (slateEditor && isEditorAlive(slateEditor)) return slateEditor;

    var ed = findEditable();
    if (!ed) return null;

    var keys = Object.keys(ed).filter(function (k) { return k.indexOf('__reactFiber$') === 0; });
    if (!keys.length) return null;

    var found = null;
    var seen = [];
    function isEditor(o) {
      return o && typeof o === 'object'
        && typeof o.apply === 'function'
        && typeof o.insertText === 'function'
        && Array.isArray(o.children);
    }
    function walk(f, depth) {
      if (!f || depth > 60 || found) return;
      if (seen.indexOf(f) >= 0) return;
      seen.push(f);
      var mp = f.memoizedProps;
      if (mp) {
        if (isEditor(mp.editor)) { found = mp.editor; return; }
        if (isEditor(mp.value)) { found = mp.value; return; }
      }
      walk(f.child, depth + 1);
      walk(f.sibling, depth + 1);
    }
    try { walk(ed[keys[0]], 0); } catch (e) { /* ignore */ }

    slateEditor = found;
    return slateEditor;
  }

  // 简单校验 editor 还活着（能读到 children）
  function isEditorAlive(e) {
    try { return !!(e && Array.isArray(e.children) && findEditable()); }
    catch (err) { return false; }
  }

  /* ---------------- 通过 Slate model 插入（正路） ---------------- */
  function insertViaSlate(payload) {
    var editor = getSlateEditor();
    if (!editor || !editor.selection) return false;   // 没选区 → 交给调用方提示
    try {
      editor.deleteFragment();       // 删掉用户选中的原文
      editor.insertText(payload);    // 插入短代码
      return true;
    } catch (e) {
      return false;
    }
  }

  /* ---------------- 兜底：原生 execCommand（只改 DOM，存盘会丢） ----------------
   * 老实说这条兜底基本没有实际价值（因为存盘存的是 model），
   * 留着只是为了在 Slate 取不到时不至于静默失败，让用户至少看到字变了、
   * 由 flash 提示他"请检查 Markdown 模式确认"。
   */
  function insertViaExecCommand(payload) {
    try {
      return document.execCommand('insertText', false, payload);
    } catch (e) {
      return false;
    }
  }

  /* ---------------- 核心：把选中文字包成短代码 ---------------- */
  /*
   * ⚠️ 两个坑，改代码时务必留意：
   *
   * 坑 1：**绝对不要在插入前调用 editable.focus()**。
   *   实测（无头 Chrome + 真实后台）：拖选正文后调用 focus()，浏览器会把
   *   选区折叠成光标（Selection.toString() 变空串），后面就没东西可替换了。
   *   正确做法是在按钮的 mousedown 上 preventDefault（mount 里已做），
   *   让按钮不抢焦点、选区自然保留。
   *
   * 坑 2：**必须走 Slate 的 model，不能只改 DOM**（见文件头说明）。
   *   而且 Slate 的 `editor.selection` 是随鼠标拖选自动同步的 —— 实测拖选
   *   「进行一个」后，它给出 {anchor:{path:[1,0],offset:0}, focus:{...,offset:4}}，
   *   与原生选区一致，所以直接 deleteFragment + insertText 就行。
   */
  function applyColor(color) {
    var c = safeColor(color);

    // 先把选区恢复回来（点色板时浏览器会把焦点移走、选区折叠）
    restoreSelection();

    var sel = window.getSelection();
    var text = sel ? sel.toString() : '';

    if (!text) {
      flash('请先在正文里选中要变色的文字');
      return false;
    }

    var open = c ? '{{<c:' + c + '>}}' : '';
    var close = c ? '{{</c>}}' : '';
    // 清空颜色 = 去掉已有的短代码包裹（把用户选中的内容原样还回去）
    var payload = c ? open + text + close : text.replace(/\{\{<c:[^>]*>\}\}|\{\{<\/c>\}\}/g, '');

    // ① 正路：走 Slate model（这样存盘才带得上）
    if (insertViaSlate(payload)) return true;

    // ② 兜底：原生插入。注意这条路只改 DOM，保存时可能丢失，
    //    所以额外提醒一句，避免主人以为已经存好了。
    if (insertViaExecCommand(payload)) {
      flash('已插入，但可能没同步到保存内容，请切到 Markdown 模式确认一下');
      return true;
    }

    flash('插入失败，可以手动写 ' + open + '…' + close);
    return false;
  }

  /* ---------------- 小提示 ---------------- */
  function flash(msg) {
    var d = document.createElement('div');
    d.textContent = msg;
    d.style.cssText = 'position:fixed;left:50%;top:24px;transform:translateX(-50%);z-index:2147483001;' +
      'background:#313d4f;color:#fff;font-size:12px;padding:9px 15px;border-radius:8px;' +
      'font-family:-apple-system,sans-serif;box-shadow:0 6px 22px rgba(0,0,0,.25);';
    document.body.appendChild(d);
    setTimeout(function () { d.remove(); }, 2600);
  }

  /* ---------------- 颜色选择浮层 ---------------- */
  var popEl = null;
  function closePop() {
    if (popEl) { popEl.remove(); popEl = null; }
    document.removeEventListener('mousedown', onDocDown, true);
    window.removeEventListener('resize', closePop);
    window.removeEventListener('scroll', closePop, true);
  }
  function onDocDown(e) {
    if (popEl && !popEl.contains(e.target) && e.target.id !== BTN_ID) closePop();
  }

  function openPop(btn) {
    if (popEl) { closePop(); return; }
    injectStyle();

    // 打开色板的同时把当前选区存下来（点色板时选区会丢）
    saveSelection();

    popEl = document.createElement('div');
    popEl.id = POP_ID;

    var grid = document.createElement('div');
    grid.className = 'tc-grid';
    PRESET.forEach(function (p) {
      var item = document.createElement('div');
      item.className = 'tc-item' + (p.value ? '' : ' tc-none');
      if (p.value) {
        item.style.background = p.value;
        item.title = p.name + ' ' + p.value;
      } else {
        item.textContent = '无';
        item.title = '去掉颜色';
      }
      item.addEventListener('click', function () {
        applyColor(p.value);
        closePop();
      });
      grid.appendChild(item);
    });

    var title = document.createElement('div');
    title.className = 'tc-title';
    title.textContent = '选中文字后点一个颜色';

    var row = document.createElement('div');
    row.className = 'tc-row';
    var input = document.createElement('input');
    input.type = 'text';
    input.placeholder = '自定义色号 #ff7a7a';
    var go = document.createElement('button');
    go.textContent = '应用';
    function doCustom() {
      var v = input.value.trim();
      if (!safeColor(v)) { flash('色号格式不对，示例：#ff7a7a 或 red'); return; }
      applyColor(v);
      closePop();
    }
    go.addEventListener('click', doCustom);
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); doCustom(); }
    });
    row.appendChild(input);
    row.appendChild(go);

    var tip = document.createElement('div');
    tip.className = 'tc-tip';
    tip.textContent = '插入后正文里会看到 {{<c:#…>}} 这样的标记，发布后前台会自动显示成彩色文字。';

    popEl.appendChild(title);
    popEl.appendChild(grid);
    popEl.appendChild(row);
    popEl.appendChild(tip);
    document.body.appendChild(popEl);

    // 定位到按钮下方
    var r = btn.getBoundingClientRect();
    var w = 196, h = popEl.offsetHeight;
    var left = Math.min(r.left, window.innerWidth - w - 12);
    var top = r.bottom + 8;
    if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 8);
    popEl.style.left = Math.max(8, left) + 'px';
    popEl.style.top = top + 'px';

    setTimeout(function () {
      document.addEventListener('mousedown', onDocDown, true);
      window.addEventListener('resize', closePop);
      window.addEventListener('scroll', closePop, true);
    }, 0);
  }

  /* ---------------- 往编辑器工具栏里塞按钮 ---------------- */
  function mount() {
    var tb = findToolbar();
    if (!tb) return false;

    // 工具栏重渲染后按钮会丢，这里负责补回来（同一个容器里只留一个）
    var existing = document.getElementById(BTN_ID);
    if (existing) {
      if (existing.parentElement === tb) { mounted = true; return true; }
      existing.remove();                                  // 挪了位置 → 重新插
    }

    injectStyle();

    var btn = document.createElement('button');
    btn.id = BTN_ID;
    btn.type = 'button';
    btn.title = '给选中的文字上色';
    btn.innerHTML = '<span class="tc-sw"></span><span>颜色</span>';
    // ⚠️ 必须阻止 mousedown 默认行为：否则按钮抢焦点 → 正文选区被折叠 → 插不进去
    btn.addEventListener('mousedown', function (e) {
      saveSelection();                                    // 抢在焦点变化前存下来
      e.preventDefault();
      e.stopPropagation();
    });
    btn.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      openPop(btn);
    });

    tb.appendChild(btn);
    mounted = true;
    return true;
  }

  /* ---------------- 启动：等工具栏出现 ---------------- */
  function start() {
    mount();
    var tries = 0;
    var timer = setInterval(function () {
      tries++;
      if (mount() || tries > 120) clearInterval(timer);   // 最多等 60 秒
    }, 500);

    // 编辑器会随「切文章 / 切 Rich Text↔Markdown 模式」重挂，持续盯着补按钮
    if (window.MutationObserver) {
      var mo = new MutationObserver(function () {
        if (!document.getElementById(BTN_ID)) mount();
      });
      mo.observe(document.documentElement, { childList: true, subtree: true });
    }
  }

  // Decap 加载完 / 路由切换后再装一次
  window.addEventListener('load', function () { setTimeout(start, 800); });
  if (document.readyState === 'complete') setTimeout(start, 800);
  else document.addEventListener('DOMContentLoaded', function () { setTimeout(start, 800); });

  // 暴露给验证脚本
  window.__tc = {
    mount: mount,
    applyColor: applyColor,
    findToolbar: findToolbar,
    findEditable: findEditable,
    getSlateEditor: getSlateEditor,
    PRESET: PRESET,
  };
})();
