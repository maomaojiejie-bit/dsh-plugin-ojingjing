/* =============================================================================
   app.js · 组装与运行时
   职责：初始化 mock Harness、订阅状态、渲染舞台、系统热键、拖拽吸附、
        悬停计时、粘贴/拖入、重连对账、通知与音效。
   平台层（XJ.platform）在真实版本里换成一扇 Tauri 窗口 + 一条 SSE，
   其余代码不需要改。
   ========================================================================== */
(function () {
  const XJ = window.XJ;
  const D = XJ.dom;
  const { h, wait, clamp } = D;
  const S = () => XJ.state.store.state;
  const A = () => XJ.state.actions;

  let stageEl = null;
  let hoverTimer = null;
  let hideTimer = null;
  let offlineTimer = null;
  let reconnectAttempt = 0;
  let booted = false;

  /* ============================ app API ============================ */
  const app = (XJ.app = {
    toast: (o) => XJ.ui.toast(o),
    collapse,
    openPanel,
    openQuickbar,
    closeQuickbar,
    openSettings,
    openApprovalCenter,
    openNewSession,
    openMainWindow,
    startCapture,
    reconnect,
    toggleDndQuick,
    decideApproval,
    stopSession,
    orbPointerDown,
    orbHoverStart,
    orbHoverEnd,
    cancelHoverTimer,
    resetDock,
    loadSnapshot,
    init,
  });

  /* ============================ 启动 ============================ */
  function init() {
    if (booted) return;
    booted = true;
    stageEl = document.getElementById("xj-stage");

    XJ.mock.harness = window.__XJ_EMBED_HARNESS__ || new XJ.mock.Harness();
    XJ.state.store.init();
    loadSnapshot();

    // 从未引导过 → 打开面板并进入引导（§8.5）；嵌入 DSH 时不打断工作
    if (!XJ.platform.store.get("onboarded") && !(XJ.embed && XJ.embed.enabled)) {
      S().ui.showOnboarding = true;
      S().ui.onboardingStep = 0;
      S().ui.form = "panel";
    }

    // 草稿恢复（24h）
    const draft = XJ.platform.store.get("draft");
    if (draft && draft.text) {
      S().composer.text = draft.text;
    }

    XJ.mock.harness.on(onHarnessEvent);
    XJ.state.store.subscribe(render);
    applyDemoState();
    render();

    // 定时器：相对时间 / 审批超时 / 会话推进 / 对账轮询
    setInterval(tickClock, 1000);
    setInterval(tickExpiry, 2000);
    // 嵌进 DSH 时数据层自己每 1.5s 拉一次并有 diff，这里再对账一次等于白重建一遍 DOM（会闪）
    const embeddedHost = XJ.embed && XJ.embed.enabled;
    setInterval(() => XJ.mock.harness.tick(), 2600);
    if (!embeddedHost) {
      setInterval(() => {
        const s = S();
        if (s.connection === "online" && s.ui.form !== "panel") loadSnapshot();
      }, Math.max(5, S().settings.pollInterval) * 1000);
    }

    // 全局热键与输入
    document.addEventListener("keydown", onKeydown, true);
    document.addEventListener("paste", onPaste, true);
    bindDragAndDrop();

    // 滚动期间暂停装饰动画 / 悬停过渡：软件光栅下「转圈 + 呼吸 + 卡片 hover」和滚动抢帧，
    // 停掉的这几帧正好是手感最敏感的几帧；松手 160ms 后自动恢复。
    bindScrollBoost();
    // 滚轮改成逐帧缓动（原生在软件光栅下是一格一跳）
    bindSmoothScroll();

    // §6.4 工作区 < 720 逻辑像素 → 密度模式（会话卡压成单行）
    const applyAutoDensity = () => {
      // 嵌进 DSH 时 iframe 只有浮窗那么大，不能拿 iframe 高度当工作区高度
      if (XJ.embed && XJ.embed.enabled) {
        document.body.classList.remove("density");
        return;
      }
      document.body.classList.toggle("density", window.innerHeight < 720);
    };
    applyAutoDensity();
    window.addEventListener("resize", applyAutoDensity);

    // 首次渲染后给个提示
    setTimeout(() => {
      if (!S().ui.showOnboarding && !(XJ.embed && XJ.embed.enabled)) {
        XJ.ui.toast({
          type: "info",
          title: "老大，我蹲在右下角了",
          sub: "鼠标移上来我会说话 · 悬停看气泡 · 单击展开 · 左下角是原型控制台",
          duration: 6000,
        });
      }
    }, 800);
  }

  /* ============================ 渲染 ============================ */
  function render() {
    const s = S();
    const active = document.activeElement;
    const fkey = active && active.dataset ? active.dataset.focus : null;
    const fsel =
      active && typeof active.selectionStart === "number" ? [active.selectionStart, active.selectionEnd] : null;

    document.body.dataset.conn = s.connection;
    document.body.dataset.status = XJ.state.mainStatus(s).level;
    document.body.classList.toggle("is-presenting", XJ.state.presenting(s));
    document.body.classList.toggle("is-offline", s.connection === "offline");
    document.body.classList.toggle("through-mode", !!s.settings.clickThrough);
    document.body.classList.toggle("reduce-motion", s.settings.motion === "reduce" || !!s.settings.reduceAnim);
    document.documentElement.dataset.motion = s.settings.reduceAnim ? "off" : "on";

    const form = s.ui.form;
    stageEl.className = "stage stage-" + form;
    applyDock(s.settings.dockCorner || "br");

    // 全量重建（DOM 小，逻辑简单；焦点在重建后按 data-focus 还原）
    // 顺序：气泡 / 输入条在上，鲸鱼永远在最底部（从角落向上生长）
    const frag = document.createDocumentFragment();
    if (form === "bubble") frag.appendChild(XJ.views.bubble(s));
    if (form === "quickbar") frag.appendChild(XJ.views.quickbar(s));
    if (form === "collapsed" || form === "bubble" || form === "quickbar") {
      frag.appendChild(XJ.views.collapsed(s));
    }
    if (form === "panel") {
      const panel = XJ.views.panel(s);
      frag.appendChild(panel);
      if (s.ui.panelScreen === "settings") panel.appendChild(XJ.views.settingsSheet(s));
      else if (s.ui.panelScreen === "approvals") panel.appendChild(XJ.views.approvalCenter(s));
      else if (s.ui.panelScreen === "audit") panel.appendChild(XJ.views.auditSheet(s));
      if (s.ui.showOnboarding) panel.appendChild(XJ.views.onboarding(s));
    }
    // 截图提问卡：独立窗专用，和四种形态并列（它出现时窗口会长高）
    if (XJ.shot && XJ.shot.active) frag.appendChild(XJ.shot.node(s));
    stageEl.replaceChildren(frag);

    // 焦点守恒
    if (fkey) {
      const el = stageEl.querySelector('[data-focus="' + fkey + '"]');
      if (el) {
        el.focus({ preventScroll: true });
        if (fsel && typeof el.setSelectionRange === "function") {
          try {
            el.setSelectionRange(fsel[0], fsel[1]);
          } catch (_) {}
        }
      }
    }
    if (form === "quickbar" && !fkey) {
      const ta = stageEl.querySelector('[data-focus="composer"]');
      if (ta) ta.focus({ preventScroll: true });
    }

    renderChrome(s);
  }

  function renderChrome(s) {
    let dev = document.querySelector("[data-devbar]");
    if (dev) dev.remove();
    let logd = document.querySelector(".log-drawer");
    if (logd) logd.remove();
    let banner = document.querySelector(".through-banner");
    if (banner) banner.remove();

    if (s.settings.clickThrough) {
      document.body.append(
        h(
          "div",
          { class: "through-banner" },
          XJ.icon("mousePointer", 13),
          h("span", null, "点击穿透已开启 · " + (s.settings.hotkeyPanel || "Ctrl+Shift+Space") + " 恢复"),
          h(
            "button",
            {
              class: "btn-mini",
              onclick: () => {
                A().patchSettings({ clickThrough: false });
                XJ.ui.toast({ type: "success", title: "已恢复正常交互" });
              },
            },
            "恢复"
          )
        )
      );
    }

    if (XJ.embed && XJ.embed.enabled) return; // 嵌进 DSH 页面时不要原型控制台
    document.body.append(XJ.views.devbar(s));
    const drawer = XJ.views.logDrawer(s);
    if (drawer) document.body.append(drawer);
  }

  /* ============================ 停靠 / 吸附 ============================ */
  function applyDock(corner) {
    const st = stageEl.style;
    st.left = st.right = st.top = st.bottom = "auto";
    st.alignItems = corner === "bl" || corner === "tl" ? "flex-start" : "flex-end";

    // 嵌进 DSH 时 iframe 只有浮窗那么大，靠 10px 内边距容纳玻璃阴影，
    // 不模拟桌面任务栏（§4.2 的 16px / 96px 只对真桌面外壳成立）。
    const embedded = XJ.embed && XJ.embed.enabled;
    const gap = embedded ? "10px" : "16px";
    const bottomGap = embedded ? "10px" : "64px"; // 桌面：工作区 16px + 任务栏 48px

    if (corner === "br" || corner === "bl") {
      st.bottom = bottomGap;
      if (corner === "br") st.right = gap;
      else st.left = gap;
    } else {
      st.top = gap;
      if (corner === "tr") st.right = gap;
      else st.left = gap;
    }
  }

  function nearestCorner(x, y) {
    const right = x > window.innerWidth / 2;
    const bottom = y > window.innerHeight / 2;
    return (bottom ? "b" : "t") + (right ? "r" : "l");
  }

  function resetDock() {
    A().patchSettings({ dockCorner: "br" });
    XJ.ui.toast({ type: "success", title: "已回到主屏右下角", sub: "距工作区边缘 16px" });
  }

  /* ============================ 形态切换 ============================ */
  function collapse() {
    const s = S();
    cancelHoverTimer();
    s.ui.showOnboarding = false;
    s.ui.panelScreen = "home";
    s.ui.hotkeyRecording = null;
    A().setForm("collapsed");
  }

  function openPanel() {
    cancelHoverTimer();
    A().setForm("panel");
  }

  function openQuickbar() {
    cancelHoverTimer();
    A().setForm("quickbar");
  }

  function closeQuickbar() {
    A().setForm("collapsed");
  }

  function openSettings() {
    XJ.ui.guard(S(), () => {
      A().setForm("panel");
      A().setPanelScreen("settings");
    })();
  }

  function openApprovalCenter(id) {
    const s = S();
    A().setForm("panel");
    A().setPanelScreen("approvals");
    if (id) {
      const idx = XJ.state.pendingList(s).findIndex((x) => x.id === id);
      if (idx >= 0) s.ui.approvalCenterIndex = idx;
    }
    A().patchSettings({});
  }

  function openNewSession() {
    A().composerTarget(null);
    A().setForm("panel");
    setTimeout(() => {
      const ta = stageEl.querySelector('[data-focus="composer"]');
      if (ta) ta.focus({ preventScroll: true });
      XJ.ui.toast({ type: "info", title: "新会话", sub: "直接说需求，发出去会自动建一个会话" });
    }, 60);
  }

  function openMainWindow() {
    // 独立桌面窗：让外壳把 DSH 主窗口拉到前台
    if (XJ.embed && XJ.embed.host === "app" && XJ.embed.post) {
      XJ.embed.post({ type: "open-dsh" });
      return;
    }
    const main = document.querySelector(".mock-main");
    if (main && main.animate) {
      main.animate(
        [
          { boxShadow: "0 0 0 2px rgba(124,194,255,.75), 0 30px 90px -30px rgba(0,0,0,.7)" },
          { boxShadow: "0 0 0 0 rgba(124,194,255,0)" },
        ],
        { duration: 1100, easing: "ease-out" }
      );
      main.scrollIntoView({ block: "nearest" });
    }
    XJ.ui.toast({ type: "success", title: "已切到 Harness 主窗口", sub: "浮窗不抢焦点，切回主窗口由你自己决定" });
  }

  function startCapture() {
    // 独立窗（host=app/py）里截图由 Qt/WPF 外壳接管：它有全局热键和整屏抓取权限；
    // 页面自己只能截 DOM，所以这里直接转给外壳。页面内版仍然走 XJ.capture。
    var native = window.xjNative;
    if (native && typeof native.capture === "function") {
      native.capture();
      return;
    }
    XJ.capture.start();
  }

  function toggleDndQuick() {
    const s = S();
    const on = !(s.settings.dndEnabled && s.settings.dndFrom === "00:00");
    A().patchSettings({ dndEnabled: on, dndFrom: on ? "00:00" : "22:00", dndTo: on ? "23:59" : "08:00" });
    XJ.ui.toast({
      type: "info",
      title: on ? "免打扰已开（临时）" : "免打扰已关",
      sub: on ? "只留一条系统通知，不响铃；角标不会消失" : "待办仍会照亮鲸鱼，但不再打扰",
    });
  }

  /* ============================ 悬停 / 拖拽 ============================ */
  function orbHoverStart() {
    const s = S();
    if (s.ui.form !== "collapsed") return;
    if (s.settings.clickThrough) return;
    clearTimeout(hideTimer);
    clearTimeout(hoverTimer);
    hoverTimer = setTimeout(() => {
      if (S().ui.form === "collapsed") {
        // 鼠标一移上来就甩一句台词（只在这里刷新：点击不换词）
        if (XJ.lines) S().ui.line = XJ.lines.pick(S());
        A().setForm("bubble");
        document.body.dataset.hoverExpand = "1";
      }
    }, 300);
  }

  /** 没有台词时补一句（例如直接单击展开、键盘触发，没经过悬停） */
  function ensureLine() {
    const s = S();
    if (XJ.lines && !s.ui.line) s.ui.line = XJ.lines.pick(s);
  }

  function orbHoverEnd() {
    cancelHoverTimer();
    const s = S();
    if (s.ui.form !== "bubble") return;
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      if (S().ui.form === "bubble") {
        A().setForm("collapsed");
        delete document.body.dataset.hoverExpand;
      }
    }, 160);
  }

  function cancelHoverTimer() {
    clearTimeout(hoverTimer);
    hoverTimer = null;
    clearTimeout(hideTimer);
  }

  function orbPointerDown(e) {
    if (e.button !== 0 || S().settings.clickThrough) return;
    e.preventDefault();

    // 独立桌面窗：按下即交给系统做窗口拖动（§4.2 的自由拖拽由外壳实现）
    if (XJ.embed && XJ.embed.host === "app" && XJ.embed.post) {
      XJ.embed.post({ type: "drag" });
      return;
    }

    const start = { x: e.clientX, y: e.clientY, t: Date.now() };
    let moved = false;
    let raf = 0;

    const onMove = (ev) => {
      if (!moved && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) > 4) {
        moved = true;
        stageEl.classList.add("dragging");
        const orb = stageEl.querySelector(".orb");
        if (orb) orb.classList.add("dragging");
        cancelAnimationFrame(raf);
      }
      if (moved) {
        const dx = ev.clientX - start.x;
        const dy = ev.clientY - start.y;
        stageEl.style.transform = "translate(" + dx + "px," + dy + "px)";
      }
    };
    const onUp = (ev) => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      stageEl.classList.remove("dragging");
      const orb = stageEl.querySelector(".orb");
      if (orb) orb.classList.remove("dragging");
      if (moved) {
        const corner = nearestCorner(ev.clientX, ev.clientY);
        stageEl.style.transform = "";
        stageEl.classList.add("snapping");
        A().patchSettings({ dockCorner: corner });
        setTimeout(() => stageEl.classList.remove("snapping"), 280);
      } else if (Date.now() - start.t < 500) {
        // 单击：切换气泡（不改台词，避免「点一下换一句」）
        if (S().ui.form === "collapsed") {
          ensureLine();
          A().setForm("bubble");
        } else if (S().ui.form === "bubble") A().setForm("collapsed");
      }
    };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
  }

  /* ============================ 拖入文件 ============================ */
  /* 滚动期间的降噪：给 <html> 挂 .xj-scrolling，styles.css §22 据此暂停装饰动画和悬停过渡。
     鼠标不会在滚轮时移动，所以指针移出滚动区（mouseleave 到窗口外）也要能复位。 */
  function bindScrollBoost() {
    const root = document.documentElement;
    let timer = 0;
    const bump = () => {
      if (!root.classList.contains("xj-scrolling")) root.classList.add("xj-scrolling");
      clearTimeout(timer);
      timer = setTimeout(() => root.classList.remove("xj-scrolling"), 160);
    };
    // passive：不拦截默认滚动，也不影响滚动手感
    stageEl.addEventListener("wheel", bump, { passive: true });
    stageEl.addEventListener("touchmove", bump, { passive: true });
    // 捕获阶段接内部滚动容器的 scroll（scroll 不冒泡，必须用 capture）
    stageEl.addEventListener("scroll", bump, true);
  }

  /* 滚轮缓动：原生滚轮在软件光栅下是「一格一跳」，这里接管成逐帧缓动（接近触控板惯性）。
     Ctrl/⌘（缩放）、纯横向滚动、减少动画、输入框一律交回浏览器。 */
  function bindSmoothScroll() {
    const EASE = 0.2; // 每帧向目标逼近的比例：越小越飘，越大越跟手
    const MIN_STEP = 0.6; // 离目标不到这么多像素就直接落位，不再多刷一帧
    const LINE_PX = 16; // deltaMode=1（按行滚）时的换算
    const reduceMotion = () =>
      document.body.classList.contains("reduce-motion") ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const scrollableFrom = (node) => {
      let el = node;
      while (el && el !== stageEl && el.nodeType === 1) {
        if (el.tagName === "TEXTAREA" || el.tagName === "INPUT" || el.isContentEditable) return null;
        const oy = getComputedStyle(el).overflowY;
        if ((oy === "auto" || oy === "scroll" || oy === "overlay") && el.scrollHeight - el.clientHeight > 2) return el;
        el = el.parentElement;
      }
      return null;
    };

    stageEl.addEventListener(
      "wheel",
      (e) => {
        if (e.ctrlKey || e.metaKey || reduceMotion()) return;
        if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return; // 横向滚动别接
        const sc = scrollableFrom(e.target);
        if (!sc) return;
        const unit = e.deltaMode === 1 ? LINE_PX : e.deltaMode === 2 ? sc.clientHeight : 1;
        // 触控板本来就是细粒度连续事件（系统已经给了惯性），再包一层缓动只会「跟手变慢」，
        // 所以只接管一格一跳的鼠标滚轮
        if (Math.abs(e.deltaY) * unit < 32) return;
        const max = Math.max(0, sc.scrollHeight - sc.clientHeight);
        e.preventDefault();
        // 连着滚时在「还没走完的目标」上累加，而不是在当前 scrollTop 上累加，
        // 否则快速连滚会吞掉行程（滚 3 格只走 1 格）
        const base = sc.__xjScrollRaf ? sc.__xjScrollTarget : sc.scrollTop;
        sc.__xjScrollTarget = Math.min(max, Math.max(0, base + e.deltaY * unit));
        if (sc.__xjScrollRaf) return;
        const tick = () => {
          const gap = sc.__xjScrollTarget - sc.scrollTop;
          if (Math.abs(gap) < MIN_STEP) {
            sc.scrollTop = sc.__xjScrollTarget;
            sc.__xjScrollRaf = 0;
            return;
          }
          sc.scrollTop += gap * EASE;
          sc.__xjScrollRaf = requestAnimationFrame(tick);
        };
        sc.__xjScrollRaf = requestAnimationFrame(tick);
      },
      { passive: false }
    );
  }

  function bindDragAndDrop() {
    const stop = (e) => {
      e.preventDefault();
      e.stopPropagation();
    };
    document.addEventListener("dragover", stop, false);
    document.addEventListener("drop", stop, false);

    let hoverT = null;
    let hoverTarget = null;
    let hoverRow = null;

    function dropAffordance(on) {
      stageEl.querySelectorAll(".orb").forEach((el) => el.classList.toggle("drop-target", !!on));
      stageEl.querySelectorAll(".composer-box").forEach((el) => el.classList.toggle("drop-target", !!on));
      stageEl.querySelectorAll(".row.drop-over, .sess-card.drop-over").forEach((el) => el.classList.remove("drop-over"));
      if (on && hoverRow && hoverRow.isConnected) hoverRow.classList.add("drop-over");
    }

    stageEl.addEventListener("dragenter", (e) => {
      const s = S();
      if (s.settings.clickThrough) return;
      e.preventDefault();
      const row = e.target.closest && (e.target.closest(".sess-card") || e.target.closest(".row"));
      hoverRow = row || null;
      hoverTarget = row ? row : stageEl.querySelector(".orb") || stageEl;
      clearTimeout(hoverT);
      hoverT = setTimeout(() => {
        dropAffordance(true);
        if (row && row.dataset.sessionId) {
          A().composerTarget(row.dataset.sessionId);
          A().patchSettings({}); // 刷新提示条里的《会话名》
        }
      }, 200);
    });

    stageEl.addEventListener("dragover", (e) => {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    });

    stageEl.addEventListener("dragleave", (e) => {
      if (e.target === hoverTarget || !e.relatedTarget) {
        clearTimeout(hoverT);
        dropAffordance(false);
      }
    });

    stageEl.addEventListener("drop", async (e) => {
      e.preventDefault();
      clearTimeout(hoverT);
      dropAffordance(false);
      const s = S();
      if (s.connection === "offline") {
        XJ.ui.toast({ type: "warn", title: "连接已断开，恢复后可操作" });
        return;
      }
      const row = e.target.closest && (e.target.closest(".sess-card") || e.target.closest(".row"));
      if (row && row.dataset.sessionId) A().composerTarget(row.dataset.sessionId);
      const files = Array.from((e.dataTransfer && e.dataTransfer.files) || []);
      if (!files.length) return;
      // 拖到收起态 / 气泡：展开面板，让确认条可见（确认条由 Composer 渲染）
      if (s.ui.form === "collapsed" || s.ui.form === "bubble" || s.ui.form === "quickbar") A().setForm("panel");
      await XJ.composer.addFiles(files, { confirm: true, source: "drag" });
    });
  }

  /* ============================ 粘贴 ============================ */
  async function onPaste(e) {
    const s = S();
    const t = e.target;
    const inField = t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
    const items = Array.from((e.clipboardData && e.clipboardData.items) || []);
    const files = items
      .filter((i) => i.kind === "file")
      .map((i) => i.getAsFile())
      .filter(Boolean);
    if (!files.length) return;
    if (s.ui.form === "collapsed") {
      XJ.ui.toast({ type: "info", title: "先打开面板或输入条", sub: "Ctrl+Shift+Space 展开" });
      return;
    }
    e.preventDefault();
    await XJ.composer.addFiles(files, { confirm: !inField, source: "paste" });
  }

  /* ============================ 热键 ============================ */
  function onKeydown(e) {
    const s = S();

    // 设置里正在录制快捷键
    if (s.ui.hotkeyRecording) {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        s.ui.hotkeyRecording = null;
        A().patchSettings({});
        return;
      }
      const combo = XJ.platform.comboFromEvent(e);
      if (combo) {
        const map = { panel: "hotkeyPanel", capture: "hotkeyCapture", quick: "hotkeyQuick" };
        A().patchSettings({ [map[s.ui.hotkeyRecording]]: combo });
        s.ui.hotkeyRecording = null;
        A().patchSettings({});
        XJ.ui.toast({ type: "success", title: "快捷键已更新", sub: combo });
      }
      return;
    }

    // 审批中心键盘操作（↑↓ / Enter / Y / N / Esc）
    if (s.ui.form === "panel" && s.ui.panelScreen === "approvals" && !isTyping(e.target)) {
      const list = XJ.state.pendingList(s);
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        if (!list.length) return;
        const dir = e.key === "ArrowDown" ? 1 : -1;
        s.ui.approvalCenterIndex = clamp((s.ui.approvalCenterIndex || 0) + dir, 0, list.length - 1);
        A().patchSettings({});
        return;
      }
      if (e.key === "y" || e.key === "Y" || e.key === "n" || e.key === "N") {
        const item = list[clamp(s.ui.approvalCenterIndex || 0, 0, Math.max(0, list.length - 1))];
        if (!item) return;
        e.preventDefault();
        if (e.key.toLowerCase() === "y") {
          if (item.risk === "danger") {
            item._yPressed = item._yPressed ? item._yPressed + 1 : 1;
            if (item._yPressed < 2) {
              XJ.ui.toast({ type: "warn", title: "高危操作：再按一次 Y 确认" });
              A().patchSettings({});
              return;
            }
          }
          decideApproval(item, "allow", {});
        } else {
          decideApproval(item, "deny", {});
        }
        return;
      }
      if (e.key === "Enter") {
        const item = list[clamp(s.ui.approvalCenterIndex || 0, 0, Math.max(0, list.length - 1))];
        if (item) {
          e.preventDefault();
          const el = stageEl.querySelector('[data-approval-id="' + item.id + '"]');
          // 软件光栅下平滑滚动是「逐帧重绘整块面板」，直接跳更跟手
          if (el) el.scrollIntoView({ block: "nearest", behavior: window.__XJ_RENDER__ === "sw" ? "auto" : "smooth" });
        }
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        A().setPanelScreen("home");
        return;
      }
    }

    // 全局快捷键
    const combo = XJ.platform.comboFromEvent(e);
    if (!combo) {
      if (e.key === "Escape" && !isTyping(e.target)) {
        const form = S().ui.form;
        if (form === "quickbar") closeQuickbar();
        else if (form === "panel" && S().ui.panelScreen !== "home") A().setPanelScreen("home");
        else if (form !== "collapsed") collapse();
        else if (S().ui.showOnboarding) {
          S().ui.showOnboarding = false;
          A().patchSettings({});
        }
      }
      return;
    }
    const st = S().settings;
    if (combo === st.hotkeyPanel) {
      e.preventDefault();
      if (S().ui.form === "panel") collapse();
      else openPanel();
      return;
    }
    if (combo === st.hotkeyCapture) {
      e.preventDefault();
      startCapture();
      return;
    }
    if (combo === st.hotkeyQuick) {
      e.preventDefault();
      if (S().ui.form === "quickbar") closeQuickbar();
      else openQuickbar();
      return;
    }
    if (combo === "Ctrl+Shift+D") {
      e.preventDefault();
      const bar = document.querySelector(".devbar");
      if (bar) bar.classList.toggle("hidden");
    }
  }

  function isTyping(el) {
    return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
  }

  /* ============================ Mock 事件 → 状态 ============================ */
  function onHarnessEvent(type, p) {
    const s = S();
    switch (type) {
      case "approval.requested":
        A().approvalRequested({
          id: p.approval_id,
          sessionId: p.session_id,
          risk: p.risk,
          summary: p.summary,
          command: p.command,
          impact: p.impact,
          expiresAt: p.expires_at ? new Date(p.expires_at).getTime() : Date.now() + 300000,
        });
        loudReminder("approval");
        break;

      case "question.requested":
        A().questionRequested({ id: p.question_id, sessionId: p.session_id, text: p.text });
        loudReminder("question");
        break;

      case "approval.resolved":
        A().approvalResolved(p.approval_id, p.decision, p.by);
        if (p.by === "web") {
          XJ.ui.toast({ type: "info", title: "已在主窗口处理", sub: "浮窗这边的卡片已同步收起" });
        }
        break;

      case "approval.expired":
        A().approvalExpired(p.approval_id);
        XJ.ui.toast({ type: "warn", title: "这个审批已经失效", sub: "任务可能已经中断" });
        break;

      case "sessions.changed":
        A().setSnapshot({ sessions: p.sessions, connection: s.connection === "offline" ? "offline" : "online" });
        break;

      case "session.completed": {
        A().sessionCompleted(p.session_id, {});
        if (s.settings.notifyComplete) {
          XJ.ui.sysNotify({
            title: "1 个会话跑完了",
            sub: "点这里去看看",
            onClick: () => openPanel(),
          });
        }
        if (s.settings.soundComplete && !s.runtime.silent && !XJ.state.inDndWindow(s)) {
          XJ.platform.playChime("complete");
        }
        break;
      }

      case "message.delta": {
        const c = s.composer;
        if (c.lastReply && c.lastReply.sessionId === p.session_id) {
          c.lastReply.text = p.full || (c.lastReply.text || "") + (p.text || "");
          c.lastReply.busy = true;
          scheduleReplyPaint();
        }
        break;
      }

      case "connection.offline":
        setReconnecting();
        break;

      case "connection.online":
        A().setConnection("online");
        break;
    }
  }

  /** 强提醒：光环呼吸 + 提示音 + 系统通知（§6.7 分级） */
  function loudReminder(kind) {
    const s = S();
    const level = XJ.state.reminderLevel(s, kind);
    if (level === "strong") {
      if (s.settings.soundApproval) XJ.platform.playChime("approval");
    }
    if (kind === "approval") {
      XJ.ui.sysNotify({
        title: "1 项待确认",
        sub: XJ.state.presenting(s) ? "演示模式：正文已折叠" : "点这里处理",
        onClick: () => openApprovalCenter(),
      });
    }
  }

  function setReconnecting() {
    const s = S();
    if (s.connection === "offline") return;
    A().setConnection("reconnecting");
    reconnectAttempt++;
    clearTimeout(offlineTimer);
    // 30s 内没恢复 → 离线（§4.3.4）
    offlineTimer = setTimeout(() => {
      if (S().connection !== "online") {
        A().setConnection("offline");
        XJ.ui.toast({
          type: "warn",
          title: "连不上 Harness，正在重试…",
          sub: "动作已置灰，恢复后会自动对账",
          duration: 6000,
        });
      }
    }, 30000);
  }

  async function reconnect() {
    clearTimeout(offlineTimer);
    A().setConnection("reconnecting");
    XJ.ui.toast({ type: "info", title: "正在重新连接…", sub: "第 " + (reconnectAttempt + 1) + " 次尝试" });
    await wait(500);
    XJ.mock.harness.setConnected(true);
    loadSnapshot();
    A().setConnection("online");
    reconnectAttempt = 0;
    XJ.ui.toast({ type: "success", title: "连接已恢复", sub: "已重新拉取一次快照对账" });
  }

  /* ============================ 审批 / 停止 ============================ */
  async function decideApproval(item, decision, opts) {
    const s = S();
    if (!item) return;
    if (s.connection === "offline") {
      XJ.ui.toast({ type: "warn", title: "连接已断开，恢复后可操作" });
      return;
    }
    const scope = (opts && opts.scope) || "once";
    A().approvalSubmitting(item.id);
    // 幂等键：同一审批 + 同一决定 → 重试返回首次结果（§10.4）
    const key = item.id + ":" + decision;
    item.pendingDecision = decision;
    try {
      await XJ.mock.harness.decide(item.id, { decision, idempotencyKey: key, scope });
      s.metrics.approvalDecided++;
      XJ.platform.playChime(decision === "allow" ? "approved" : "denied");
      XJ.ui.toast({
        type: decision === "allow" ? "success" : "info",
        title: decision === "allow" ? "已通过，任务继续执行" : "已拒绝 · 已通知 Agent",
        sub: scope === "session" ? "本会话内同类只读操作不再询问" : "",
      });
    } catch (err) {
      const code = err && err.code;
      if (code === 409) {
        A().approvalResolved(item.id, "allow", "web");
        XJ.ui.toast({ type: "info", title: "该审批已在其他窗口处理", sub: "以先到的决定为准" });
      } else if (code === 410) {
        A().approvalExpired(item.id);
        XJ.ui.toast({ type: "warn", title: "这个审批已经失效" });
      } else if (code === 404) {
        A().approvalResolved(item.id, "allow", "system");
        XJ.ui.toast({ type: "info", title: "这个审批已经不在了" });
      } else if (code === 422) {
        A().approvalFailed(item.id, (err && err.hint) || "这个操作不支持「本会话内都允许」");
      } else {
        A().approvalFailed(item.id, "没发出去，重试？");
      }
    }
  }

  async function stopSession(id) {
    const s = S();
    if (s.connection === "offline") {
      XJ.ui.toast({ type: "warn", title: "连接已断开，恢复后可操作" });
      return;
    }
    try {
      A().sessionStopped(id);
      await XJ.mock.harness.stop(id);
      XJ.ui.toast({ type: "info", title: "已停止", sub: "已改动的文件会保留，不会产生未读" });
    } catch (err) {
      XJ.ui.toast({ type: "warn", title: "停止失败", sub: "稍后再试" });
    }
  }

  /* ============================ 对账 ============================ */
  function loadSnapshot() {
    const snap = XJ.mock.harness.snapshot();
    const s = S();
    A().setSnapshot({ sessions: snap.sessions, connection: snap.connection });
    // 补：快照里有的待办，本地没有 → 加上
    snap.pending.forEach((p) => {
      if (!s.approvals[p.id]) {
        A().approvalRequested({
          id: p.id,
          sessionId: p.session_id,
          risk: p.risk,
          summary: p.summary,
          command: p.command,
          impact: p.impact,
          expiresAt: p.expires_at ? new Date(p.expires_at).getTime() : Date.now() + 300000,
        });
      }
    });
    // 反：本地有但快照没有 → 已在别处处理（跨端同步）
    Object.keys(s.approvals).forEach((id) => {
      if (!snap.pending.some((p) => p.id === id)) {
        const item = s.approvals[id];
        if (item && item.status === "pending") A().approvalResolved(id, "allow", "web");
      }
    });
    // 连接态以服务端为准，但重连中不要被快照直接抹平
    if (snap.connection === "offline" && s.connection !== "reconnecting") {
      setReconnecting();
    }
  }

  /* ============================ 定时刷新 ============================ */
  function tickClock() {
    document.querySelectorAll("[data-wait-id]").forEach((el) => {
      const since = Number(el.dataset.since);
      if (!isNaN(since)) el.textContent = XJ.ui.waitText(since);
    });
    document.querySelectorAll("[data-since]").forEach((el) => {
      if (el.classList.contains("appr-wait")) return;
      const ts = Number(el.dataset.since);
      if (!isNaN(ts)) el.textContent = D.fmtRel(ts);
    });
  }

  function tickExpiry() {
    const s = S();
    Object.values(s.approvals).forEach((a) => {
      if (a.status === "pending" && a.expiresAt && a.expiresAt < Date.now()) {
        A().approvalExpired(a.id);
      }
    });
  }

  let replyRaf = 0;
  function scheduleReplyPaint() {
    cancelAnimationFrame(replyRaf);
    replyRaf = requestAnimationFrame(() => {
      const s = S();
      if (s.ui.form !== "quickbar" || !s.composer.lastReply) return;
      const box = document.querySelector(".qb-reply .clamp2");
      if (box) box.textContent = s.composer.lastReply.text || "…";
      const status = document.querySelector(".qb-reply-head .t-ter:last-child");
      if (status && !s.composer.lastReply.busy) status.textContent = "已完成";
    });
  }

  /* ============================ 评审深链 ============================ */
  /**
   * 给评审用的直达状态：index.html#demo=bubble / panel / approvals / settings /
   * quickbar / onboarding / capture / offline / unread / danger
   * 原型控制台（左下角）是交互入口，这个只是方便截图与对比。
   */
  function applyDemoState() {
    const hash = (location.hash || "").replace(/^#/, "");
    if (!hash) return;
    const q = new URLSearchParams(hash);
    const demo = q.get("demo");
    if (!demo) return;
    const s = S();
    // 评审时不要被引导挡住
    s.ui.showOnboarding = false;
    s.ui.form = "collapsed";
    XJ.platform.store.set("onboarded", true);

    switch (demo) {
      case "onboarding": {
        s.ui.showOnboarding = true;
        s.ui.onboardingStep = Math.max(0, Math.min(2, Number(q.get("step") || 0)));
        s.ui.form = "panel";
        break;
      }
      case "bubble":
        s.ui.form = "bubble";
        break;
      case "panel":
        s.ui.form = "panel";
        break;
      case "approvals":
        s.ui.form = "panel";
        s.ui.panelScreen = "approvals";
        break;
      case "settings":
        s.ui.form = "panel";
        s.ui.panelScreen = "settings";
        break;
      case "quickbar":
        s.ui.form = "quickbar";
        break;
      case "capture":
        setTimeout(() => XJ.capture.start(), 260);
        break;
      case "offline":
        s.connection = "offline";
        break;
      case "unread":
        s.approvals = {}; // 清掉待办，才能看到「完成未读」的翠绿状态（真值表第 4 行）
        s.sessions.forEach((x) => {
          x.state = "idle";
          x.action = "";
          x.progress = 0;
          x.unread = true;
        });
        s.sessions[1].unread = false;
        break;
      case "danger":
        A().approvalRequested({
          id: "ap_danger",
          sessionId: "s_auth",
          risk: "danger",
          summary: "删除 legacy 目录下的 128 个文件",
          command: "Remove-Item -Recurse -Force ./legacy",
          impact: "不可撤销：会一并删除未提交的本地改动",
          expiresAt: Date.now() + 240000,
        });
        s.ui.form = "panel";
        break;
      case "empty":
        s.sessions = [];
        s.approvals = {};
        s.questions = {};
        s.audit = [];
        s.ui.form = "panel";
        // 让 mock 也变空，否则会话推进/对账轮询会把种子会话又推回来
        XJ.mock.harness.tick = () => {};
        XJ.mock.harness.snapshot = () => ({
          api_version: "v1",
          generated_at: Date.now(),
          connection: S().connection,
          sessions: [],
          pending: [],
        });
        break;
      case "density":
        s.ui.form = "panel";
        setTimeout(() => document.body.classList.add("density"), 0);
        break;
    }
  }

  /* 外观：自定义头像 / 背景（外壳用 runJavaScript 调；页面控制台里也能手动试）
     opts = { avatar: dataURL|"", background: dataURL|"", dim: 0–0.9 } */
  let builtinAvatar; // 第一次调用时记住内置头像，清除时退回它
  app.applyAppearance = function (opts) {
    const o = opts || {};
    if (builtinAvatar === undefined) builtinAvatar = XJ.avatarData || "";
    if (Object.prototype.hasOwnProperty.call(o, "avatar")) {
      XJ.avatarData = o.avatar || builtinAvatar;
    }
    const root = document.documentElement;
    if (Object.prototype.hasOwnProperty.call(o, "background")) {
      if (o.background) {
        const dim = Math.max(0, Math.min(0.9, typeof o.dim === "number" ? o.dim : 0.6));
        root.style.setProperty("--xj-bg-image", 'url("' + o.background + '")');
        root.style.setProperty("--xj-bg-dim", String(dim));
        document.body.classList.add("custom-bg");
      } else {
        root.style.removeProperty("--xj-bg-image");
        document.body.classList.remove("custom-bg");
      }
    } else if (typeof o.dim === "number") {
      root.style.setProperty("--xj-bg-dim", String(Math.max(0, Math.min(0.9, o.dim))));
    }
    XJ.state.store.emit();
  };

  /* 启动 */
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
