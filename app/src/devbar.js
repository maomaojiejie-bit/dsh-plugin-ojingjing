/* =============================================================================
   devbar.js · 原型控制台（非产品 UI，评审用）
   把设计稿里"需要真机才能触发"的场景做成按钮：断线、竞态、过期、演示模式、
   全屏静默、免打扰、窄屏密度——这样 v0.3 的状态模型可以当场验收。
   ========================================================================== */
(function () {
  const XJ = (window.XJ = window.XJ || {});
  const { h, fmtClock } = XJ.dom;
  const S = () => XJ.state.store.state;
  const A = () => XJ.state.actions;

  let showLog = false;

  function devbar(s) {
    const wrap = h("div", { class: "devbar", "data-devbar": "1" });
    const panel = h("div", { class: "dev-panel" });

    const sep = () => h("span", { class: "dev-sep" });
    const lbl = (t) => h("span", { class: "dev-label" }, t);
    const b = (label, onClick, opts) => {
      const o = opts || {};
      return h(
        "button",
        { class: "dev-btn" + (o.on ? " on" : ""), title: o.title || label, onclick: onClick },
        label
      );
    };

    /* ---- 主状态场景（§4.3.2 真值表逐行） ---- */
    panel.append(
      lbl("场景"),
      b("空闲", () => scenario("sleep")),
      b("工作中", () => scenario("focus")),
      b("待确认", () => scenario("alert")),
      b("完成未读", () => scenario("happy")),
      b("离线", () => scenario("offline")),
      sep(),
      lbl("连接"),
      b(
        "断网",
        () => {
          XJ.mock.harness.setConnected(false);
          A().setConnection("offline");
          XJ.ui.toast({ type: "warn", title: "连接已断开", sub: "所有动作置灰，30 秒内恢复不算离线" });
        },
        { on: s.connection === "offline" }
      ),
      b("恢复", () => XJ.app.reconnect()),
      b("重连中", () => {
        A().setConnection("reconnecting");
        XJ.ui.toast({ type: "info", title: "重连中…", sub: "气泡头部显示重连中，动作仍可用" });
      }),
      sep(),
      lbl("事件"),
      b("审批", () => push("exec")),
      b("高危", () => push("danger")),
      b("只读", () => push("read")),
      b("提问", () => {
        XJ.mock.harness.pushQuestion();
        XJ.ui.toast({ type: "info", title: "Agent 提了一个问题", sub: "它也会计入待办 N" });
      }),
      b("完成", () => {
        const target = s.sessions.find((x) => x.state === "working");
        if (!target) {
          XJ.ui.toast({ type: "info", title: "没有在跑的会话", sub: "先切一次「工作中」" });
          return;
        }
        XJ.mock.harness.emit("session.completed", { session_id: target.id, reply: "（原型：手动触发完成）" });
      }),
      sep(),
      lbl("竞争"),
      b("网页先处理", () => {
        const first = XJ.state.pendingList(s)[0];
        if (!first) {
          XJ.ui.toast({ type: "info", title: "现在没有待办审批" });
          return;
        }
        XJ.mock.harness.resolveElsewhere(first.id, "allow");
        XJ.ui.toast({ type: "info", title: "主窗口先点了通过", sub: "浮窗应 ≤1s 跟着灰化消失" });
      }),
      b("让它过期", () => {
        const first = XJ.state.pendingList(s)[0];
        if (!first) return;
        XJ.mock.harness.expireApproval(first.id);
      }),
      sep(),
      lbl("环境"),
      b(
        "演示模式",
        () => {
          A().patchSettings({ presentation: XJ.state.presenting(s) ? "off" : "always" });
          XJ.ui.toast({
            type: "info",
            title: XJ.state.presenting(s) ? "已退出演示模式" : "演示模式：共享画面上看不到正文",
            sub: "命令折叠、会话名降级为「会话 1」，截图入口置灰",
          });
        },
        { on: XJ.state.presenting(s) }
      ),
      b(
        "全屏静默",
        () => {
          s.runtime.silent = !s.runtime.silent;
          A().patchSettings({});
          XJ.ui.toast({ type: "info", title: s.runtime.silent ? "全屏中：静音 + 静态帧" : "已退出全屏" });
        },
        { on: s.runtime.silent }
      ),
      b(
        "免打扰",
        () => {
          const on = !(s.settings.dndEnabled && s.settings.dndFrom === "00:00");
          A().patchSettings({ dndEnabled: on, dndFrom: on ? "00:00" : "22:00", dndTo: on ? "23:59" : "08:00" });
          XJ.ui.toast({
            type: "info",
            title: on ? "免打扰：只留一条通知，角标不会消失" : "已退出免打扰",
          });
        },
        { on: s.settings.dndEnabled && s.settings.dndFrom === "00:00" }
      ),
      b(
        "减少动画",
        () => {
          const on = !document.body.classList.contains("reduce-motion");
          document.body.classList.toggle("reduce-motion", on);
          A().patchSettings({ motion: on ? "reduce" : "system" });
        },
        { on: document.body.classList.contains("reduce-motion") }
      ),
      b(
        "静态帧",
        () => {
          document.body.classList.toggle("static-frame");
          A().patchSettings({});
        },
        { on: document.body.classList.contains("static-frame") }
      ),
      b(
        "窄屏密度",
        () => {
          document.body.classList.toggle("density");
          A().patchSettings({});
        },
        { on: document.body.classList.contains("density") },
        { title: "模拟 1366×768@150%：会话卡压成单行" }
      ),
      sep(),
      lbl("面板"),
      b("引导", () => {
        s.ui.onboardingStep = 0;
        s.ui.showOnboarding = true;
        A().patchSettings({});
        A().setForm("panel");
      }),
      b("设置", () => XJ.app.openSettings()),
      b("审批中心", () => XJ.app.openApprovalCenter()),
      b("截图", () => XJ.capture.start()),
      sep(),
      b(showLog ? "隐藏事件" : "事件日志", () => {
        showLog = !showLog;
        A().patchSettings({});
      }, { on: showLog }),
      b("重置", () => {
        if (!confirm("重置所有状态？会话、审批、设置都会回到初始值。")) return;
        XJ.platform.store.remove("settings");
        XJ.platform.store.remove("draft");
        XJ.mock.harness.reset();
        s.approvals = {};
        s.questions = {};
        s.composer.attachments = [];
        s.composer.text = "";
        s.composer.lastReply = null;
        s.ui.panelScreen = "home";
        s.ui.showOnboarding = false;
        A().setForm("collapsed");
        XJ.app.loadSnapshot();
        XJ.ui.toast({ type: "success", title: "已重置" });
      })
    );

    wrap.append(
      h(
        "button",
        {
          class: "dev-toggle",
          title: "原型控制台",
          "aria-label": "原型控制台",
          onclick: () => wrap.classList.toggle("hidden"),
        },
        XJ.icon("wand", 16)
      ),
      panel
    );
    return wrap;
  }

  /* ---------- 场景切换：直接改 mock 再对账 ---------- */
  function scenario(kind) {
    const hz = XJ.mock.harness;
    const st = S();
    const sessions = hz.sessions;

    // 先清掉所有审批，避免场景之间互相污染
    hz.approvals.clear();
    st.approvals = {};
    st.questions = {};

    if (kind === "offline") {
      hz.setConnected(false);
      A().setConnection("offline");
      XJ.ui.toast({ type: "warn", title: "离线态", sub: "鲸鱼转灰、光环虚线、动作全部置灰" });
      return;
    }
    if (!hz.connected) hz.setConnected(true);

    switch (kind) {
      case "sleep":
        sessions.forEach((x) => {
          x.state = "idle";
          x.progress = 0;
          x.unread = false;
          x.stoppedByUser = false;
        });
        A().setConnection("online");
        A().setSnapshot({ sessions, connection: "online" });
        XJ.ui.toast({ type: "info", title: "空闲态", sub: "睡觉 + zzz，无光环、无角标" });
        break;
      case "focus":
        sessions.forEach((x, i) => {
          x.state = i === 0 ? "working" : "idle";
          x.progress = i === 0 ? 62 : 100;
          x.unread = false;
          if (i === 0) x.action = "正在编辑 src/auth/token.ts";
        });
        A().setConnection("online");
        A().setSnapshot({ sessions, connection: "online" });
        break;
      case "happy":
        sessions.forEach((x, i) => {
          x.state = "idle";
          x.progress = 100;
          x.unread = i < 2;
        });
        A().setConnection("online");
        A().setSnapshot({ sessions, connection: "online" });
        XJ.ui.toast({ type: "info", title: "完成未读", sub: "眯眼笑 + 星星，右下角翠绿 M" });
        break;
      case "alert":
        A().setConnection("online");
        A().setSnapshot({ sessions, connection: "online" });
        push("exec");
        break;
    }
  }

  function push(kind) {
    const s = S();
    const target = s.sessions.find((x) => x.state === "working") || s.sessions[0];
    XJ.mock.harness.pushApproval(kind, target && target.id);
  }

  /* ---------- 事件日志抽屉 ---------- */
  function logDrawer(s) {
    if (!showLog) return null;
    const body = h("div", { class: "log-body" });
    if (!s.events.length) {
      body.append(h("div", { class: "log-line", style: { padding: "10px" } }, "还没有事件"));
    }
    s.events.forEach((ev) => {
      body.append(
        h(
          "div",
          { class: "log-line", title: JSON.stringify(ev.payload) },
          h("span", { class: "t" }, fmtClock(ev.at)),
          h("span", { class: "ev" }, ev.type),
          " ",
          h("span", { class: "pl" }, summarize(ev.payload))
        )
      );
    });
    return h(
      "div",
      { class: "log-drawer" },
      h(
        "div",
        { class: "log-head" },
        XJ.icon("list", 12),
        h("span", null, "事件流（模拟 SSE）"),
        h("span", { class: "spacer" }),
        h("span", null, s.events.length + " 条"),
        h(
          "button",
          { class: "btn-mini", style: { marginLeft: "6px" }, onclick: () => { showLog = false; A().patchSettings({}); } },
          "收起"
        )
      ),
      body
    );
  }

  function summarize(p) {
    if (!p) return "";
    const parts = [];
    const map = {
      approval_id: "ap",
      session_id: "sess",
      id: "id",
      risk: "risk",
      decision: "决定",
      by: "来源",
      count: "count",
      to: "→",
      from: "←",
      unread: "未读",
    };
    Object.keys(p).slice(0, 4).forEach((k) => {
      const v = p[k];
      if (v === undefined || v === null) return;
      parts.push((map[k] || k) + "=" + (typeof v === "object" ? "…" : String(v)));
    });
    return parts.join(" · ");
  }

  XJ.views = XJ.views || {};
  XJ.views.devbar = devbar;
  XJ.views.logDrawer = logDrawer;
})();
