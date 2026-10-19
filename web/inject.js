/**
 * 哦鲸鲸 · 父页面注入脚本
 *
 * 在 DSH 页面右下角放一个 iframe（内容来自 /xj/app.html），iframe 的尺寸由
 * 子页面渲染后 postMessage 决定：只有哦鲸鲸本体覆盖的区域会接鼠标，其余点击穿透。
 */
(function () {
  if (window.__XJ_OVERLAY_HOSTED__) return;
  if (!/^https?:$/.test(location.protocol)) return;
  window.__XJ_OVERLAY_HOSTED__ = true;

  const HOST_ID = "xj-overlay-host";
  let frame = null;
  let wrap = null;

  function build() {
    if (document.getElementById(HOST_ID)) return;

    wrap = document.createElement("div");
    wrap.id = HOST_ID;
    wrap.setAttribute("aria-label", "哦鲸鲸悬浮窗");
    Object.assign(wrap.style, {
      position: "fixed",
      right: "0",
      bottom: "0",
      width: "140px",
      height: "140px",
      zIndex: "2147483000",
      pointerEvents: "none",
      transition: "width 180ms ease, height 180ms ease",
    });

    frame = document.createElement("iframe");
    frame.src = "/xj/app.html?embed=1";
    frame.title = "哦鲸鲸";
    frame.setAttribute("allowtransparency", "true");
    Object.assign(frame.style, {
      width: "100%",
      height: "100%",
      border: "0",
      background: "transparent",
      colorScheme: "dark",
      pointerEvents: "auto",
      display: "block",
    });

    wrap.appendChild(frame);
    document.body.appendChild(wrap);
  }

  window.addEventListener("message", (event) => {
    const data = event.data;
    if (!data || data.source !== "xj") return;
    if (event.origin !== location.origin) return;
    if (data.type === "resize" && wrap) {
      const w = Math.max(96, Math.min(760, Number(data.w) || 0));
      const h = Math.max(96, Math.min(900, Number(data.h) || 0));
      wrap.style.width = w + "px";
      wrap.style.height = h + "px";
    }
  });

  function install() {
    build();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", install, { once: true });
  } else {
    install();
  }

  // 页面路由变化（SPA）后 iframe 还在，不必重建；仅当被框架清空时补回
  setInterval(() => {
    if (!document.getElementById(HOST_ID)) install();
  }, 4000);
})();
