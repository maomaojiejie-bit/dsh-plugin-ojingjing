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

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  function clear(el) {
    while (el && el.firstChild) el.removeChild(el.firstChild);
    return el;
  }

  /* ---------- 值处理 ---------- */
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const noop = () => {};

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

  /** 只保留路径末两段 —— §8.6「含路径时只显示末两段」 */
  function tailPath(p, segs = 2) {
    const parts = String(p).split(/[\\/]/).filter(Boolean);
    return parts.slice(-segs).join("/");
  }

  const truncate = (s, n) => (String(s).length > n ? String(s).slice(0, n - 1) + "…" : String(s));

  const esc = (s) =>
    String(s).replace(
      /[&<>"']/g,
      (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
    );

  /* ---------- 焦点守恒：重渲染时保住输入焦点与光标 ---------- */
  let focusSeq = 0;
  function markFocus(root) {
    $$("[data-focus]", root).forEach((el) => {
      if (!el.dataset.focusId) el.dataset.focusId = "f" + ++focusSeq;
    });
  }

  function snapshotFocus() {
    const a = document.activeElement;
    if (!a || !a.dataset || !a.dataset.focusId) {
      return null;
    }
    return {
      id: a.dataset.focusId,
      start: typeof a.selectionStart === "number" ? a.selectionStart : null,
      end: typeof a.selectionEnd === "number" ? a.selectionEnd : null,
      value: "value" in a ? a.value : null,
    };
  }

  function restoreFocus(snap) {
    if (!snap) return;
    const el = document.querySelector(`[data-focus-id="${snap.id}"]`);
    if (!el) return;
    el.focus({ preventScroll: true });
    if (snap.start !== null && typeof el.setSelectionRange === "function") {
      try {
        el.setSelectionRange(snap.start, snap.end);
      } catch (_) {}
    } else if (snap.value !== null && "value" in el && el.value !== snap.value) {
      // 不覆盖用户正在输入的内容
    }
  }

  /** 包裹一次重渲染，自动平移焦点 */
  function withFocus(fn) {
    const snap = snapshotFocus();
    fn();
    restoreFocus(snap);
  }

  const prefersReducedMotion = () =>
    document.documentElement.dataset.motion === "off" ||
    (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);

  function wait(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  /* ---------- Toast（§6.3 反馈覆盖） ---------- */
  function toast(message, opts) {
    const o = Object.assign({ type: "info", action: null, duration: 3200 }, opts || {});
    const layer = document.getElementById("toast-layer");
    if (!layer) return;
    const el = h(
      "div",
      { class: "toast toast--" + o.type, role: "status", "aria-live": "polite" },
      h("span", { class: "toast__dot" }),
      h("span", { class: "toast__msg" }, message),
      o.action
        ? h(
            "button",
            {
              class: "toast__action",
              onclick: () => {
                o.action.onClick && o.action.onClick();
                remove();
              },
            },
            o.action.label
          )
        : null
    );
    layer.appendChild(el);
    requestAnimationFrame(() => el.classList.add("is-in"));
    let done = false;
    const remove = () => {
      if (done) return;
      done = true;
      el.classList.remove("is-in");
      setTimeout(() => el.remove(), 220);
    };
    setTimeout(remove, o.duration);
    return remove;
  }

  /* ---------- 简易节流 / 防抖 ---------- */
  function throttle(fn, ms) {
    let last = 0,
      timer = null,
      lastArgs = null;
    return function (...args) {
      const now = Date.now();
      lastArgs = args;
      if (now - last >= ms) {
        last = now;
        fn.apply(this, args);
      } else if (!timer) {
        timer = setTimeout(() => {
          timer = null;
          last = Date.now();
          fn.apply(this, lastArgs);
        }, ms - (now - last));
      }
    };
  }

  function debounce(fn, ms) {
    let t = null;
    return function (...args) {
      clearTimeout(t);
      t = setTimeout(() => fn.apply(this, args), ms);
    };
  }

  /* ---------- 键盘可达：焦点陷阱（面板/对话框） ---------- */
  function trapFocus(container) {
    function onKey(e) {
      if (e.key !== "Tab") return;
      const items = $$(
        'button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
        container
      ).filter((el) => el.offsetParent !== null || el === document.activeElement);
      if (!items.length) return;
      const first = items[0],
        last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
    container.addEventListener("keydown", onKey);
    return () => container.removeEventListener("keydown", onKey);
  }

  XJ.dom = {
    h,
    svg,
    append,
    $,
    $$,
    clear,
    clamp,
    noop,
    uuidv7,
    uid,
    fmtRel,
    fmtClock,
    fmtBytes,
    fmtDuration,
    tailPath,
    truncate,
    esc,
    markFocus,
    snapshotFocus,
    restoreFocus,
    withFocus,
    prefersReducedMotion,
    wait,
    toast,
    throttle,
    debounce,
    trapFocus,
  };
})();
