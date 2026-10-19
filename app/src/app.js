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
    refreshUsage,
    markTouch,
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

    // 「多久没碰」的计时依据：鼠标/键盘/滚轮/切回窗口都算触碰过
    ["pointerdown", "pointermove", "keydown", "wheel"].forEach((type) => {
      window.addEventListener(type, markTouch, { passive: true });
    });
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") markTouch();
    });

    // 面板开着时顺手刷一下余额（插件侧 60s 缓存，这里的频率拿不到就是拿不到，不会打爆接口）
    setInterval(() => {
      if (S().ui.form === "panel") refreshUsage({ quiet: true });
    }, 60000);

    // 闲下来主动搭话
    setInterval(maybeNudge, 15000);

    // 滚动期间暂停装饰动画 / 悬停过渡：软件光栅下「转圈 + 呼吸 + 卡片 hover」和滚动抢帧，
    // 停掉的这几帧正好是手感最敏感的几帧；松手 160ms 后自动恢复。
    bindScrollBoost();
    // 滚轮改成逐帧缓动（原生在软件光栅下是一格一跳）
    bindSmoothScroll();

    // 随机眨眼（仅 SVG 几何版有 .eye-open；角色头像版没有，querySelectorAll 空跑跳过。
    // 睡着的鲸鱼不眨——scaleY 已经是闭眼状态了）
    (function scheduleBlink() {
      setTimeout(function () {
        document.querySelectorAll(".whale:not(.st-sleep) .eye-open").forEach(function (eye) {
          eye.classList.add("xj-blink");
          setTimeout(function () {
            eye.classList.remove("xj-blink");
          }, 200);
        });
        scheduleBlink();
      }, 3200 + Math.random() * 4200);
    })();

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
  /* 全量重建 + 两道闸门：
     1) 重建出来的 HTML 和上一次完全一样就不动 DOM（打字、hover 这类高频 setState
        经常不改任何可见内容，白重建一次等于整块面板重绘一遍，还顺手把焦点和动画都重置了）；
     2) 真的重建了，也只给「这次新出现的元素」放入场动画。以前是 CSS 里按类挂 animation，
        于是每次重建所有会话卡、台词条都重新弹一遍——看起来像整页在闪。 */
  let lastStageHTML = "";
  let lastForm = "";
  let lastLevel = "";
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
    // 减少动画：设置项（motion=reduce / reduceAnim）或系统「减少动态效果」任一命中就生效。
    // 系统那一项原来只在滚动里读，界面其他动画没跟着降级——系统级别的偏好应该全局认。
    const sysReduce = !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
    document.body.classList.toggle(
      "reduce-motion",
      s.settings.motion === "reduce" || !!s.settings.reduceAnim || sysReduce
    );
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

    // 闸门 1：内容和上次一样就整个跳过。序列化几千字符是微秒级，
    // 对比之下 replaceChildren + 样式重算 + 布局要贵得多。
    let html = "";
    for (let i = 0; i < frag.children.length; i++) html += frag.children[i].outerHTML;
    if (html === lastStageHTML) {
      renderChrome(s);
      return;
    }
    lastStageHTML = html;

    // 闸门 2：只给这次新出现的元素放入场动画（data-enter-key 就是它的身份）。
    // 形态没换时，面板 / 气泡自身的 formIn 也不再重放。
    const seen = new Set();
    stageEl.querySelectorAll("[data-enter-key]").forEach((el) => seen.add(el.dataset.enterKey));
    const formChanged = lastForm !== form;
    const prevForm = lastForm;
    lastForm = form;
    document.documentElement.classList.toggle("xj-same-form", !formChanged);

    /* 收起原来是一帧硬切：气泡/面板在 replaceChildren 里直接消失，鲸鱼球「啪」地孤零零回来。
       这里给一条离场通道——把旧的顶层形态留在文档流里，让它的高度塌到 0 再摘掉。
       必须留在流里，不能绝对定位叠着淡出：独立窗的尺寸是 ResizeObserver 量 #xj-stage
       报给外壳的，只有这个盒子真的变矮，窗口才会跟着矮；绝对定位的幽灵会在 40ms 后被
       缩小的窗口裁掉一截。也因为它留在流里，窗口是跟着一起「收回」的，不是先消失再缩。 */
    let leaving = null;
    let leavingH = 0;
    if (prevForm && prevForm !== "collapsed" && form === "collapsed") {
      leaving = stageEl.querySelector(
        ".bubble:not(.xj-leaving), .panel:not(.xj-leaving), .quickbar:not(.xj-leaving), .form-shot:not(.xj-leaving)"
      );
      if (leaving) {
        leavingH = leaving.getBoundingClientRect().height;
        if (leavingH < 8) leaving = null;
        else {
          if (leaving.contains(document.activeElement)) document.activeElement.blur();
          leaving.remove();
        }
      }
    }

    stageEl.replaceChildren(frag);

    let enterSlot = 0;
    stageEl.querySelectorAll("[data-enter-key]").forEach((el) => {
      const key = el.dataset.enterKey;
      if (seen.has(key)) return;
      // 一次入场里好几张卡同时起飞会显得「齐刷刷」，按 DOM 顺序逐条错开一点；
      // 每条 45ms、最多推到 180ms——再长就变成肉眼可数的排队了。
      const delay = Math.min(enterSlot++ * 45, 180);
      if (delay) el.style.animationDelay = delay + "ms";
      el.classList.add("xj-enter");
      // 一次性动画：跑完就把类摘掉，别让它在下一次重建时被当成初始状态
      el.addEventListener(
        "animationend",
        () => {
          el.classList.remove("xj-enter");
        },
        { once: true }
      );
    });

    // 状态等级变了：鲸鱼整块是新节点，直接换就是「啪」一下变脸（睡→干活→等你点头）。
    // 给一个很短的缩放淡入，读起来像「换了表情」而不是「换了一张图」。
    const level = document.body.dataset.status;
    if (lastLevel && lastLevel !== level) {
      const whale = stageEl.querySelector(".whale");
      if (whale) {
        whale.classList.add("xj-swap");
        whale.addEventListener("animationend", () => whale.classList.remove("xj-swap"), { once: true });
      }
    }
    lastLevel = level;

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

    // 离场通道（见上面捕获取证那段）：插回鲸鱼球上方，从量到的高度塌到 0。
    if (leaving) {
      leaving.classList.add("xj-leaving");
      leaving.style.setProperty("--xj-leave-h", leavingH + "px");
      leaving.setAttribute("aria-hidden", "true");
      stageEl.insertBefore(leaving, stageEl.firstChild);
      let dropped = false;
      const drop = () => {
        if (dropped) return;
        dropped = true;
        leaving.remove();
      };
      // 只认自己那一条：里面还有徽标翻滚、台词滑入这些短动画，
      // animationend 会冒泡上来，不认名字的话 120ms 就被提前摘掉了。
      leaving.addEventListener("animationend", (e) => {
        if (e.target === leaving && e.animationName === "formLeave") drop();
      });
      // 兜底：动画被打断时 animationend 不会来，别让它一直挂着
      setTimeout(drop, 400);
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
    // 给 CSS 用：面板 / 气泡的 transform-origin 跟着吸附角走（styles.css §7），
    // 从鲸鱼球所在的那一角「长」出来，换角落也不会变成从远处飞过来。
    stageEl.dataset.dock = corner;

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
    delete document.body.dataset.hoverExpand;
    delete document.body.dataset.hoverArm;
    s.ui.showOnboarding = false;
    s.ui.panelScreen = "home";
    s.ui.hotkeyRecording = null;
    A().setForm("collapsed");
  }

  function openPanel() {
    cancelHoverTimer();
    delete document.body.dataset.hoverExpand;
    A().setForm("panel");
  }

  function openQuickbar() {
    cancelHoverTimer();
    delete document.body.dataset.hoverExpand;
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
    // 等待的 300ms 里先「屏一口气」（styles.css 的 orbArm）：球微微收紧，
    // 让后面那一下绽开有前因，而不是冷不丁换掉一整块 360px 玻璃板。
    document.body.dataset.hoverArm = "1";
    hoverTimer = setTimeout(() => {
      if (S().ui.form === "collapsed") {
        // 鼠标一移上来就甩一句台词（只在这里刷新：点击不换词）
        if (XJ.lines) S().ui.line = XJ.lines.pick(S());
        // 先打标记再换形态：bubbleReveal 必须在这个 .bubble 第一次算样式时就命中，
        // 晚一帧设置会先按 formIn 起播、再被换规则打断一次（看着像抽了一下）。
        document.body.dataset.hoverExpand = "1";
        A().setForm("bubble");
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
    delete document.body.dataset.hoverArm;
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
     Ctrl/⌘（缩放）、纯横向滚动、减少动画、输入框一律交回浏览器。

     缓动改成「按时间插值」而不是「按帧逼近」：
     原来是 scrollTop += gap * 0.2，每帧固定收 20%，看着跟手，但它的速度是「每一帧」
     而不是「每一毫秒」——设备或窗口一掉到 30fps，同样的滚动就要走两倍长的时间，
     在软件光栅的独立窗里，这一条比什么曲线都更能让人觉出「卡」。
     现在从当前 scrollTop 起、按 easeOutCubic 在固定时长内走完：
     帧率高低只影响中间采样几帧，落位时间不变。 */
  function bindSmoothScroll() {
    const MIN_DUR = 170; // 一小格也要有这么长，太短就是「瞬移」
    const MAX_DUR = 340; // 一屏以上也不再拖
    const PX_PER_MS = 3.4; // 距离换时长：滚得越远走得越久（170ms ≈ 580px）
    const MIN_STEP = 0.4; // 离目标不到这么多像素就直接落位，不再多刷一帧
    const LINE_PX = 16; // deltaMode=1（按行滚）时的换算
    let tweenSc = null; // 当前正在做缓动的滚动容器（拖滚动条时要把它收掉）
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

    const stopTween = (sc) => {
      if (sc.__xjRaf) cancelAnimationFrame(sc.__xjRaf);
      sc.__xjRaf = 0;
      if (tweenSc === sc) tweenSc = null;
    };

    const startTween = (sc) => {
      stopTween(sc);
      tweenSc = sc;
      const from = sc.scrollTop;
      const dist = sc.__xjTarget - from;
      if (Math.abs(dist) < MIN_STEP) {
        sc.scrollTop = sc.__xjTarget;
        return;
      }
      const dur = Math.min(MAX_DUR, Math.max(MIN_DUR, Math.abs(dist) / PX_PER_MS));
      const t0 = performance.now();
      const tick = (now) => {
        const t = Math.min(1, (now - t0) / dur);
        const k = 1 - Math.pow(1 - t, 3); // easeOutCubic：起步快、收尾长，跟手又不生硬
        const gap = sc.__xjTarget - (from + dist * k);
        if (t >= 1 || Math.abs(gap) < MIN_STEP) {
          sc.scrollTop = sc.__xjTarget;
          sc.__xjRaf = 0;
          return;
        }
        sc.scrollTop = from + dist * k;
        sc.__xjRaf = requestAnimationFrame(tick);
      };
      sc.__xjRaf = requestAnimationFrame(tick);
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
        const base = sc.__xjRaf ? sc.__xjTarget : sc.scrollTop;
        sc.__xjTarget = Math.min(max, Math.max(0, base + e.deltaY * unit));
        startTween(sc);
      },
      { passive: false }
    );

    // 拖滚动条 / 键盘翻页时，把还在跑的缓动收掉：两边同时写 scrollTop，手感和位置都会打架。
    stageEl.addEventListener(
      "pointerdown",
      () => {
        if (tweenSc) stopTween(tweenSc);
      },
      { passive: true }
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
    // 宿主还在推进事情，说明人就在电脑前：把「多久没碰」的计时重置掉
    if (type === "sessions.changed" || type === "approval.requested") markTouch();
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

      case "usage.changed":
        // 花费/余额只在真的变了时才来，不会跟着 1.5 秒轮询一起抖
        A().setUsage(p.usage || p);
        break;

      case "session.completed": {
        A().sessionCompleted(p.session_id, {});
        hopWhale(); // 未读到达：鲸鱼原地跳一下
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

  /** 未读到达：鲸鱼原地跳一下（一次性；animationend 摘 class，兜底 timer 防脏 class） */
  function hopWhale() {
    const el = document.querySelector("#xj-stage .whale");
    if (!el || el.classList.contains("hop")) return;
    const done = function () {
      el.classList.remove("hop");
    };
    el.classList.add("hop");
    el.addEventListener("animationend", done, { once: true });
    setTimeout(done, 750);
  }

  /** 强提醒：光环脉冲 + 提示音 + 系统通知（§6.7 分级） */
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
    if (snap.usage) A().setUsage(snap.usage);
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

  /* ============================ 用量 / 余额 ============================ */
  let usageBusy = false;

  /**
   * 拉用量。插件 /xj/usage 的 POST 会真的去 DeepSeek 问一次余额，GET 只是把缓存账本吐出来。
   * quiet = 面板停留时的顺手刷新：不转圈、不弹提示，静默失败。
   */
  async function refreshUsage(opts) {
    const quiet = !!(opts && opts.quiet);
    if (usageBusy) return;
    if (!(XJ.embed && XJ.embed.enabled)) {
      // 原型里没有真接口：造一份假数据，免得按钮点了像坏的
      loadSnapshot();
      return;
    }
    usageBusy = true;
    if (!quiet) A().usageLoading(true);
    try {
      const res = await fetch("/xj/usage", { method: "POST", cache: "no-store" });
      if (!res.ok) throw new Error("HTTP " + res.status);
      A().setUsage(await res.json());
      const u = S().usage;
      if (!quiet && u.error) XJ.ui.toast({ type: "warn", title: "余额没拿到", sub: u.error });
    } catch (err) {
      if (!quiet) {
        XJ.ui.toast({ type: "warn", title: "余额没拿到", sub: String((err && err.message) || err) });
      }
    } finally {
      usageBusy = false;
      A().usageLoading(false);
    }
  }

  /* ============================ 闲下来主动搭话 ============================ */
  let lastTouch = Date.now();
  let nudgeStrikes = 0; // 连着没人理就慢慢拉长间隔，别变骚扰
  let nudgeHideTimer = null;

  function markTouch() {
    lastTouch = Date.now();
    nudgeStrikes = 0;
  }

  function nudgeWaitMs(s) {
    const base = clamp(Number(s.settings.idleNudgeMin) || 6, 1, 120) * 60000;
    return Math.min(base * (1 + nudgeStrikes * 0.6), 45 * 60000);
  }

  function maybeNudge() {
    const s = S();
    if (!s.settings.idleNudge) return;
    if (s.ui.form !== "collapsed") return; // 已经弹出东西了：人在，或者我们已经在说话
    if (nudgeHideTimer) return;
    if (s.connection === "reconnecting") return;
    // 页面被切走 / 窗口被最小化时别自说自话（回来第一眼看到一句话就够了，不该是弹在半空）
    if (document.visibilityState === "hidden") return;
    // 真在跑活、或者有待批准：球上已经有角标在喊了，这时候再冒泡就是打扰
    if (s.sessions.some((x) => x.state === "working")) return;
    if (XJ.state.pendingList(s).length) return;
    if (Date.now() - lastTouch < nudgeWaitMs(s)) return;
    const line = XJ.lines && XJ.lines.pickNudge ? XJ.lines.pickNudge(s) : null;
    if (!line || !line.text) return;
    s.ui.line = line;
    document.body.dataset.hoverExpand = "1"; // 用悬停那套「慢慢绽开」，不用点击的急曲线
    A().setForm("bubble");
    nudgeStrikes += 1;
    lastTouch = Date.now();
    // 一直没人理就自己收回去，别赖在屏幕上
    nudgeHideTimer = setTimeout(() => {
      nudgeHideTimer = null;
      if (S().ui.form === "bubble") {
        A().setForm("collapsed");
        delete document.body.dataset.hoverExpand;
      }
    }, 14000);
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
