/* eslint-disable */
/* global CMS */
/**
 * imgbed-media.js —— 让 Decap CMS 的「上传」把图片传到自建图床，而不是塞进 Git 仓库
 * ============================================================================
 *
 * 【它解决什么】
 *   默认情况下，后台点「上传」会把图片写进仓库的 assets/images/，用得越久仓库越大。
 *   这个文件把「上传」这份活儿整个交给图床：图片进图床，仓库里只留一行图片网址。
 *
 * 【怎么和 Decap 对接】
 *   Decap 走的是它自己的「外部媒体库」接口（和官方的 Cloudinary / Uploadcare 同一套）：
 *
 *     CMS.registerMediaLibrary({
 *       name: 'xxx',
 *       init: ({ options, handleInsert }) => ({
 *         show({ id, value, config, allowMultiple, imagesOnly }) {},
 *         hide() {},
 *         enableStandalone() { return true }
 *       })
 *     })
 *
 *   要点（都是从 decap-cms 源码里核对过的，别凭印象改）：
 *     · init 收到的是 **options**，内容就是 config.yml 里 media_library 那一整块，
 *       所以自定义设置要写在 media_library.config 下面，这里用 options.config 取。
 *     · show() 没有返回值 —— 选中图片后要靠 **handleInsert(url)** 把结果交回 Decap。
 *       传数组表示一次插入多张（配合 allowMultiple）。
 *     · 只实现 show / hide / enableStandalone 就够了，其余方法 Decap 自带兜底空函数。
 *
 * 【为什么这里可以回填「完整网址」】
 *   Decap 拿到 handleInsert 的路径后会过一遍 selectMediaFilePublicPath() 去换算
 *   media_folder → public_folder。官方 Cloudinary 库回填的就是
 *   https://res.cloudinary.com/... 这种完整 URL，所以完整 URL 能原样保留、不会被
 *   拼上 /assets/images/ 前缀。这里沿用同样的做法。
 *
 * 【上传认证】
 *   图床开了「上传认证」后，没有码就传不上去（返回 401）。这个码**不能**写进
 *   config.yml —— /admin/config.yml 是公开可读的，写进去等于把码公开，认证就白开了。
 *   所以码存在主人这台浏览器的 localStorage 里，面板上有输入框可以随时改。
 *
 *   ⚠️ 传递方式必须是**查询串**（POST /upload?authCode=xxx）。
 *   用请求头会踩 CORS 预检这个坑：带自定义头 = 非简单请求 = 浏览器先发 OPTIONS，
 *   而图床的预检响应只放行 Content-Type / Authorization，**不含 authCode**
 *   → 预检失败 → 真正的 POST 根本发不出去，页面上只看到一个莫名的失败。
 *   放查询串属于简单请求，不触发预检，跨域直接通。详见 uploadFile() 的注释。
 *
 * 【上传前压缩：一律转 webp，尺寸不变】（2026-09-19 主人拍板）
 *   原来写的是「原图直传、不改格式」，但实测主人这台机器的**上行只有 ~200KB/s**
 *   （拿 Cloudflare 官方测速端点 speed.cloudflare.com/__up 量的：4.21MB 用了 21.7 秒，
 *     同一时刻传到图床 4.21MB 用 23 秒 —— 也就是说那 20 多秒几乎全是「把字节送出去」，
 *     图床本身只占一两秒，换任何图床都一样）。一张 4.2MB 的插画就是要等 22 秒，
 *   主人反馈「卡很久，影响体验了」。
 *   而主人的插画是大色块风格，PNG 对它极不划算 —— 拿图床里真实的三张量过：
 *       1小时.png   3496x2480  4184KB → webp q92 同尺寸  385KB（9%）
 *       1.png       2480x3508  2444KB → webp q92 同尺寸  284KB（12%）
 *       伊吹8.2.png 1384x2501   611KB → webp q92 同尺寸   80KB（13%）
 *   所以在浏览器里先转 webp（**尺寸一个像素都不动**）再传：22 秒 → 2 秒。
 *
 *   ⚠️ 下面几条是兜底，别删（任何一条丢了都可能让主人传不上图）：
 *     · GIF（会丢动画）、SVG（矢量转栅格失真，而且本来就小）、已经是 webp 的 → 原样传
 *     · 转完**没有更小** → 原样传（不能把本来就好好的图转坏）
 *     · canvas 转不动（超大图 / 解码失败 / 老浏览器）→ 原样传
 *     · 再造 File 时**必须带上原来的 lastModified** —— auto-date.js 靠它填「发布日期」
 */
(function () {
  'use strict';

  if (!window.CMS || typeof window.CMS.registerMediaLibrary !== 'function') {
    console.error('[imgbed] 找不到 window.CMS，媒体库没注册。请检查 admin/index.html 的加载顺序。');
    return;
  }

  /* 图床默认地址；config.yml 里 media_library.config.base 可以覆盖 */
  var DEFAULT_BASE = 'https://cloudflare-imgbed-bnw.pages.dev';

  var RECENT_KEY = 'imgbed_recent_v1';
  var RECENT_MAX = 30;

  /* 上传前压缩用的 webp 质量。0.92 是实测过的：主人插画是大色块风格，
     同尺寸下肉眼与 PNG 看不出差别，体积却只有 9%~13%。往下调会开始出现色带。 */
  var WEBP_QUALITY = 0.92;

  /* 上传超时：主人的上行只有 ~200KB/s，大图慢是正常的，这里只兜「彻底卡死」。
     数据发完到图床回包之间不会推进度条，所以这个值要宽裕一点。 */
  var UPLOAD_TIMEOUT_MS = 180000;

  /* 要盖住 Decap 自己的弹层（它的层级在几百量级，官方 Cloudinary 用的是 99999） */
  var Z = 999999;

  /* ============================================================
     一、通用小工具
     ============================================================ */

  function el(tag, className, text) {
    var n = document.createElement(tag);
    if (className) n.className = className;
    if (text != null) n.textContent = text;
    return n;
  }

  function style(node, obj) {
    for (var k in obj) {
      if (Object.prototype.hasOwnProperty.call(obj, k)) node.style[k] = obj[k];
    }
    return node;
  }

  function humanSize(bytes) {
    if (!bytes && bytes !== 0) return '';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' KB';
    return (bytes / 1024 / 1024).toFixed(1) + ' MB';
  }

  /* 只放行 http(s)，挡掉 javascript: 之类的地址被塞进 img.src */
  function isHttpUrl(u) {
    return /^https?:\/\//i.test(String(u || ''));
  }

  function absUrl(base, src) {
    if (isHttpUrl(src)) return src;
    if (!src) return '';
    return base + (src.charAt(0) === '/' ? '' : '/') + src;
  }

  /* 从完整网址里抠出文件名，用于展示 */
  function fileNameOf(url) {
    try {
      var p = url.split('?')[0].split('#')[0].split('/');
      return decodeURIComponent(p[p.length - 1] || '');
    } catch (e) {
      return url;
    }
  }

  /*
   * 面板里的小缩略图一律走 wsrv.nl 现缩（和前端页面同一套做法，见 index.html 的
   * thumbImageUrl）—— 卡片最窄 112px，给 240px 够 2 倍屏。
   *
   * ⚠️⚠️ 千万别改回 img.src = item.url 直连原图：
   *   「最近上传」最多存 30 条（RECENT_MAX），而主人图床里的插画单张 0.6~4.2MB。
   *   直连原图 = 打开一次面板就下几十 MB，在 ~200KB/s 的宽带上直接把面板卡死。
   *   主人报的「卡很久」，有一份就来自这里（和大图上传是两个独立原因）。
   */
  var THUMB_PROXY = 'https://wsrv.nl/?url=';
  var THUMB_W = 240;

  function thumbUrl(u) {
    var s = String(u || '');
    if (!isHttpUrl(s)) return s;
    if (/^https?:\/\/wsrv\.nl\//i.test(s)) return s;      /* 已经是代理地址，别套娃 */
    return THUMB_PROXY + encodeURIComponent(s) + '&w=' + THUMB_W + '&output=webp&q=80';
  }

  /* ============================================================
     二、最近上传（存在浏览器本地，换设备不同步）
     ------------------------------------------------------------
     图床的「列出全部图片」接口要登录，所以这里不依赖后端：
     主人自己在这台电脑传过的图，记在 localStorage 里，下次可以直接点。
     ============================================================ */

  function loadRecent() {
    try {
      var arr = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
      return Array.isArray(arr) ? arr : [];
    } catch (e) {
      return [];
    }
  }

  function pushRecent(item) {
    try {
      var arr = loadRecent().filter(function (x) {
        return x && x.url !== item.url;
      });
      arr.unshift(item);
      localStorage.setItem(RECENT_KEY, JSON.stringify(arr.slice(0, RECENT_MAX)));
    } catch (e) {
      /* localStorage 满了或被禁用，忽略即可，不影响上传 */
    }
  }

  /* ============================================================
     三、认证码（只存在这台浏览器，不进仓库）
     ------------------------------------------------------------
     ⚠️ 为什么不写进 config.yml：/admin/config.yml 是公开可读的，谁都能打开看。
     认证码放在那里等于公开，认证就白开了。
     所以码只保存在主人自己这台电脑的 localStorage 里。
     ============================================================ */

  var AUTH_KEY = 'imgbed_auth_v1';

  function loadAuth() {
    try {
      return localStorage.getItem(AUTH_KEY) || '';
    } catch (e) {
      return '';
    }
  }

  function saveAuth(code) {
    try {
      if (code) localStorage.setItem(AUTH_KEY, code);
      else localStorage.removeItem(AUTH_KEY);
    } catch (e) {
      /* localStorage 被禁用或写满，忽略即可，不影响不带认证的场景 */
    }
  }

  /* ============================================================
     四、上传

     4.0 上传前压缩（转 webp）
     4.1 真正传上去
     ============================================================ */

  /* ---------- 4.0 上传前压缩 ---------- */

  /*
   * 哪些文件不该转：
   *   · GIF  —— canvas 只取第一帧，动图会变成静图
   *   · SVG  —— 矢量，转栅格会失真，而且本来就几 KB
   *   · webp —— 已经是了
   * 其余图片（png / jpg / bmp …）都转。
   */
  function shouldConvert(file) {
    var t = String(file.type || '').toLowerCase();
    if (t === 'image/gif') return false;
    if (t === 'image/svg+xml') return false;
    if (t === 'image/webp') return false;
    return /^image\//.test(t);
  }

  function renameToWebp(name) {
    var s = String(name || 'image');
    var m = /^(.*)\.[^.\/\\]+$/.exec(s);
    return (m ? m[1] : s) + '.webp';
  }

  /* Chrome 的 canvas 单边上限是 16384；再往上还有总面积限制。
     超过就干脆别转，原样传 —— 宁可慢，也不能传不上去。 */
  var CANVAS_MAX_SIDE = 16384;

  /**
   * 把一张图转成同尺寸的 webp。
   * @returns {Promise<Blob|null>} 失败/不该转时给 null，调用方原样传
   */
  function toWebp(file) {
    return new Promise(function (resolve) {
      if (typeof createImageBitmap !== 'function' && typeof window.Image !== 'function') {
        resolve(null);
        return;
      }
      var url = '';
      var done = false;
      function finish(blob) {
        if (done) return;
        done = true;
        try { if (url) URL.revokeObjectURL(url); } catch (e) { /* ignore */ }
        resolve(blob || null);
      }

      var img = new Image();
      img.onload = function () {
        try {
          var w = img.naturalWidth || img.width || 0;
          var h = img.naturalHeight || img.height || 0;
          if (!w || !h || w > CANVAS_MAX_SIDE || h > CANVAS_MAX_SIDE) {
            finish(null);
            return;
          }
          var c = document.createElement('canvas');
          c.width = w;               /* ★ 尺寸原样，只换编码 */
          c.height = h;
          var ctx = c.getContext('2d');
          if (!ctx || typeof c.toBlob !== 'function') {
            finish(null);
            return;
          }
          /* 主人的插画有些是带透明背景的 PNG，白色底会把透明区涂死 */
          ctx.drawImage(img, 0, 0, w, h);
          c.toBlob(function (blob) { finish(blob); }, 'image/webp', WEBP_QUALITY);
        } catch (e) {
          finish(null);
        }
      };
      img.onerror = function () { finish(null); };

      try {
        url = URL.createObjectURL(file);
        img.src = url;
      } catch (e) {
        finish(null);
      }
    });
  }

  /**
   * 决定这张图实际要传哪个 File。
   * @returns {Promise<{file:File, converted:boolean, before:number, after:number}>}
   */
  function prepareFile(file) {
    var passthrough = { file: file, converted: false, before: file.size, after: file.size };
    if (!shouldConvert(file)) return Promise.resolve(passthrough);

    return toWebp(file).then(function (blob) {
      /* 没转出来、或者转完反而更大 → 原样传 */
      if (!blob || !blob.size || blob.size >= file.size) return passthrough;
      var nf;
      try {
        /*
         * ★ lastModified 必须沿用原文件的 —— auto-date.js 拿它当「作品日期」
         *   （对补发旧作品来说这才是主人要的），丢了就退化成"今天"。
         */
        nf = new File([blob], renameToWebp(file.name), {
          type: 'image/webp',
          lastModified: file.lastModified || Date.now(),
        });
      } catch (e) {
        return passthrough;
      }
      return { file: nf, converted: true, before: file.size, after: nf.size };
    }).catch(function () {
      return passthrough;
    });
  }

  /* ---------- 4.1 真正传上去 ---------- */

  /**
   * @param {Object} cfg   形如 {base, upload_channel, folder, auth_code, auth_code_config}
   * @param {File}   file
   * @param {Function} onProgress 0~1
   * @returns {Promise<{url:string}>}
   */
  function uploadFile(cfg, file, onProgress) {
    return new Promise(function (resolve, reject) {
      var fd = new FormData();
      fd.append('file', file);
      if (cfg.upload_channel) fd.append('uploadChannel', cfg.upload_channel);
      if (cfg.folder) fd.append('uploadFolder', cfg.folder);

      /*
       * ★ 认证码走**查询串**，不能用 setRequestHeader。
       *
       * 实测（这台图床的 CORS 配置）：
       *   OPTIONS /upload → 204，Allow-Headers: Content-Type, Authorization
       *   ——里面**没有 authCode**。所以一旦带自定义头，浏览器发的预检会被拒，
       *   POST 连发都发不出去，页面上只看到一个说不清的失败。
       * 放查询串则属于 CORS「简单请求」，不触发预检，跨域直接通。
       *
       * 顺带排除掉的其他写法（都实测返回 401）：
       *   · 头 Authorization: <码> / Bearer <码> / Basic base64(<码>:)   ← 它不认这个头
       *   · 表单字段 authCode                                          ← 只从查询串/头里取
       * 唯一可行的两条：查询串 ?authCode=xxx（这里用的），或带浏览器 UA 直连时用 authCode 头。
       */
      var url =
        cfg.base + '/upload' +
        (cfg.auth_code ? '?authCode=' + encodeURIComponent(cfg.auth_code) : '');

      var xhr = new XMLHttpRequest();
      xhr.open('POST', url, true);

      /* 兜「彻底卡死」。主人的上行只有 ~200KB/s，大图慢是正常的，
         所以这个值给得宽裕（见 UPLOAD_TIMEOUT_MS）。 */
      xhr.timeout = UPLOAD_TIMEOUT_MS;

      /* 用来区分超时超在哪一段：字节发完了 / 还没发完 */
      var sentAll = false;

      if (xhr.upload && onProgress) {
        xhr.upload.onprogress = function (e) {
          if (!e.lengthComputable) return;
          if (e.loaded >= e.total) sentAll = true;
          onProgress(e.loaded / e.total, e.loaded, e.total);
        };
      }

      xhr.onload = function () {
        var text = xhr.responseText || '';
        if (xhr.status < 200 || xhr.status >= 300) {
          var err = new Error(
            xhr.status === 401
              ? '图床要求认证码（HTTP 401）'
              : '图床返回 HTTP ' + xhr.status + (text ? '：' + text.slice(0, 200) : '')
          );
          /* 带上状态码，面板据此把「认证码」那一栏高亮出来提示主人补填 */
          err.status = xhr.status;
          reject(err);
          return;
        }
        var data;
        try {
          data = JSON.parse(text);
        } catch (e) {
          reject(new Error('图床返回的不是 JSON：' + text.slice(0, 200)));
          return;
        }
        /* 实测返回形如 [{"src":"/file/1789xxx_name.png"}]，兼容单个对象的情况 */
        var item = Array.isArray(data) ? data[0] : data;
        if (!item || !item.src) {
          reject(new Error('图床返回里没有 src 字段：' + text.slice(0, 200)));
          return;
        }
        var url = absUrl(cfg.base, item.src);
        if (onProgress) onProgress(1);
        resolve({ url: url, name: fileNameOf(url), size: file.size });
      };

      xhr.onerror = function () {
        reject(new Error('连不上图床，检查网络或图床地址是否可访问：' + cfg.base));
      };
      xhr.ontimeout = function () {
        var sec = Math.round(UPLOAD_TIMEOUT_MS / 1000);
        reject(new Error(sentAll
          ? '数据已经传完，但图床 ' + sec + ' 秒都没回话（图床那边可能在排队或转存，稍后再试）'
          : '上传超时：数据还没传完（等了 ' + sec + ' 秒）。网络可能断了，重试一次。'));
      };

      xhr.send(fd);
    });
  }

  /* ============================================================
     五、面板样式（全部加 ibd- 前缀，避免和 Decap 的样式打架）
     ============================================================ */

  var STYLE_ID = 'imgbed-media-style';

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var s = document.createElement('style');
    s.id = STYLE_ID;
    s.textContent = [
      '.ibd-mask{position:fixed;inset:0;z-index:' + Z + ';background:rgba(15,23,42,.55);',
      'display:flex;align-items:center;justify-content:center;padding:24px;',
      'font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;}',

      '.ibd-panel{width:min(860px,100%);max-height:min(86vh,860px);overflow:auto;background:#fff;',
      'border-radius:16px;box-shadow:0 24px 70px rgba(15,23,42,.4);display:flex;flex-direction:column;}',

      '.ibd-head{display:flex;align-items:center;gap:10px;padding:18px 22px;border-bottom:1px solid #e8ecf2;',
      'position:sticky;top:0;background:#fff;border-radius:16px 16px 0 0;z-index:2;}',
      '.ibd-title{font-size:16px;font-weight:700;color:#0f172a;flex:1;}',
      '.ibd-sub{font-size:12px;color:#7c889b;font-weight:400;margin-left:8px;}',
      '.ibd-x{border:0;background:#f1f4f9;color:#526079;width:30px;height:30px;border-radius:9px;',
      'font-size:17px;line-height:1;cursor:pointer;flex:none;}',
      '.ibd-x:hover{background:#e4e9f2;}',

      '.ibd-body{padding:20px 22px 26px;}',

      /* 认证码那一栏。图床要求认证时必须填，所以放在最上面、一眼能看到 */
      '.ibd-auth{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:11px 13px;',
      'border:1px solid #e3e9f2;border-radius:11px;background:#f8fafd;margin-bottom:16px;}',
      '.ibd-auth.ibd-auth-hl{border-color:#f0b429;background:#fffaf0;',
      'box-shadow:0 0 0 3px rgba(240,180,41,.16);}',
      '.ibd-auth-label{font-size:12px;font-weight:700;color:#526079;white-space:nowrap;}',
      '.ibd-auth-input{flex:1;min-width:130px;border:1px solid #d5ddea;border-radius:9px;',
      'padding:8px 11px;font-size:13px;color:#1e293b;background:#fff;outline:none;}',
      '.ibd-auth-input:focus{border-color:#6366f1;box-shadow:0 0 0 3px rgba(99,102,241,.14);}',
      '.ibd-auth .ibd-btn{padding:8px 14px;}',
      '.ibd-auth-state{font-size:11.5px;line-height:1.6;flex-basis:100%;}',
      '.ibd-auth-state.ok{color:#12673f;}',
      '.ibd-auth-state.warn{color:#a35b00;}',

      '.ibd-drop{border:2px dashed #c8d3e3;border-radius:13px;padding:26px 18px;text-align:center;',
      'background:#fafcff;transition:background .15s,border-color .15s;}',
      '.ibd-drop.ibd-over{background:#eef4ff;border-color:#7c9bf5;}',
      '.ibd-drop-main{font-size:14px;color:#33415c;font-weight:600;}',
      '.ibd-drop-sub{font-size:12px;color:#8592a8;margin-top:6px;line-height:1.7;}',
      '.ibd-pick{margin-top:14px;border:0;border-radius:10px;background:#6366f1;color:#fff;',
      'font-size:13px;font-weight:600;padding:11px 22px;cursor:pointer;}',
      '.ibd-pick:hover{background:#5a56e8;}',
      '.ibd-pick:disabled{background:#b9c3d6;cursor:default;}',

      '.ibd-row{display:flex;gap:9px;margin-top:18px;}',
      '.ibd-url{flex:1;min-width:0;border:1px solid #d5ddea;border-radius:10px;padding:11px 13px;',
      'font-size:13px;color:#1e293b;background:#fff;outline:none;}',
      '.ibd-url:focus{border-color:#6366f1;box-shadow:0 0 0 3px rgba(99,102,241,.14);}',
      '.ibd-btn{border:0;border-radius:10px;background:#eef2f9;color:#33415c;font-size:13px;',
      'font-weight:600;padding:11px 18px;cursor:pointer;white-space:nowrap;}',
      '.ibd-btn:hover{background:#e2e9f5;}',

      '.ibd-note{margin-top:12px;font-size:12px;line-height:1.75;border-radius:10px;padding:11px 13px;}',
      '.ibd-err{background:#fdeceb;color:#b3261e;border:1px solid #f7cdc9;}',
      '.ibd-ok{background:#e9f7ef;color:#12673f;border:1px solid #c4e6d3;}',
      '.ibd-progress{margin-top:14px;height:6px;border-radius:99px;background:#eef2f9;overflow:hidden;}',
      '.ibd-bar{height:100%;width:0;background:#6366f1;transition:width .18s;}',

      '.ibd-sec{margin-top:24px;font-size:12px;font-weight:700;color:#7c889b;letter-spacing:.04em;}',
      '.ibd-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(112px,1fr));gap:11px;margin-top:12px;}',
      '.ibd-card{border:2px solid transparent;border-radius:11px;overflow:hidden;background:#f5f7fb;',
      'cursor:pointer;position:relative;aspect-ratio:1/1;}',
      '.ibd-card:hover{border-color:#a9bdfb;}',
      '.ibd-card img{width:100%;height:100%;object-fit:cover;display:block;}',
      '.ibd-card span{position:absolute;left:0;right:0;bottom:0;font-size:10px;color:#fff;',
      'background:linear-gradient(transparent,rgba(0,0,0,.72));padding:12px 7px 5px;',
      'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
      '.ibd-empty{font-size:12px;color:#98a3b6;margin-top:10px;}'
    ].join('');
    document.head.appendChild(s);
  }

  /* ============================================================
     六、面板本体
     ============================================================ */

  /**
   * @param {Object} o
   * @param {Object}   o.cfg        解析后的配置
   * @param {boolean}  o.allowMultiple
   * @param {Function} o.onDone     收到最终选择，参数是 url 字符串或字符串数组
   * @returns {{close:Function}}
   */
  function openPanel(o) {
    ensureStyle();

    var cfg = o.cfg;
    var picked = []; // 允许多选时暂存
    var closed = false;

    var mask = el('div', 'ibd-mask');
    var panel = el('div', 'ibd-panel');

    /* ---------- 头部 ---------- */
    var head = el('div', 'ibd-head');
    var title = el('div', 'ibd-title', o.allowMultiple ? '选择图片（可多选）' : '选择图片');
    title.appendChild(el('span', 'ibd-sub', '图床：' + cfg.base.replace(/^https?:\/\//, '')));
    var btnX = el('button', 'ibd-x', '\u00d7');
    btnX.type = 'button';
    btnX.title = '关闭';
    head.appendChild(title);
    head.appendChild(btnX);

    /* ---------- 主体 ---------- */
    var body = el('div', 'ibd-body');

    /* ---------- 认证码 ----------
     * 图床开了「上传认证」后，没有码上传会返回 401。
     * 码不写进公开的 config.yml，只存在这台浏览器的 localStorage。
     * 放在最上面：没填的话下面做什么都白搭，得先让主人看见。 */
    var authFromConfig = !!cfg.auth_code_config;

    var authRow = el('div', 'ibd-auth');
    authRow.appendChild(el('span', 'ibd-auth-label', '🔑 图床认证码'));
    var authInput = el('input', 'ibd-auth-input');
    authInput.type = 'password';
    authInput.autocomplete = 'off';
    authInput.spellcheck = false;
    var btnAuth = el('button', 'ibd-btn', '保存');
    btnAuth.type = 'button';
    var authState = el('span', 'ibd-auth-state');
    authRow.appendChild(authInput);
    authRow.appendChild(btnAuth);
    authRow.appendChild(authState);

    function paintAuth() {
      var cur = loadAuth();
      authInput.value = cur;
      authInput.placeholder = authFromConfig
        ? '配置里已填，这里可覆盖'
        : '图床后台「用户端认证」里设的那个码';
      if (cur) {
        authState.className = 'ibd-auth-state ok';
        authState.textContent = '✓ 已保存在这台电脑（不会写进仓库）';
      } else if (authFromConfig) {
        authState.className = 'ibd-auth-state ok';
        authState.textContent = '✓ 用的是配置里的码';
      } else {
        authState.className = 'ibd-auth-state warn';
        authState.textContent = '尚未设置 —— 图床若要求认证，不填就会上传失败（401）';
      }
    }

    function applyAuth() {
      var v = (authInput.value || '').trim();
      saveAuth(v);
      authRow.classList.remove('ibd-auth-hl');
      paintAuth();
      say('ok', v
        ? '认证码已保存在这台电脑上（不会写进仓库），现在可以上传了。'
        : '已清除本机保存的认证码。');
    }

    btnAuth.onclick = applyAuth;
    authInput.onkeydown = function (e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        applyAuth();
      }
    };

    paintAuth();
    body.appendChild(authRow);

    /* 拖拽 + 选择文件 */
    var drop = el('div', 'ibd-drop');
    drop.appendChild(el('div', 'ibd-drop-main', '把图片拖到这里'));
    drop.appendChild(
      el('div', 'ibd-drop-sub', '或者点下面的按钮选文件，也可以直接 Ctrl+V 粘贴截图')
    );

    var fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = 'image/*';
    fileInput.multiple = !!o.allowMultiple;
    fileInput.style.display = 'none';

    var btnPick = el('button', 'ibd-pick', '选择图片上传');
    btnPick.type = 'button';

    drop.appendChild(btnPick);
    drop.appendChild(fileInput);
    body.appendChild(drop);

    /* 状态提示 */
    var note = el('div', 'ibd-note');
    note.style.display = 'none';
    var bar = el('div', 'ibd-bar');
    var progress = style(el('div', 'ibd-progress'), { display: 'none' });
    progress.appendChild(bar);

    function say(kind, msg) {
      note.className = 'ibd-note ' + (kind === 'err' ? 'ibd-err' : 'ibd-ok');
      note.textContent = msg;
      note.style.display = 'block';
    }

    function busy(on, ratio) {
      btnPick.disabled = !!on;
      btnPick.textContent = on ? '正在上传…' : '选择图片上传';
      progress.style.display = on ? 'block' : 'none';
      bar.style.width = on ? Math.round((ratio || 0) * 100) + '%' : '0';
    }

    /* 粘贴网址 */
    var row = el('div', 'ibd-row');
    var urlInput = el('input', 'ibd-url');
    urlInput.type = 'text';
    urlInput.placeholder = '也可以粘贴一条图片网址，按回车';
    var btnUrl = el('button', 'ibd-btn', '用这条网址');
    btnUrl.type = 'button';
    row.appendChild(urlInput);
    row.appendChild(btnUrl);

    function useUrl() {
      var v = (urlInput.value || '').trim();
      if (!v) return;
      if (!isHttpUrl(v)) {
        say('err', '网址需要以 http:// 或 https:// 开头。');
        return;
      }
      finish([{ url: v, name: fileNameOf(v) }]);
    }
    btnUrl.onclick = useUrl;
    urlInput.onkeydown = function (e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        useUrl();
      }
    };

    body.appendChild(row);
    body.appendChild(progress);
    body.appendChild(note);

    /* 最近上传 */
    var sec = el('div', 'ibd-sec', '这台电脑最近传过的图');
    var grid = el('div', 'ibd-grid');
    body.appendChild(sec);
    body.appendChild(grid);
    var empty = el('div', 'ibd-empty', '还没有记录。上传过的图会出现在这里，下次可以直接点。');
    body.appendChild(empty);

    function renderRecent() {
      var list = loadRecent();
      grid.innerHTML = '';
      empty.style.display = list.length ? 'none' : 'block';
      list.forEach(function (item) {
        var card = el('div', 'ibd-card');
        card.title = item.url;
        var img = document.createElement('img');
        img.loading = 'lazy';
        img.decoding = 'async';
        img.alt = item.name || '';
        img.src = thumbUrl(item.url);
        /* 代理挂了 / 缩图取不到 → 退回原图，绝不留破图标 */
        img.onerror = function () {
          if (img.getAttribute('src') !== item.url) img.setAttribute('src', item.url);
        };
        card.appendChild(img);
        card.appendChild(el('span', null, item.name || fileNameOf(item.url)));
        card.onclick = function () {
          finish([item]);
        };
        grid.appendChild(card);
      });
    }
    renderRecent();

    panel.appendChild(head);
    panel.appendChild(body);
    mask.appendChild(panel);
    document.body.appendChild(mask);

    /* ---------- 关闭 ---------- */
    function close() {
      if (closed) return;
      closed = true;
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('paste', onPaste, true);
      window.removeEventListener('dragover', stopNav, true);
      window.removeEventListener('drop', stopNav, true);
      if (mask.parentNode) mask.parentNode.removeChild(mask);
    }

    /* ---------- 收尾：把选择交回 Decap ---------- */
    function finish(items) {
      if (closed) return;
      var urls = items.map(function (x) {
        return x.url;
      });
      if (!urls.length) return;

      items.forEach(function (x) {
        pushRecent({ url: x.url, name: x.name || fileNameOf(x.url), at: Date.now() });
      });

      close();
      /* 多选并且确实选了多张 → 交数组；否则交单条字符串 */
      if (o.allowMultiple && urls.length > 1) o.onDone(urls);
      else o.onDone(urls[0]);
    }

    /* ---------- 真正上传 ---------- */
    function handleFiles(files) {
      /* 每次上传前重新取一次认证码：主人可能刚在面板里补填上 */
      cfg.auth_code = loadAuth() || cfg.auth_code_config || '';

      var imgs = Array.prototype.slice.call(files || []).filter(function (f) {
        return f && /^image\//.test(f.type);
      });
      if (!imgs.length) {
        say('err', '没有检测到图片文件。这个入口只接受图片（png / jpg / gif / webp / svg…）。');
        return;
      }
      if (!o.allowMultiple) imgs = imgs.slice(0, 1);

      var done = [];
      var failed = [];
      var authFailed = false;

      busy(true, 0);

      /* 串行上传：避免一次打十几个请求被图床/Cloudflare 拦掉 */
      var i = 0;
      function next() {
        if (i >= imgs.length) {
          busy(false);
          if (done.length) {
            say('ok', '上传成功 ' + done.length + ' 张' + (failed.length ? '，失败 ' + failed.length + ' 张' : ''));
            setTimeout(function () {
              finish(done);
            }, 260);
          } else if (authFailed) {
            /*
             * 401 = 图床开了上传认证，但码没填或不对。
             * 这种失败光说一句「上传失败」主人根本不知道该干什么，
             * 所以直接把认证码那一栏高亮 + 聚焦，让主人当场填。
             */
            say('err', '图床拒绝了上传（HTTP 401）：认证码不对或还没填。请在下面「🔑 图床认证码」里填上图床后台设置的那个码，点「保存」后重试。');
            authRow.classList.add('ibd-auth-hl');
            authInput.focus();
          } else {
            say('err', failed.length ? failed[0] : '上传失败');
          }
          renderRecent();
          return;
        }
        var f = imgs[i];
        var tag = (imgs.length > 1 ? (i + 1) + '/' + imgs.length + '：' : '') + f.name;
        say('ok', '正在准备 ' + tag + '（' + humanSize(f.size) + '）…');

        /* 压缩是异步的（解码 + 重编码），几千像素的插画约 1 秒 */
        prepareFile(f).then(function (prep) {
          var uf = prep.file;          /* 真正要传上去的那一个 */

          if (prep.converted) {
            say('ok', '已压缩 ' + humanSize(prep.before) + ' → ' + humanSize(prep.after) +
              '（同尺寸 webp）。正在上传…');
          } else {
            say('ok', '正在上传 ' + tag + '（' + humanSize(uf.size) + '）…');
          }

          var t0 = Date.now();
          var lastPaint = 0;
          var sentNotified = false;

          uploadFile(cfg, uf, function (ratio, loaded, total) {
            var now = Date.now();
            var isSent = loaded != null && total != null && loaded >= total;

            /*
             * 进度事件非常密（大文件一秒几十次），节流到 ~8fps。
             * 不然光为了显示进度就把主线程占满 —— 那就成了「治卡顿的东西自己卡」。
             */
            if (!isSent && now - lastPaint < 120) return;
            lastPaint = now;

            busy(true, (i + ratio) / imgs.length);
            if (loaded == null || total == null) return;

            if (isSent) {
              if (!sentNotified) {
                sentNotified = true;
                say('ok', '数据已传完（' + humanSize(total) + '），图床正在处理…');
              }
              return;
            }

            var sec = (Date.now() - t0) / 1000;
            if (sec < 0.6) return;       /* 刚开始那一下算出来的速度没意义 */
            var speed = loaded / sec;
            var left = speed > 0 ? Math.max(0, (total - loaded) / speed) : 0;
            say('ok', '正在上传 ' + tag + '　' + humanSize(loaded) + ' / ' + humanSize(total) +
              '（' + humanSize(speed) + '/s，约还需 ' + (left < 1 ? '不到 1' : Math.round(left)) + ' 秒）');
          }).then(
          function (res) {
            /* 单张时立刻收工，多张时攒齐再说 */
            done.push({ url: res.url, name: res.name || uf.name });

            /*
             * ★ 广播给 /admin/auto-date.js：把这张图片「自己在磁盘上的修改时间」
             *   交出去，用来自动填「发布日期」。
             *
             *   f.lastModified 是浏览器读文件时给的（毫秒时间戳），图片从电脑里
             *   选出来就带着 —— 对「补发以前的作品」来说，这才是主人想要的日期，
             *   图床文件名里那串时间戳只是上传时刻（永远是今天），没用。
             *
             *   ⚠️ 这里用**原始文件 f** 的 lastModified，不要用 uf（压缩产物）——
             *      uf 是我们自己 new File 造的，虽然也带了 f.lastModified，
             *      但直接用 f 最不容易出错。
             *
             *   广播失败也绝不能影响上传，所以整段包 try。
             */
            try {
              window.dispatchEvent(new CustomEvent('imgbed:uploaded', {
                detail: {
                  url: res.url,
                  name: res.name || uf.name,
                  lastModified: f.lastModified,
                  size: uf.size
                }
              }));
            } catch (e) { /* 老浏览器没有 CustomEvent，忽略 */ }

            if (!o.allowMultiple) {
              busy(false);
              say('ok', '上传成功：' + uf.name + (prep.converted
                ? '　' + humanSize(prep.before) + ' → ' + humanSize(prep.after)
                : ''));
              renderRecent();
              setTimeout(function () {
                finish(done);
              }, 260);
              return;
            }
            i++;
            next();
          },
          function (err) {
            if (err && err.status === 401) authFailed = true;
            failed.push((f.name || '') + '：' + (err && err.message ? err.message : err));
            i++;
            next();
          }
        );
        });
      }
      next();
    }

    /* ---------- 事件绑定 ---------- */
    btnX.onclick = close;
    mask.onclick = function (e) {
      if (e.target === mask) close();
    };
    btnPick.onclick = function () {
      fileInput.click();
    };
    fileInput.onchange = function () {
      handleFiles(fileInput.files);
      fileInput.value = '';
    };

    var depth = 0;
    drop.ondragenter = function (e) {
      e.preventDefault();
      depth++;
      drop.classList.add('ibd-over');
    };
    drop.ondragleave = function () {
      depth--;
      if (depth <= 0) {
        depth = 0;
        drop.classList.remove('ibd-over');
      }
    };
    drop.ondragover = function (e) {
      e.preventDefault();
    };
    drop.ondrop = function (e) {
      e.preventDefault();
      depth = 0;
      drop.classList.remove('ibd-over');
      if (e.dataTransfer && e.dataTransfer.files) handleFiles(e.dataTransfer.files);
    };

    /* 整页粘贴截图 */
    function onPaste(e) {
      var items = (e.clipboardData && e.clipboardData.items) || [];
      var files = [];
      for (var i = 0; i < items.length; i++) {
        if (items[i].kind === 'file') {
          var f = items[i].getAsFile();
          if (f) files.push(f);
        }
      }
      if (files.length) {
        e.preventDefault();
        handleFiles(files);
      }
    }

    function onKey(e) {
      if (e.key === 'Escape') close();
    }

    function stopNav(e) {
      /* 防止图片被拖到面板外面时浏览器直接把它当页面打开 */
      e.preventDefault();
    }

    document.addEventListener('keydown', onKey, true);
    document.addEventListener('paste', onPaste, true);
    window.addEventListener('dragover', stopNav, true);
    window.addEventListener('drop', stopNav, true);

    setTimeout(function () {
      btnPick.focus();
    }, 30);

    return { close: close };
  }

  /* ============================================================
     七、注册给 Decap
     ============================================================ */

  function init(args) {
    args = args || {};
    /* options 就是 config.yml 里 media_library 那一整块 */
    var options = args.options || {};
    var handleInsert = args.handleInsert;

    var globalCfg = options.config || {};

    var panelRef = null;

    return {
      show: function (callArgs) {
        callArgs = callArgs || {};
        /* 字段级 media_library.config 会覆盖全局设置 */
        /*
         * 认证码：
         *   首选这台浏览器 localStorage 里保存的（面板上随时能改），
         *   其次才是 config.yml 里显式写的——那是留给特殊场景的兜底，
         *   默认留空，因为 config.yml 是公开可读的，写进去等于公开。
         */
        var cfgAuth =
          String((callArgs.config && callArgs.config.auth_code) || globalCfg.auth_code || '');

        var cfg = {
          base: String(globalCfg.base || DEFAULT_BASE).replace(/\/+$/, ''),
          upload_channel: callArgs.config && callArgs.config.upload_channel != null
            ? callArgs.config.upload_channel
            : globalCfg.upload_channel || '',
          folder: callArgs.config && callArgs.config.folder != null
            ? callArgs.config.folder
            : globalCfg.folder || '',
          auth_code: loadAuth() || cfgAuth,
          auth_code_config: cfgAuth
        };

        if (panelRef) {
          panelRef.close();
          panelRef = null;
        }

        panelRef = openPanel({
          cfg: cfg,
          allowMultiple: !!callArgs.allowMultiple,
          onDone: function (result) {
            panelRef = null;
            if (typeof handleInsert === 'function') handleInsert(result);
          }
        });
      },

      hide: function () {
        if (panelRef) {
          panelRef.close();
          panelRef = null;
        }
      },

      onClearControl: function () {},

      onRemoveControl: function () {},

      /* false = 不在左侧导航里额外挂一个独立媒体库页面，只在字段的「上传」里出现 */
      enableStandalone: function () {
        return false;
      }
    };
  }

  window.CMS.registerMediaLibrary({ name: 'imgbed', init: init });
  /* 给 admin/index.html 一个「我准备好了」的信号，让它放心调用 CMS.init() */
  window.__imgbedMediaReady = true;
  console.log('[imgbed] 图床媒体库已注册（name: imgbed）');
})();
