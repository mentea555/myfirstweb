/**
 * 自动日期（admin/auto-date.js）
 * ============================================================
 *
 * 【为什么要它】
 *   后台「发布日期」是必填字段，但新建时是空的，主人每次发插画都得手动
 *   点开日历调一遍 —— 尤其是补发旧作品时，要一个个挑到几个月前的日期。
 *
 * 【它做三件事】
 *   ① 日期空着 → 自动填【今天】，不用再点 Now
 *   ② 上传图片完成 → 自动改成【这张图片文件自己的时间】
 *      （浏览器选文件时会带上 file.lastModified，就是那个文件在磁盘上
 *        的修改时间；对补发旧作品来说，这正是主人要的「作品日期」）
 *   ③ 主人一旦自己动过这个字段（手改 / 点 Clear）→ 本页内不再插手
 *
 * 【为什么用 DOM 而不是自写 widget】
 *   实测（tools/probe-autodate.js）Decap 3 的日期字段渲染的**就是原生**
 *   `<input type="datetime-local" id="date-field-N">`，旁边配 Now / Clear 两个按钮。
 *   既然是原生输入框，直接写它的 value + 派发 input 事件就能被 React 收下，
 *   不必替换控件 —— 好处是 config.yml 一行都不用改，主人看到的界面完全不变。
 *
 * 【踩过的坑】
 *   · React 受控输入**不能**直接 `input.value = x`：React 内部记着上一次的值
 *     （valueTracker），发现"没变"就吞掉这次事件。必须绕到原型上的原生 setter
 *     再派发 input 事件，React 才认。
 *   · `datetime-local` 的 value 必须是 `YYYY-MM-DDTHH:mm`（中间是字母 T）。
 *     写成 `YYYY-MM-DD HH:mm` 浏览器会当非法值丢掉。
 *   · 不能"只要为空就填"：编辑已有文章时，字段会先渲染成空、数据随后才到，
 *     这时抢填会把主人原来的日期冲成今天。所以加了「表单就绪」判断 + 稳定窗口。
 *   · Clear 按钮点完若立刻又被填上，会觉得"清不掉" → 点过 Now/Clear 也算手动。
 *
 * 【注册时机】
 *   与其它自有脚本一起在 CMS.init() 之前加载，见 /admin/index.html。
 */

(function () {
  'use strict';

  /* 与主人现有几篇的写法保持一致（几篇都是 12:12）；前台只显示年月日，时间无影响 */
  var HOUR = 12;
  var MIN = 12;

  /* 上传图片后多久内不接受事件（避免刚进页面就吃到历史事件） */
  var state = {
    hash: '',
    input: null,
    autoValue: null,      /* 我最近一次自动填进去的值 */
    touched: false,       /* 主人自己动过 → 本页内不再自动改 */
    fromImage: false,     /* 本次是否已用图片时间填过 */
    emptySince: 0,        /* 日期连续为空的起始时刻 */
    setting: false,       /* 正在用程序写值（用来区分"是不是主人手改"） */
    pending: null,        /* 上传事件到了但输入框还没出现，先存着 */
    tip: null,            /* 提示元素 */
    tipText: '',          /* 提示内容（被 React 重渲染顺手清掉后用它补回来） */
    tipTone: 'ok'
  };

  /* ------------------------------------------------------------------
     一、找到「发布日期」那个输入框
     不靠 CSS-in-JS 的类名（带哈希、会变），而是靠 label 的 for 属性，
     这个 id 由 Decap 按 `字段名-field-序号` 稳定生成。
     ------------------------------------------------------------------ */
  function findDateInput() {
    var labels = document.querySelectorAll('label');
    for (var i = 0; i < labels.length; i++) {
      if (/发布日期/.test(labels[i].textContent || '')) {
        var id = labels[i].getAttribute('for');
        if (id) {
          var el = document.getElementById(id);
          if (el && el.type === 'datetime-local') return el;
        }
      }
    }
    /* 兜底：页面上唯一的 datetime-local 就是它 */
    var all = document.querySelectorAll('input[type="datetime-local"]');
    return all.length === 1 ? all[0] : null;
  }

  /* ------------------------------------------------------------------
     二、写值（绕过 React 的 valueTracker）
     ------------------------------------------------------------------ */
  function fmt(date, h, m) {
    var p = function (n) { return String(n).padStart(2, '0'); };
    return date.getFullYear() + '-' + p(date.getMonth() + 1) + '-' + p(date.getDate()) +
      'T' + p(h) + ':' + p(m);
  }

  function setValue(input, value) {
    var desc = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
    state.setting = true;
    try {
      if (desc && desc.set) desc.set.call(input, value);
      else input.value = value;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    } catch (e) {
      console.warn('[auto-date] 写值失败', e);
    }
    state.setting = false;
  }

  /* ------------------------------------------------------------------
     三、小提示：让主人一眼看出日期是从哪来的（点一下可关掉）
     ------------------------------------------------------------------ */
  var TIP_CLASS = 'ad-tip';
  function clearTip() {
    state.tipText = '';
    if (state.tip) { state.tip.remove(); state.tip = null; }
  }
  function showTip(input, text, tone) {
    state.tipText = text;
    state.tipTone = tone || 'ok';
    renderTip(input);
  }
  function renderTip(input) {
    var text = state.tipText;
    if (!text) return;
    var host = (input && input.parentElement) || null;
    if (!host) return;
    if (state.tip && !document.contains(state.tip)) state.tip = null;
    if (!state.tip) {
      state.tip = document.createElement('div');
      state.tip.className = TIP_CLASS;
      state.tip.style.cssText =
        'margin-top:6px;font-size:12px;line-height:1.5;display:flex;gap:6px;align-items:flex-start;';
      host.appendChild(state.tip);
    }
    state.tip.innerHTML = '';
    var span = document.createElement('span');
    span.textContent = text;
    span.style.color = state.tipTone === 'warn' ? '#b45309' : '#0f766e';
    var x = document.createElement('a');
    x.textContent = '知道了';
    x.href = 'javascript:void(0)';
    x.style.cssText = 'color:#94a3b8;text-decoration:underline;flex:0 0 auto;';
    x.onclick = clearTip;
    state.tip.appendChild(span);
    state.tip.appendChild(x);
  }

  /* ------------------------------------------------------------------
     四、日期来源
     ------------------------------------------------------------------ */
  function isSane(ts) {
    if (typeof ts !== 'number' || !isFinite(ts)) return false;
    var d = new Date(ts);
    if (isNaN(d.getTime())) return false;
    if (d.getFullYear() < 2000) return false;                 /* 明显不是真时间 */
    if (ts > Date.now() + 86400000) return false;             /* 未来一天以上，离谱 */
    return true;
  }

  /* 图片时间 → 日期（时间统一 12:12，和现有几篇一致） */
  function dateFromImage(ts) {
    var d = new Date(ts);
    return { value: fmt(d, HOUR, MIN), label: d.getFullYear() + '年' + (d.getMonth() + 1) + '月' + d.getDate() + '日' };
  }

  function todayValue() {
    return fmt(new Date(), HOUR, MIN);
  }

  /* ------------------------------------------------------------------
     五、表单是否"数据已就绪"
     编辑已有文章时，字段会先渲染成空、entry 数据随后才到。
     这时抢填会把主人原来的日期冲掉，所以要判断一下。
     ------------------------------------------------------------------ */
  function isNewEntry() {
    /* Decap 的 hash 路由：#/collections/<集合>/new */
    return /\/new(\?|$|\/)/.test(location.hash || '');
  }

  function formReady(input) {
    if (isNewEntry()) return true;
    if (input.value) return true;                 /* 已经有值，不用填 */
    /* 其它字段已经有内容（标题 / 正文）→ 说明数据到了 */
    var title = document.getElementById('title-field-1');
    if (title && String(title.value || '').trim()) return true;
    if (document.querySelector('[class*="RichText"], [class*="rich-text"]')) return true;
    return false;
  }

  /* ------------------------------------------------------------------
     六、主循环
     Decap 的字段是动态渲染的，用轮询最省心（600ms 一次，开销可忽略）。
     ------------------------------------------------------------------ */
  function tick() {
    var hash = location.hash || '';

    /* 换了表单（新建 / 切到别的文章）→ 重置状态 */
    if (hash !== state.hash) {
      state.hash = hash;
      state.input = null;
      state.autoValue = null;
      state.touched = false;
      state.fromImage = false;
      state.emptySince = 0;
      clearTip();
    }

    var input = findDateInput();
    if (!input) { state.input = null; return; }

    /* 输入框被 React 重新挂载（引用变了）时只更新引用，保留已有状态 */
    if (input !== state.input) state.input = input;

    /* 上传事件比输入框先到的情况：在这里补一次 */
    if (state.pending) applyImageDate();

    /* 提示可能被 React 重渲染顺手清掉，发现没了就补回来 */
    if (!state.touched && state.tipText && (!state.tip || !document.contains(state.tip))) renderTip(input);

    if (state.touched || state.fromImage) return;

    if (input.value) { state.emptySince = 0; return; }

    /* 空值：先确认表单数据已就绪，再等 400ms 稳定窗口（躲开 React 首次渲染） */
    if (!formReady(input)) { state.emptySince = 0; return; }
    if (!state.emptySince) { state.emptySince = Date.now(); return; }
    if (Date.now() - state.emptySince < 400) return;

    var v = todayValue();
    setValue(input, v);
    state.autoValue = v;
    showTip(input, '已自动填今天（' + v.replace('T', ' ') + '）。上传图片后会自动改成图片的日期。', 'ok');
  }

  /* ------------------------------------------------------------------
     七、主人手动改过 → 以后不再插手
     用事件委托挂在 document 上：输入框会被 React 重渲染替换，
     直接给元素挂监听会丢。
     ------------------------------------------------------------------ */
  document.addEventListener('input', function (e) {
    var t = e.target;
    if (!t || t.type !== 'datetime-local') return;
    if (state.setting) return;                    /* 是我们自己写的，不算手改 */
    state.touched = true;
    state.autoValue = null;
    clearTip();
  }, true);

  /* 点 Now / Clear 也算手动操作（否则 Clear 完立刻又被填上，感觉清不掉） */
  document.addEventListener('click', function (e) {
    var t = e.target;
    if (!t || t.tagName !== 'BUTTON') return;
    var label = (t.getAttribute('aria-label') || '') + ' ' + (t.textContent || '');
    if (/clear|now|set date/i.test(label)) {
      var input = findDateInput();
      /* 只认「发布日期」那一组按钮 */
      if (input && input.parentElement && input.parentElement.contains(t)) {
        state.touched = true;
        state.autoValue = null;
        clearTip();
      }
    }
  }, true);

  /* ------------------------------------------------------------------
     八、图床上传完成 → 用图片自己的时间填
     imgbed-media.js 上传成功后会广播 window 事件（见该文件）。

     ★ 只在「日期是自动填的」或「还是空的」时才接手 —— 这样编辑已有文章时
       换个封面不会把主人原来的日期改掉。
     ------------------------------------------------------------------ */
  function applyImageDate() {
    if (!state.pending || state.touched) return;
    var input = findDateInput();
    if (!input) return;                       /* 输入框还没出现，留给 tick 再试 */

    /*
     * 什么时候可以接手上传图片的时间？
     *   · 新建一篇 —— 可以。这里也包括「Publish and duplicate」出来的副本：
     *     那种情况下日期是从模板带过来的，并不是主人特意定的，也该被图片时间接管。
     *   · 编辑已有文章 —— 只有「日期是自动填的」或「还空着」时才动，
     *     否则会把主人原来设好的日期改掉。
     */
    var canApply = isNewEntry() ||
      (state.autoValue === null && !input.value) ||
      input.value === state.autoValue;
    if (!canApply) { state.pending = null; return; }

    var ts = state.pending.lastModified;
    var fromImage = isSane(ts);
    if (!fromImage) ts = Date.now();          /* 拿不到图片时间就退回今天 */

    var r = dateFromImage(ts);
    state.pending = null;
    if (input.value === r.value) { state.fromImage = true; return; }

    setValue(input, r.value);
    state.autoValue = r.value;
    state.fromImage = true;

    showTip(input, fromImage
      ? '已按图片时间自动填：' + r.label + '（图片文件在电脑上的修改时间）。不对就直接改，改过之后不再自动覆盖。'
      : '已自动填今天（没读到图片的时间信息）。', fromImage ? 'ok' : 'warn');
  }

  window.addEventListener('imgbed:uploaded', function (e) {
    var d = (e && e.detail) || {};
    state.pending = { lastModified: d.lastModified, url: d.url || '' };
    applyImageDate();
  }, false);

  /* ------------------------------------------------------------------
     九、启动
     ------------------------------------------------------------------ */
  setInterval(tick, 600);
  window.addEventListener('hashchange', function () { state.hash = '\u0000'; });
  setTimeout(tick, 300);

  window.__autoDateReady = true;
  console.log('[auto-date] 已启动：日期空着自动填今天，上传图片后自动改成图片时间');
})();
