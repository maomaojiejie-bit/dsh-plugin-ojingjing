/**
 * 哦鲸鲸 · 嵌入式宿主适配（运行在 DSH 页面里的 iframe 内）
 *
 * 两件事：
 *  1. 提供 XJ.embed / window.__XJ_EMBED_HARNESS__：把原来的 mock Harness 换成
 *     走 /xj/state + /xj/decide 的真实数据源；
 *  2. 每次渲染后把自己的尺寸 postMessage 给父页面，父页面据此缩放 iframe，
 *     这样只有哦鲸鲸覆盖的区域会挡住鼠标。
 */
(function () {
  const XJ = (window.XJ = window.XJ || {});
  const EMBED = /[?&]embed=1\b/.test(location.search);
  if (!EMBED) return;

  // 两种宿主：嵌在 DSH 页面里的 iframe（host=page），或独立桌面窗的 WebView2（host=app）
  const HOST = /[?&]host=app\b/.test(location.search) ? "app" : /[?&]host=py\b/.test(location.search) ? "py" : "page";
  const webview = window.chrome && window.chrome.webview;

  // 独立窗（Qt 外壳）两件事：
  //  1. 打上 xj-py：外壳里没有「假桌面」，样式需要区别对待；
  //  2. 外壳没拿到 GPU（ANGLE 走 WARP 软件光栅）时打上 xj-sw：styles.css 会把
  //     backdrop 模糊和装饰性循环动画关掉 —— 这两层在软件光栅下是掉帧主因。
  //     渲染模式由外壳在 DocumentCreation 阶段写进 window.__XJ_RENDER__（"hw" / "sw"）。
  if (HOST === "py") {
    document.documentElement.classList.add("xj-py");
    if (window.__XJ_RENDER__ === "sw") document.documentElement.classList.add("xj-sw");
  }

  /** 统一出口：独立窗给 WebView2 / Qt(QWebChannel) / pywebview，页面内给父窗口 */
  function post(message) {
    // Qt 外壳：QWebChannel 注入 window.xjNative；pywebview 外壳：window.pywebview.api
    const native = window.xjNative || (window.pywebview && window.pywebview.api);
    if (HOST === "py" && native) {
      try {
        // 打开外部链接（关于 / 检查更新）：交给外壳用系统浏览器开，只放行 https
        if (message.type === "open-url" && native.open_url) {
          native.open_url(message.url);
          return;
        }
        if (message.type === "resize" && native.resize) native.resize(message.w, message.h);
        else if (message.type === "drag" && native.drag) native.drag();
        else if (message.type === "open-dsh" && native.open_dsh) native.open_dsh();
        else if (message.type === "quit" && native.quit) native.quit();
        return;
      } catch (e) {
        /* 桥还没就绪就丢掉这条消息，下一次 resize 会补上 */
      }
    }
    if (HOST === "app" && webview && typeof webview.postMessage === "function") {
      webview.postMessage(message);
      return;
    }
    if (window.parent && window.parent !== window) {
      window.parent.postMessage({ source: "xj", ...message }, "*");
    }
  }

  document.documentElement.classList.add("xj-embed");
  document.addEventListener("DOMContentLoaded", () => document.body.classList.add("embed"));

  /* XJ.mock 命名空间兜底：原型态由 mock.js 提供 { Harness, SAMPLES, seedSessions }，
     但插件/独立窗的 web/app.html 不打包 mock.js（构建期剥离，见 build-plugin.mjs）。
     app.js 启动时执行 XJ.mock.harness = __XJ_EMBED_HARNESS__ || new XJ.mock.Harness()，
     embed 态左操作数恒真、永远不碰 Harness，所以这里只要有个对象挂着就行。 */
  XJ.mock = XJ.mock || {};

  /* ------------------------ 尺寸上报 ------------------------ */
  // 用元素自身尺寸（offsetWidth/Height）而不是 getBoundingClientRect：
  // 窗口比内容小时 rect 会被视口裁切，量出来的值反过来又改窗口大小，
  // 于是「窗口变大 → 量到的尺寸变 → 窗口变小」来回抖，看起来就是一直闪。
  const INSET = 44; // 四周各 22px：容纳双角标（探出鲸鱼 8px）+ 琥珀呼吸的最大外发光
  const MIN_W = 96;
  const MIN_H = 96;
  const MAX_W = 760;
  const MAX_H = 900;
  let lastW = 0;
  let lastH = 0;
  let pending = 0;

  function measure() {
    const stage = document.getElementById("xj-stage");
    if (!stage) return null;
    // 量 #xj-stage 本身：气泡/输入条形态下 stage 里有两个 .form（气泡 + 鲸鱼），
    // 只量第一个会漏掉鲸鱼那一段，窗口就会把气泡顶部裁掉。
    const rawW = stage.offsetWidth || 0;
    const rawH = stage.offsetHeight || 0;
    if (rawW < 1 || rawH < 1) return null;
    const w = Math.min(MAX_W, Math.max(MIN_W, Math.ceil(rawW) + INSET));
    const h = Math.min(MAX_H, Math.max(MIN_H, Math.ceil(rawH) + INSET));
    return { w, h };
  }

  function reportSize() {
    if (HOST === "page" && (!window.parent || window.parent === window)) return;
    const m = measure();
    if (!m) return;
    // 2px 之内当作亚像素抖动，不上报
    if (Math.abs(m.w - lastW) < 2 && Math.abs(m.h - lastH) < 2) return;
    lastW = m.w;
    lastH = m.h;
    post({ type: "resize", w: m.w, h: m.h });
  }

  /** 防抖：状态连续变化时只在停下来之后量一次 */
  function scheduleSize() {
    clearTimeout(pending);
    pending = setTimeout(reportSize, 90);
  }

  function watch() {
    const stage = document.getElementById("xj-stage");
    if (!stage) return setTimeout(watch, 60);
    if (typeof ResizeObserver === "function") {
      new ResizeObserver(scheduleSize).observe(stage);
    }
    new MutationObserver(scheduleSize).observe(stage, { childList: true, subtree: true });
    setInterval(reportSize, 400);
    reportSize();
  }
  document.addEventListener("DOMContentLoaded", watch);

  // 调试入口：?open=panel|bubble|quickbar 启动就展开对应形态（排查/截图用）
  document.addEventListener("DOMContentLoaded", () => {
    const want = new URLSearchParams(location.search).get("open");
    if (!want) return;
    setTimeout(() => {
      try {
        if (want === "panel") XJ.app.openPanel();
        else if (want === "quickbar") XJ.app.openQuickbar();
        else if (want === "bubble") XJ.state.actions.setForm("bubble");
      } catch (e) {}
    }, 700);
  });

  window.addEventListener("resize", scheduleSize);
  window.addEventListener("message", (e) => {
    const d = e.data;
    if (!d || d.source !== "parent") return;
    if (d.type === "blur") {
      if (XJ.app && typeof XJ.app.collapse === "function" && window.__xjUiOpen) XJ.app.collapse();
    }
    if (d.type === "hotkey" && d.key === "panel" && XJ.app) XJ.app.openPanel();
    if (d.type === "hotkey" && d.key === "quickbar" && XJ.app) XJ.app.openQuickbar();
  });

  /* ------------------------ 真实数据 Harness ------------------------ */
  const unsupported = (what) => {
    const err = new Error(what + " not supported in DSH overlay");
    err.code = 503;
    return err;
  };

  class HostHarness {
    constructor() {
      this.sessions = [];
      this.pending = [];
      this.connection = "online";
      this.subs = new Set();
      this.known = new Map();
      this.timer = null;
      this.failures = 0;
      this.ticks = 0;
      this.usage = null;
      this.usageSig = "";
    }

    on(fn) {
      this.subs.add(fn);
      this.start();
      return () => this.subs.delete(fn);
    }

    emit(type, payload) {
      for (const fn of this.subs) {
        try {
          fn(type, payload);
        } catch (err) {
          console.error("[哦鲸鲸] harness listener failed", err);
        }
      }
    }

    start() {
      if (this.timer) return;
      this.refresh();
      this.timer = setInterval(() => this.refresh(), 1500);
    }

    async refresh() {
      try {
        const res = await fetch("/xj/state", { cache: "no-store" });
        if (!res.ok) throw new Error("state " + res.status);
        const data = await res.json();
        this.failures = 0;
        const next = new Map((data.pending || []).map((p) => [p.id, p]));
        for (const [id, p] of next) {
          if (this.known.has(id)) continue;
          this.emit("approval.requested", {
            approval_id: id,
            session_id: p.session_id,
            risk: p.risk,
            summary: p.summary,
            command: p.command,
            impact: p.reason,
            expires_at: null,
          });
        }
        for (const id of this.known.keys()) {
          if (next.has(id)) continue;
          this.emit("approval.resolved", { approval_id: id, decision: "allow", by: "web" });
        }
        this.known = next;
        this.pending = data.pending || [];
        if (this.connection !== "online") {
          this.connection = "online";
          this.emit("connection.online", {});
        }
        // 只有真的变了才 emit：否则每 1.5s 一次空刷新会让整棵树重建，
        // 入场动画（formIn / 光环呼吸）跟着重播，看起来就是「一直在闪」。
        const sig = JSON.stringify(
          (data.sessions || []).map((x) => [x.id, x.title, x.state, x.action, x.progress, x.unread ? 1 : 0, x.pending ? 1 : 0])
        );
        if (sig !== this.sessionsSig) {
          this.sessionsSig = sig;
          this.sessions = data.sessions || [];
          this.emit("sessions.changed", { sessions: this.sessions });
        }
        // 用量同理：今天花了多少 / 余额缓存，数字没变就不惊动界面
        if (data.usage) {
          this.usage = data.usage;
          const usig = JSON.stringify([data.usage.today, data.usage.tokens, data.usage.balance, data.usage.balance_error || ""]);
          if (usig !== this.usageSig) {
            this.usageSig = usig;
            this.emit("usage.changed", { usage: data.usage });
          }
        }
      } catch (err) {
        this.failures += 1;
        if (this.failures >= 3 && this.connection !== "offline") {
          this.connection = "offline";
          this.emit("connection.offline", {});
        }
      }
    }

    snapshot() {
      return {
        api_version: "v1",
        generated_at: Date.now(),
        connection: this.connection,
        sessions: this.sessions,
        pending: this.pending,
        usage: this.usage,
      };
    }

    async decide(id, opts) {
      const decision = opts && opts.decision === "deny" ? "deny" : "allow";
      const res = await fetch("/xj/decide", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, decision }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        const err = new Error(body.error || "decide failed");
        err.code = res.status;
        throw err;
      }
      return await res.json();
    }

    prompt() {
      return Promise.reject(unsupported("prompt"));
    }
    stop() {
      return Promise.reject(unsupported("stop"));
    }
    newSession() {
      return Promise.reject(unsupported("newSession"));
    }
    uploadAttachment() {
      return Promise.reject(unsupported("uploadAttachment"));
    }
    tick() {}
    setConnected() {}
    reset() {}
  }

  window.__XJ_EMBED_HARNESS__ = new HostHarness();
  XJ.embed = {
    enabled: true,
    // py 外壳在 app.js 里按「原生外壳」处理（拖拽、打开主窗口都走外层）
    host: HOST === "page" ? "page" : "app",
    post,
    harness: window.__XJ_EMBED_HARNESS__,
    reportSize,
  };
})();
