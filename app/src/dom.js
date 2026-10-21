/* =============================================================================
   dom.js · 极简 DOM / 格式化 / 焦点 工具（无依赖，file:// 可直接运行）
   ========================================================================== */
(function () {
  const XJ = (window.XJ = window.XJ || {});

  /* ---------- 元素构造 ---------- */
  function h(tag, props, ...children) {
    const el = document.createElement(tag);
    if (props) {
      for (const [k, v] of Object.entries(props)) {
        if (v === null || v === undefined || v === false) continue;
        if (k === "class" || k === "className") el.className = v;
        else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
        else if (k === "dataset") Object.assign(el.dataset, v);
        else if (k === "html") el.innerHTML = v;
        else if (k.startsWith("on") && typeof v === "function") {
          el.addEventListener(k.slice(2).toLowerCase(), v);
        } else if (k === "text") el.textContent = v;
        else el.setAttribute(k, v === true ? "" : v);
      }
    }
    append(el, children);
    return el;
  }

  function append(el, children) {
    for (const c of children.flat(Infinity)) {
      if (c === null || c === undefined || c === false) continue;
      el.appendChild(c.nodeType ? c : document.createTextNode(String(c)));
    }
  }

  function svg(tag, attrs, ...children) {
    const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v === null || v === undefined || v === false) continue;
        el.setAttribute(k, v);
      }
    }
    for (const c of children.flat(Infinity)) {
      if (c === null || c === undefined || c === false) continue;
      el.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    }
    return el;
  }

  /* ---------- 值处理 ---------- */
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  /** 依 RFC 9562 的形态生成 v7 风格 id（时间有序）—— §9.1.3 幂等键 / client_msg_id */
  function uuidv7() {
    const ts = Date.now().toString(16).padStart(12, "0");
    const rnd = () => Math.floor(Math.random() * 0x10000).toString(16).padStart(4, "0");
    return `${ts.slice(0, 8)}-${ts.slice(8, 12)}-7${rnd().slice(0, 3)}-${(
      0x8000 +
      Math.floor(Math.random() * 0x4000)
    )
      .toString(16)
      .padStart(4, "0")}-${rnd()}${rnd()}${rnd()}`;
  }

  const uid = (p) => (p || "id") + "_" + Math.random().toString(36).slice(2, 9);

  function fmtRel(ts) {
    const d = Date.now() - ts;
    if (d < 45e3) return "刚刚";
    if (d < 60e3) return "1 分钟前";
    if (d < 3600e3) return Math.floor(d / 60e3) + " 分钟前";
    if (d < 86400e3) return Math.floor(d / 3600e3) + " 小时前";
    return Math.floor(d / 86400e3) + " 天前";
  }

  function fmtClock(ts) {
    const d = new Date(ts);
    return (
      String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0")
    );
  }

  function fmtBytes(n) {
    if (n < 1024) return n + " B";
    if (n < 1024 * 1024) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + " KB";
    return (n / 1024 / 1024).toFixed(1) + " MB";
  }

  function fmtDuration(ms) {
    const s = Math.round(ms / 1000);
    if (s < 60) return s + "s";
    const m = Math.floor(s / 60);
    if (m < 60) return m + "m" + String(s % 60).padStart(2, "0") + "s";
    return Math.floor(m / 60) + "h" + String(m % 60).padStart(2, "0") + "m";
  }

  const truncate = (s, n) => (String(s).length > n ? String(s).slice(0, n - 1) + "…" : String(s));

  function wait(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  /* ---------- 提示 ----------
     toast 只在 ui.js 里有一份（带队列与去重），这里不再重复实现。 */

  XJ.dom = {
    h,
    svg,
    clamp,
    uuidv7,
    uid,
    fmtRel,
    fmtClock,
    fmtBytes,
    fmtDuration,
    truncate,
    wait,
  };
})();
