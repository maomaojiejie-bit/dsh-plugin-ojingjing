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

  // 独立窗的 WebView2 外壳（host=app）：
  //  1. 打上 xj-app —— 逐像素透明的窗口里 backdrop-filter「模糊的是透明」，
  //     拿不到任何模糊效果却每帧都要算一遍，所以样式层直接换成实底玻璃；
  //  2. 想省电也能吃 xj-sw（外壳通过 URL 加 &sw=1 或注入 window.__XJ_RENDER__ === "sw"）。
  if (HOST === "app") {
    document.documentElement.classList.add("xj-app");
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

  /* 外壳回报的「指针在不在窗口里」。
     WebView2 在自己被 resize 之后会丢掉 :hover（CSS 以为指针走了、也不补发 enter），
     悬停收起要是信 CSS，就会 展开 → 收 → 展开 地弹。外壳拿真实光标判定，这里只当信箱。
     没有外壳信号（浏览器预览、Qt 版）时是 null，页面退回用 :hover。 */
  let pointerInside = null;

  /* 「立即重连」的回执信箱。
     内置页（https://ojingjing.local）挂在虚拟主机上，没有 /xj/state 也没有 /xj/decide，
     页面自己 fetch 只会 404 —— 它没法判断 DSH 起没起，必须问外壳，外壳再回一条结论。
     同一时刻只允许一次在飞：用户连点两下时后面的直接复用前面那个 promise。 */
  let shellProbeWaiter = null;
  let shellProbeInflight = null;

  /**
   * 让外壳立刻探一拍：resolve(true) 表示 DSH 真的活着（外壳此时会顺手把页面切到服务器那版）。
   * 没有外壳（浏览器预览 / 插件态）时直接 resolve(false)，由调用方自己 fetch 判断。
   */
  function probeShell(timeoutMs) {
    if (shellProbeInflight) return shellProbeInflight;
    if (!(HOST === "app" && webview && typeof webview.postMessage === "function")) {
      return Promise.resolve(false);
    }
    shellProbeInflight = new Promise((resolve) => {
      let settled = false;
      const finish = (ok) => {
        if (settled) return;
        settled = true;
        shellProbeWaiter = null;
        shellProbeInflight = null;
        resolve(ok);
      };
      shellProbeWaiter = finish;
      post({ type: "reconnect" });
      // 外壳那一拍最坏要扫 70 多个端口（2s）+ 拉一次页面（1.5s），给足 5s。
      // 超时就当连不上：宁可让人再点一次，也别骗出一个假的「已恢复」。
      setTimeout(() => finish(false), timeoutMs || 5000);
    });
    return shellProbeInflight;
  }
  function onShellMessage(event) {
    // WebView2 的 message 事件把 data 给成 JSON 字符串（我们是 PostWebMessageAsJson 发的）
    let message = event && event.data !== undefined ? event.data : event;
    if (typeof message === "string") {
      try {
        message = JSON.parse(message);
      } catch (e) {
        return false;
      }
    }
    if (!message || !message.type) return false;
    /* 连接状态（外壳版心跳）：DSH 关掉后宿主不会再推 connection.offline，
       页面自己又不知道 —— 壳的探活是唯一真相来源。收到就让页面走和宿主
       同一条路（XJ.state.actions.setConnection），球变黑白 + 灰虚线环，
       但页面留在原地，点球照旧展开在线面板，数据停在最后一次。
       页面可能比 app.js 先就绪，setConnection 还没挂，稍等重试几次。 */
    if (message.type === "connection") {
      const want = message.state === "offline" ? "offline" : "online";
      let tries = 0;
      const apply = () => {
        const actions = window.XJ && window.XJ.state && window.XJ.state.actions;
        if (actions && typeof actions.setConnection === "function") {
          actions.setConnection(want);
          return;
        }
        if (++tries < 20) setTimeout(apply, 150);
      };
      apply();
      return true;
    }
    /* 外壳对「立即重连」的答复。ok=false 时页面必须老老实实黑回去 ——
       这条链以前是页面自己 `setConnection("online")` 收场，DSH 没开也报成功。 */
    if (message.type === "reconnect-result") {
      const waiter = shellProbeWaiter;
      shellProbeWaiter = null;
      if (waiter) waiter(!!message.ok);
      return true;
    }
    if (message.type === "pointer") {
      pointerInside = !!message.inside;
      document.body.dataset.pointerInside = pointerInside ? "1" : "0";
      return true;
    }
    // 外壳兜底的「点了鲸鱼」：全屏游戏独占鼠标时窗口收不到鼠标消息，
    // 外壳用全局按键状态补发一条，页面再按自己有没有收到真实事件去重
    if (message.type === "shell-tap") {
      if (window.XJ && window.XJ.app && window.XJ.app.shellTap) window.XJ.app.shellTap();
      return true;
    }
    // 热键召唤：游戏独占前台时鼠标键盘都到不了页面，只能靠外壳的全局热键代为转发
    if (message.type === "summon") {
      if (window.XJ && window.XJ.app && window.XJ.app.summon) window.XJ.app.summon();
      return true;
    }
    // 陪伴时长（A3）：C# 外壳记账，页面 postMessage 请求一次、这里回推一份快照。
    // （py 壳走 QWebChannel 信号，不经这里；payload 与信号那份同形）
    if (message.type === "companion") {
      if (window.XJ && window.XJ.app && window.XJ.app.companionData) window.XJ.app.companionData(message);
      return true;
    }
    // 截图提问：外壳抓完图把整屏塞进来，剩下的卡片交互全在页面里（app/src/shot.js）
    const shot = window.XJ && window.XJ.shot;
    if (!shot) return false;
    if (message.type === "shot") {
      shot.open(message.dataUrl, {
        width: message.width,
        height: message.height,
        sessionId: message.sessionId || "",
        sessionTitle: message.sessionTitle || "",
      });
      return true;
    }
    if (message.type === "shot-done") {
      shot.done(!!message.ok, message.message || "");
      return true;
    }
    if (message.type === "shot-polished") {
      shot.polished(message.text || "");
      return true;
    }
    if (message.type === "shot-polish-failed") {
      shot.polishFailed(message.reason || "");
      return true;
    }
    return false;
  }
  if (HOST === "app" && webview && typeof webview.addEventListener === "function") {
    try {
      webview.addEventListener("message", onShellMessage);
    } catch (e) {
      /* 老运行时没有这个 API，就用 :hover 顶着 */
    }
  }
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
  let lastCard = "";
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

  /**
   * 量「窗口真正该露出来的那几块区域」，单位是**物理像素**（已乘 devicePixelRatio）。
   *
   * 为什么是复数：气泡 / 输入条形态下 stage 里有两个 .form（气泡 + 鲸鱼球），中间还隔着
   * 12px 的 gap。早期只报一个 stage 外接矩形，外壳只能把整块矩形裁出来 ——
   * 于是气泡和球之间、球下面那一大片空白就露出一整块深底（2026-10-21 老大报的
   * 「窗口还是会有一大块黑色背景」）。现在每个 .form 一块，外壳用 CombineRgn 并起来，
   * 空隙真的被切掉，桌面直接透过来。
   *
   * 为什么乘 dpr：SetWindowRgn 吃的是物理像素，web/embed 里量到的是 CSS px。
   * 125% 缩放下两者差 1.25 倍，不换算在非 100% 的屏上会裁歪一整圈。
   */
  function cardRects() {
    const stage = document.getElementById("xj-stage") || document.body.firstElementChild;
    if (!stage) return null;
    const scale = window.devicePixelRatio || 1;
    const forms = stage.querySelectorAll ? stage.querySelectorAll(".form") : [];
    const nodes = forms.length ? forms : [stage];
    const out = [];
    for (let i = 0; i < nodes.length; i++) {
      const el = nodes[i];
      // 离场中的那份已经淡出、高度塌到 0，不该参与裁剪
      if (el.classList && el.classList.contains("xj-leaving")) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 8 || r.height < 8) continue;
      const rad = parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0;
      // 状态光环（.aura：待确认琥珀 / 离线灰虚线 / 未读绿闪）画在**球外面**：
      // inset:-3px 撑出 3px，再加 2px 的 box-shadow spread 或 border 宽，视觉外沿在球外 5px。
      // 这部分量不到（aura 一直在转，getBoundingClientRect 对旋转元素返回轴对齐外接框，
      // 70px 的环会报 90 多），所以按 CSS 里的 inset + 2 直接把这块矩形撑出去 ——
      // 不撑的话窗口外形会把光环整圈切掉（2026-10-21 实测：离线灰虚线环直接消失）。
      let pad = 0;
      const aura = el.querySelector ? el.querySelector(".aura.show") : null;
      if (aura) {
        const inset = Math.abs(parseFloat(getComputedStyle(aura).top) || 0);
        pad = (inset > 0 ? inset : 3) + 2;
      }
      out.push({
        x: Math.round((r.left - pad) * scale),
        y: Math.round((r.top - pad) * scale),
        w: Math.round((r.width + pad * 2) * scale),
        h: Math.round((r.height + pad * 2) * scale),
        r: Math.round(rad * scale),
      });
    }

    /* 探出球体的小角标（.badges 里的 .badge：待确认琥珀、未读绿）是绝对定位**在球外面**的，
       form 的 rect 量不到。外壳按球的椭圆裁的时候会把角标切掉一半 —— 2026-10-21 踩到。
       每个角标单独报一块，外壳对「小尺寸块」建椭圆再 OR 合并，结果正好是「球 + 角标」。 */
    const badges = stage.querySelectorAll ? stage.querySelectorAll(".badges .badge") : [];
    for (let i = 0; i < badges.length; i++) {
      const el = badges[i];
      const cs = getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) === 0) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 4 || r.height < 4) continue;
      const rad = parseFloat(cs.borderTopLeftRadius);
      out.push({
        x: Math.round(r.left * scale),
        y: Math.round(r.top * scale),
        w: Math.round(r.width * scale),
        h: Math.round(r.height * scale),
        r: Math.round((isNaN(rad) ? r.width / 2 : rad) * scale),
      });
    }
    return out.length ? out : null;
  }

  function reportSize() {
    if (HOST === "page" && (!window.parent || window.parent === window)) return;
    // 卡片几何：C# 独立窗是「不透明 + SetWindowRgn 裁外形」，页面里的 stage 有 22px
    // 内缩（双角标探出 + 呼吸光晕的空间），整窗裁剪会让透明内缩区透出窗体深底，
    // 看上去就是「大黑框套着小卡」（2026-10-21 老大报的）。外壳按下面报的
    // 每一块 .form 裁，内缩和 form 之间的空隙都被切掉，桌面干净。
    const rects = cardRects();
    if (rects) {
      const sig = JSON.stringify(rects);
      if (sig !== lastCard) {
        lastCard = sig;
        post({ type: "card", rects: rects });
      }
    }
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
  const unsupported = (what, msg) => {
    const err = new Error(what + " not supported in DSH overlay");
    err.code = 503;
    if (msg) err.userMessage = msg;
    return err;
  };

  /** 带「能直接给用户看」的文案的错误：composer 优先显示 userMessage */
  const userErr = (code, msg) => {
    const err = new Error(msg);
    err.code = code;
    err.userMessage = msg;
    return err;
  };

  class HostHarness {
    constructor() {
      this.sessions = [];
      this.pending = [];
      this.questions = [];
      this.connection = "online";
      this.subs = new Set();
      this.known = new Map();
      this.knownQuestions = new Map();
      this.timer = null;
      this.failures = 0;
      this.ticks = 0;
      this.usage = null;
      this.usageSig = "";
      // 附件暂存：composer 先 uploadAttachment(att) 拿 id，发送时只回传 id 列表，
      // 所以这里得自己留一份「id → 原始 att」，好在 prompt 时把 data URL 内联进请求体。
      this.uploads = new Map();
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
        // 提问（带选项那种）：跟审批一样靠「新出现 / 消失了」发事件，
        // 消失了就说明客户端已经答过（或者提问被撤），界面上把卡片摘掉即可。
        const nextQ = new Map((data.questions || []).map((q) => [q.id, q]));
        for (const [id, q] of nextQ) {
          if (this.knownQuestions.has(id)) continue;
          this.emit("question.requested", {
            question_id: id,
            session_id: q.session_id,
            session_title: q.session_title,
            questions: q.questions || [],
          });
        }
        for (const id of this.knownQuestions.keys()) {
          if (nextQ.has(id)) continue;
          this.emit("question.resolved", { question_id: id, decision: "answered", by: "web" });
        }
        this.knownQuestions = nextQ;
        this.questions = data.questions || [];
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
        questions: this.questions,
        usage: this.usage,
      };
    }

    /** 回答提问：payload = { answers: [{ id, selected: [...], custom? }] } */
    async answer(id, payload) {
      const res = await fetch("/xj/answer", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(Object.assign({ id }, payload || {})),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        const err = new Error(body.error || "answer failed");
        err.code = res.status;
        throw err;
      }
      return await res.json();
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

    /**
     * 发消息 → POST /xj/prompt。
     * 宿主那条路由的载荷是 { sessionId, text, mode, image? }，图片以 base64 内联，
     * 一次只收一张 —— 所以这里只认图片附件，且多于一张直接明说。
     */
    async prompt(sessionId, opts) {
      const o = opts || {};
      const text = typeof o.text === "string" ? o.text : "";
      const ids = Array.isArray(o.attachment_ids) ? o.attachment_ids : [];

      const images = [];
      for (const id of ids) {
        const att = this.uploads.get(String(id));
        if (!att) continue; // 缓存里没有（换了页面/清过缓存）：当纯文字发，别把整条消息拦下来
        if (att.kind !== "image") {
          throw userErr(415, "内嵌浮窗只能发图片，文字文件请到主界面发");
        }
        if (att.preview) images.push(att);
      }
      if (images.length > 1) throw userErr(415, "一次只能发一张图，先留一张吧");

      const body = { sessionId, text, mode: o.mode === "steer" ? "steer" : "queue" };
      if (images.length === 1) {
        const m = /^data:([^;,]+)(?:;[^,]*)?,([\s\S]*)$/.exec(images[0].preview || "");
        if (!m) throw userErr(415, "这张图读不出来，换一张试试");
        const mediaType = m[1].toLowerCase();
        if (!/^image\/(png|jpeg|webp|gif)$/.test(mediaType)) {
          throw userErr(415, "宿主只收 PNG / JPEG / WebP / GIF");
        }
        body.image = { mediaType, data: m[2], name: images[0].name || "" };
      }

      let res;
      try {
        res = await fetch("/xj/prompt", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
      } catch (_) {
        // 真的连不上宿主：交给 composer 走「离线」那条分支
        const err = new Error("prompt network failed");
        err.code = 503;
        throw err;
      }

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        const code = String(data && data.error ? data.error : "");
        if (res.status === 413) throw userErr(413, "图太大了（上限 20MB），压一下再发");
        if (res.status === 415) throw userErr(415, "这个格式宿主不收，换 PNG / JPEG");
        if (res.status === 422) {
          throw userErr(422, code === "missing_session" ? "先选一个会话再发" : "内容不能为空");
        }
        // prompt_unavailable 是宿主没拿到 sessionController，不是网络断了：
        // 用 502 而不是 503，免得 composer 把整个界面切成离线态。
        if (res.status === 503) throw userErr(502, "宿主没拿到会话控制器，重启 DSH 再试");
        const err = new Error(code || "prompt failed");
        err.code = res.status;
        throw err;
      }

      const data = await res.json().catch(() => ({}));
      // composer 只读 queued / session_id，其余字段留着方便排查
      return {
        ok: true,
        queued: false,
        session_id: sessionId,
        message_id: o.clientMsgId || data.requestId || "",
        request_id: data.requestId || "",
      };
    }

    /** 附件：宿主路由只收内联图片，这里不做真实上传，只登记并回一个 id */
    async uploadAttachment(att) {
      if (!att) throw userErr(415, "附件读不出来");
      if (att.kind !== "image") {
        throw userErr(415, "内嵌浮窗只能发图片，文字文件请到主界面发");
      }
      const id = att.localId || "att_" + Math.random().toString(36).slice(2);
      this.uploads.set(String(id), att);
      // 缓存别无限长：够一次发送就行
      if (this.uploads.size > 20) {
        this.uploads.delete(this.uploads.keys().next().value);
      }
      return { attachment_id: id };
    }

    /**
     * 停止当前这一轮 → POST /xj/stop。
     * 宿主走 sessionController.cancel({ sessionId })：只取消正在跑的 turn，排队里的消息保留。
     * 幂等：已经停了的会话再点一次也是 200，不用防连点。
     */
    async stop(sessionId) {
      const id = String(sessionId || "").trim();
      if (!id) throw userErr(422, "先选一个会话");

      let res;
      try {
        res = await fetch("/xj/stop", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id }),
        });
      } catch (_) {
        const err = new Error("stop network failed");
        err.code = 503;
        throw err;
      }

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        if (res.status === 404) throw userErr(404, "这个会话已经不在跑了");
        if (res.status === 422) throw userErr(422, "先选一个会话");
        // 跟 /xj/prompt 一样：503 是「宿主没拿到控制器」，不是断网，别让界面切离线态
        if (res.status === 503) throw userErr(502, "宿主没拿到会话控制器，重启 DSH 再试");
        throw userErr(res.status, String((data && data.detail) || "没停下来，稍后再试"));
      }
      return await res.json().catch(() => ({ ok: true }));
    }
    newSession() {
      return Promise.reject(unsupported("newSession", "浮窗里不能新建会话，去主界面开一个"));
    }
    tick() {}
    /**
     * 故意是空实现：嵌入态的「连上了没」只有一个真相来源 —— 1.5s 一次的 /xj/state
     * 轮询（成功才 emit connection.online），以及外壳探活推过来的 connection 消息。
     * 页面没有任何办法靠一句话把连接变出来（以前 app.js 的 reconnect 就在这里调它，
     * 结果 DSH 没开也提示「连接已恢复」）。要重连请用 XJ.app.reconnect()，它走 probeShell。
     */
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
    probeShell,
    // 外壳还没回报过就是 null（退回用 CSS :hover）
    pointerInside: () => pointerInside,
  };
})();
