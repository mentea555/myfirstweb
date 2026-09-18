/**
 * 标签控件（Decap 自定义 widget：`widget: tags`）
 * ============================================================
 *
 * 【为什么要自己写一个？】
 *   原来用的是 Decap 内置的 select 控件（multiple: true），它能"选多个"，
 *   但**做不到主人要的「回车新增」**。原因在源码里：
 *
 *     packages/decap-cms-widget-select/src/schema.js
 *       properties: { multiple, min, max, options }   ← 只有这四个
 *
 *   —— 没有 `creatable`。所以配置里写 `creatable: true` 会被**静默忽略**，
 *   控件内部用的是普通 `react-select` 而不是 `Creatable` 版本，表现就是：
 *     · 打一个字 → 下拉只显示「No options」（截图里就是这个）
 *     · 按回车 → 什么都不发生
 *     · 没提交的文字 → 点一下别处就丢了
 *
 * 【这个控件给到的行为】
 *   · 打字后按【回车】或【中文/英文逗号】→ 变成一颗标签
 *   · 每颗标签右边一个 ×  →  点它删掉
 *   · 输入框空着按【退格】→ 删掉最后一颗（跟主流标签输入框一致）
 *   · 点下拉里的建议 → 直接加入（建议自动排除已选的）
 *   · ★ 打了字但没按回车就点到别处 → **也算数，自动收成标签**
 *         （主人反馈过「点其他地方就变空白」，这里直接堵掉这个坑）
 *   · ★ 中文输入法组字时按回车 = 选词 → **不会**误触发
 *         （判 isComposing / keyCode 229，否则打「草图」选词时会把半成品加进去）
 *
 * 【注册时机】
 *   必须在 CMS.init() **之前**执行，顺序见 /admin/index.html。
 */

(function () {
  'use strict';

  var h = window.h;
  var createClass = window.createClass;

  if (!h || !createClass || !window.CMS || typeof window.CMS.registerWidget !== 'function') {
    console.error('[tags-widget] 缺少 Decap 全局（h / createClass / CMS），标签控件注册失败');
    return;
  }

  /* ============================================================
     一、工具函数
     ============================================================ */

  /**
   * 把 Decap 传进来的 value 统一成「干净的字符串数组」。
   *
   * value 可能是：Immutable List（Decap 内置控件存的就是它，有 toJS）、
   * 普通数组、单个字符串、null/undefined、甚至一串逗号分隔的文本
   * （老数据里 tags 可能写成 "插画, 随笔" 这种）。全都兜住。
   */
  function toArray(v) {
    if (!v) return [];
    if (typeof v.toJS === 'function') {
      try { v = v.toJS(); } catch (e) { return []; }
    }
    if (typeof v === 'string') v = v.split(',');
    if (!Array.isArray(v)) return [];

    var out = [];
    v.forEach(function (item) {
      var s = String(item == null ? '' : item).replace(/^#+/, '').trim();
      if (s && out.indexOf(s) === -1) out.push(s);
    });
    return out;
  }

  /**
   * 回传给 Decap 的值。
   *
   * Decap 内部的值是 Immutable（它自己的内置控件都回传 Immutable），所以
   * **优先用同一种容器装回去**；拿不到就退回普通数组 —— 官方文档里自定义
   * 控件的示例回传的就是普通数组，两条路它都认。
   */
  function emit(list, sample) {
    if (sample && typeof sample.toJS === 'function' && typeof sample.constructor === 'function') {
      try { return sample.constructor(list); } catch (e) { /* 退回普通数组 */ }
    }
    return list;
  }

  /** 读出字段配置里的 options（可能是 Immutable List，也可能带 {label,value}） */
  function optionList(field) {
    if (!field || typeof field.get !== 'function') return [];
    var raw = field.get('options');
    if (!raw) return [];
    if (typeof raw.toJS === 'function') {
      try { raw = raw.toJS(); } catch (e) { return []; }
    }
    if (!Array.isArray(raw)) return [];

    return raw.map(function (o) {
      if (o && typeof o === 'object') {
        var v = o.value != null ? o.value : o.label;
        return { label: String(o.label != null ? o.label : o.value), value: String(v) };
      }
      return { label: String(o), value: String(o) };
    });
  }

  /* ============================================================
     二、控件本体
     ============================================================ */
  var TagsControl = createClass({
    getInitialState: function () {
      return { draft: '', open: false };
    },

    componentWillUnmount: function () {
      /* 卸载后别再 setState（blur 里有个延时回调） */
      this._alive = false;
    },

    componentDidMount: function () {
      this._alive = true;
    },

    /* ---------- 读写值 ---------- */
    read: function () {
      return toArray(this.props.value);
    },

    write: function (list) {
      if (!this._alive && this._alive !== undefined) {
        /* 已经卸载了就别写了 */
        return;
      }
      this.props.onChange(emit(list, this.props.value));
    },

    add: function (raw) {
      var name = String(raw == null ? '' : raw).replace(/^#+/, '').trim();
      if (!name) return false;
      var list = this.read();
      if (list.indexOf(name) !== -1) return false;
      list.push(name);
      this.write(list);
      return true;
    },

    remove: function (name) {
      this.write(this.read().filter(function (t) { return t !== name; }));
    },

    /* ---------- 输入框事件 ---------- */
    handleInput: function (e) {
      this.setState({ draft: e.target.value, open: true });
    },

    handleKeyDown: function (e) {
      /*
       * ⚠️ 中文输入法组字过程中，回车是「确认候选词」而不是「提交」。
       *    不排除掉的话，主人打「草图」两个字、中间按回车选词，就会把
       *    半成品当成标签加进去。（keyCode 229 是部分输入法的兼容信号）
       */
      var native = e.nativeEvent || {};
      if (native.isComposing || native.keyCode === 229) return;

      var draft = this.state.draft;

      if (e.key === 'Enter' || e.key === ',' || e.key === '，') {
        e.preventDefault();
        this.add(draft);
        this.setState({ draft: '', open: false });
        return;
      }

      if (e.key === 'Backspace' && !draft) {
        var list = this.read();
        if (list.length) {
          e.preventDefault();
          this.remove(list[list.length - 1]);
        }
        return;
      }

      if (e.key === 'Escape') {
        this.setState({ draft: '', open: false });
      }
    },

    /* 点了下拉建议：用 mousedown 拦一下，别让输入框先失焦（否则会先走提交逻辑） */
    keepFocus: function (e) {
      if (e && e.preventDefault) e.preventDefault();
    },

    pickOption: function (value) {
      this.add(value);
      this.setState({ draft: '', open: false });
      if (this._input) this._input.focus();
    },

    handleFocus: function () {
      this.setState({ open: true });
      this.props.setActiveStyle();
    },

    handleBlur: function () {
      var self = this;
      this.props.setInactiveStyle();
      /* 等一拍：如果这一拍里点的是下拉建议，它会把 open 关掉；
         真的是点到别处，就把没提交的字收成标签 —— 主人反馈过
         「点了其他地方这个标签又变成空白」，这里不让它白打。 */
      setTimeout(function () {
        if (!self._alive) return;
        var draft = self.state.draft;
        if (draft && draft.trim()) self.add(draft);
        self.setState({ draft: '', open: false });
      }, 120);
    },

    focusInput: function () {
      if (this._input) this._input.focus();
    },

    /* ---------- 渲染 ---------- */
    render: function () {
      var self = this;
      var list = this.read();
      var draft = this.state.draft;
      var opts = optionList(this.props.field);

      /* 下拉建议：排除已选的；打了字就按输入内容过滤 */
      var sugg = opts.filter(function (o) {
        if (list.indexOf(o.value) !== -1) return false;
        if (!draft) return true;
        return o.value.toLowerCase().indexOf(draft.toLowerCase()) !== -1;
      });

      /* ① 已选标签，每颗带一个 × */
      var chips = list.map(function (t) {
        return h('span', { className: 'tgw-chip', key: 'c:' + t },
          h('span', { className: 'tgw-chip-text' }, t),
          h('button', {
            type: 'button',
            className: 'tgw-chip-x',
            title: '删掉「' + t + '」',
            'aria-label': '删掉标签 ' + t,
            tabIndex: -1,
            onClick: function (e) { e.preventDefault(); e.stopPropagation(); self.remove(t); },
          }, '×')
        );
      });

      /* ② 输入框（回车新增就靠它） */
      chips.push(h('input', {
        key: 'input',
        id: this.props.forID,
        ref: function (el) { self._input = el; },
        className: 'tgw-input',
        type: 'text',
        value: draft,
        placeholder: list.length ? '继续加…（回车确认）' : '打字后按回车就新增，比如：插画',
        autoComplete: 'off',
        spellCheck: false,
        onChange: this.handleInput,
        onKeyDown: this.handleKeyDown,
        onFocus: this.handleFocus,
        onBlur: this.handleBlur,
      }));

      /* ③ 下拉建议 */
      var drop = null;
      if (this.state.open && sugg.length) {
        drop = h('div', { className: 'tgw-drop', key: 'drop' },
          sugg.map(function (o, i) {
            return h('div', {
              className: 'tgw-opt' + (i === 0 ? ' tgw-opt-first' : ''),
              key: 'o:' + o.value,
              /* mousedown 拦一下：别让输入框先失焦，否则会触发「未提交自动收」 */
              onMouseDown: self.keepFocus,
              onClick: function () { self.pickOption(o.value); },
            }, o.label);
          })
        );
      }

      return h('div', { className: 'tgw-wrap' },
        h('div', {
          className: String(this.props.classNameWrapper || '') + ' tgw-box',
          onClick: this.focusInput,
        }, chips.concat(drop ? [drop] : [])),
        list.length
          ? h('div', { className: 'tgw-count' }, '共 ' + list.length + ' 个标签')
          : null
      );
    },

    /* Decap 会在校验时调它；字段是 required 就要求至少一个 */
    isValid: function () {
      var field = this.props.field;
      var required = field && typeof field.get === 'function' ? field.get('required') : false;
      if (required && this.read().length === 0) {
        var label = (field.get('label') || field.get('name') || '标签') + ' 至少填一个';
        return { error: { message: label } };
      }
      return { error: false };
    },
  });

  /* 预览区（右侧那一栏）显示成 #标签 列表 */
  var TagsPreview = createClass({
    render: function () {
      var list = toArray(this.props.value);
      if (!list.length) return null;
      return h('ul', { className: 'tgw-preview' },
        list.map(function (t, i) { return h('li', { key: i }, '#' + t); })
      );
    },
  });

  /* ============================================================
     三、样式（tgw- 前缀，避免和 Decap 自己的样式打架）
     * 关键：标签框直接套 Decap 给的 classNameWrapper，
     *   边框、内边距、聚焦变蓝这些就自动融入后台，不必自己仿。
     ============================================================ */
  (function injectStyle() {
    if (document.getElementById('tgw-style')) return;
    var css = [
      '.tgw-wrap{position:relative;}',

      /* 标签框：覆盖 classNameWrapper 的 display:block，改成能装 chip 的弹性行 */
      '.tgw-box{display:flex;flex-wrap:wrap;align-items:center;gap:6px;min-height:46px;cursor:text;}',

      /* 单颗标签 */
      '.tgw-chip{display:inline-flex;align-items:center;gap:2px;max-width:100%;',
      'background:#eef2ff;border:1px solid #c7d2fe;border-radius:999px;',
      'padding:2px 3px 2px 10px;font-size:13px;line-height:1.6;color:#3730a3;}',
      '.tgw-chip-text{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',

      /* 每颗标签的删除按钮 */
      '.tgw-chip-x{border:0;background:transparent;cursor:pointer;padding:0 5px;',
      'border-radius:999px;font-size:15px;line-height:1;color:#6366f1;',
      'font-family:inherit;transition:background .12s,color .12s;}',
      '.tgw-chip-x:hover{background:#c7d2fe;color:#312e81;}',
      '.tgw-chip-x:focus{outline:2px solid #a5b4fc;outline-offset:1px;}',

      /* 输入框：融进框里，不要自己的边框 */
      '.tgw-input{flex:1 1 120px;min-width:110px;border:0;outline:0;background:transparent;',
      'font-size:14px;color:inherit;font-family:inherit;padding:6px 2px;line-height:1.5;}',
      '.tgw-input::placeholder{color:#9aa3b2;}',

      /* 下拉建议 */
      '.tgw-drop{position:absolute;left:0;right:0;top:calc(100% + 4px);z-index:40;',
      'background:#fff;border:1px solid #dfe3e8;border-radius:6px;',
      'box-shadow:0 8px 24px rgba(15,23,42,.14);max-height:220px;overflow:auto;padding:4px 0;}',
      '.tgw-opt{padding:8px 14px;font-size:14px;color:#31373f;cursor:pointer;}',
      '.tgw-opt:hover,.tgw-opt-first:hover{background:#eef2ff;color:#3730a3;}',

      /* 计数小字 */
      '.tgw-count{padding:6px 0 0;font-size:12px;color:#7b8794;}',

      /* 预览区 */
      '.tgw-preview{list-style:none;margin:0;padding:0;display:flex;flex-wrap:wrap;gap:6px;}',
      '.tgw-preview li{background:#eef2ff;color:#3730a3;border-radius:999px;',
      'padding:2px 10px;font-size:13px;}',
    ].join('');

    var el = document.createElement('style');
    el.id = 'tgw-style';
    el.textContent = css;
    document.head.appendChild(el);
  })();

  /* ============================================================
     四、注册给 Decap
     （刻意不传 schema：字段配置里还有 required / default / hint / options，
       传了反而要逐个声明，容易漏；不传则不额外约束字段配置。）
     ============================================================ */
  window.CMS.registerWidget('tags', TagsControl, TagsPreview);
  window.__tagsWidgetReady = true;
  console.log('[tags-widget] 自定义标签控件已注册（widget: tags）');
})();
