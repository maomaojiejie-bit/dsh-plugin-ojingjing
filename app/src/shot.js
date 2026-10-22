/**
 * 截图提问卡（独立窗专用）
 *
 * 流程：Ctrl+Shift+A → 外壳抓整屏 → 推到这里 → 卡片预览 → 可写问题 / AI 优化 / 重新截 / 发送。
 * 发送与优化都交给外壳（Python）做：页面拿不到剪贴板以外的系统能力，
 * 真正投递走的是外壳里的 POST /xj/prompt。
 *
 * 对外：XJ.shot.open(dataUrl, meta) / XJ.shot.node(s) / XJ.shot.done(ok, msg)
 *       XJ.shot.polished(text) / XJ.shot.polishFailed(reason) / window.XJShot
 */
(function () {
  var XJ = (window.XJ = window.XJ || {});
  var h = XJ.dom.h;

  var state = {
    active: false,
    dataUrl: "",
    text: "",
    width: 0,
    height: 0,
    status: "draft", // draft | polishing | sending | ok | fail
    message: "",
    polishNote: "",
    sessionTitle: "",
    // 目标会话：外壳抓完图时把它挑的那个带过来（meta.sessionId）当默认值，
    // 用户可以在卡片上换。空串 = 还没选（交给外壳自动挑）。
    sessionId: "",
    // 会话选择器开合（声明式：跟着卡片一起重建，不会因轮询重渲染丢掉）
    pickerOpen: false,
  };

  // WebView2 外壳（host=app）没有 window.xjNative，只有 postMessage：
  // 这里补一层同形的假桥，让下面 call() 的调用点一行都不用改。
  // 注意：外壳认的是 send / retake / polish 三个动词（Python 版的槽函数名是 sendShot/retakeShot/polishShot，
  // 这里是 postMessage，得用外壳那侧的名字，否则消息到了也不认）
  var shellBridge = {
    sendShot: function (json) {
      post("send", json);
    },
    retakeShot: function () {
      post("retake", "");
    },
    polishShot: function (json) {
      post("polish", json);
    },
  };

  function textOf(json) {
    try {
      return String((JSON.parse(json) || {}).text || "");
    } catch (err) {
      return "";
    }
  }

  function post(action, json) {
    if (!window.XJ || !XJ.embed || !XJ.embed.post) return;
    var o = {};
    try {
      o = JSON.parse(json) || {};
    } catch (err) {
      o = {};
    }
    XJ.embed.post({
      type: "shot-action",
      action: action,
      text: textOf(json),
      // 发送时带上用户挑的会话；空串 = 没挑，外壳按老规矩自动挑
      sessionId: String(o.sessionId || ""),
    });
  }

  function bridge() {
    var native = window.xjNative || (window.pywebview && window.pywebview.api) || null;
    if (native) return native;
    if (window.XJ && XJ.embed && XJ.embed.host === "app") return shellBridge;
    return null;
  }

  function call(name, arg) {
    var b = bridge();
    if (!b || typeof b[name] !== "function") return false;
    try {
      if (arg === undefined) b[name]();
      else b[name](arg);
      return true;
    } catch (err) {
      return false;
    }
  }

  function open(dataUrl, meta) {
    meta = meta || {};
    state.active = true;
    state.dataUrl = dataUrl || "";
    state.width = meta.width || 0;
    state.height = meta.height || 0;
    state.sessionTitle = meta.sessionTitle || "";
    state.sessionId = meta.sessionId || "";
    state.text = meta.text || "";
    state.status = "draft";
    state.message = "";
    state.polishNote = "";
    state.pickerOpen = false;
    state.openedAt = Date.now();
    XJ.state.store.emit && XJ.state.store.emit();
  }

  function close() {
    state.active = false;
    state.status = "draft";
    state.message = "";
    state.pickerOpen = false;
    XJ.state.store.emit && XJ.state.store.emit();
  }

  function done(ok, msg) {
    if (!state.active) return;
    state.status = ok ? "ok" : "fail";
    state.message = msg || "";
    XJ.state.store.emit && XJ.state.store.emit();
    if (ok) setTimeout(function () { if (state.status === "ok") close(); }, 1400);
  }

  function polished(text) {
    if (!state.active) return;
    state.status = "draft";
    state.text = text || state.text;
    state.polishNote = "已优化";
    state.message = "";
    XJ.state.store.emit && XJ.state.store.emit();
  }

  function polishFailed(reason) {
    if (!state.active) return;
    state.status = "draft";
    state.polishNote = "";
    state.message = reason || "优化没成功，直接发也行";
    XJ.state.store.emit && XJ.state.store.emit();
  }

  function send() {
    if (!state.active || state.status === "sending") return;
    state.status = "sending";
    state.message = "正在发送…";
    state.pickerOpen = false;
    XJ.state.store.emit && XJ.state.store.emit();
    call("sendShot", JSON.stringify({ text: state.text, sessionId: state.sessionId || "" }));
  }

  function retake() {
    state.active = false;
    XJ.state.store.emit && XJ.state.store.emit();
    call("retakeShot");
  }

  function polish() {
    if (!state.active || state.status === "polishing" || state.status === "sending") return;
    state.status = "polishing";
    state.message = "正在优化问法…";
    XJ.state.store.emit && XJ.state.store.emit();
    if (!call("polishShot", JSON.stringify({ text: state.text }))) {
      polishFailed("外壳没接上，优化不可用");
    }
  }

  // ---------------------------------------------------------------- 目标会话
  /** 当前挑中的会话名：挑了就用商店里的（演示模式会降级成「会话 N」），没挑就用外壳带的默认标题 */
  function targetTitle(s) {
    if (state.sessionId) {
      var sess = XJ.state.sessionById(s, state.sessionId);
      if (sess) return XJ.state.displayTitle(s, sess);
    }
    return state.sessionTitle || "";
  }

  function targetBtn(s) {
    var busy = state.status === "sending" || state.status === "polishing" || state.status === "ok" || state.status === "fail";
    var t = targetTitle(s);
    return h(
      "button",
      {
        class: "shot-target",
        type: "button",
        title: t ? "发送到《" + t + "》，点击更换" : "选择发送到哪个会话",
        disabled: busy ? true : null,
        onClick: function () {
          state.pickerOpen = !state.pickerOpen;
          XJ.state.store.emit();
        },
      },
      XJ.icon(t ? "chat" : "plus", 12),
      h("span", { class: "ellipsis" }, t ? "《" + t + "》" : "选个会话"),
      XJ.icon("chevronDown", 12)
    );
  }

  function pickerNode(s) {
    var pendingBy = {};
    XJ.state.pendingList(s).forEach(function (p) {
      if (!pendingBy[p.sessionId]) pendingBy[p.sessionId] = [];
      pendingBy[p.sessionId].push(p);
    });
    var alive = XJ.state.sortedSessions(s).filter(function (x) {
      return x.state !== "closed";
    });
    var rows = alive.map(function (sess) {
      var on = sess.id === state.sessionId;
      return h(
        "button",
        {
          class: "xj-pick-row" + (on ? " on" : ""),
          type: "button",
          onClick: function () {
            state.sessionId = sess.id;
            state.pickerOpen = false;
            XJ.state.store.emit();
          },
        },
        XJ.icon("chat", 13),
        h(
          "div",
          { class: "xj-pick-main" },
          h("span", { class: "xj-pick-title ellipsis" }, XJ.state.displayTitle(s, sess)),
          h(
            "span",
            { class: "xj-pick-sub ellipsis" },
            sess.state === "working"
              ? XJ.state.presenting(s)
                ? "正在处理"
                : sess.action || "正在处理"
              : XJ.dom.fmtRel(sess.lastActivityAt)
          )
        ),
        XJ.ui.sessionPill(sess, (pendingBy[sess.id] || []).length),
        on ? h("span", { class: "xj-pick-check" }, XJ.icon("check", 13)) : null
      );
    });
    return h(
      "div",
      { class: "shot-pick" },
      h("div", { class: "shot-pick-head" }, "发送到"),
      rows.length
        ? h("div", { class: "shot-pick-list" }, rows)
        : h("div", { class: "shot-pick-empty" }, "没有可发送的会话 —— Harness 没开？")
    );
  }

  // ---------------------------------------------------------------- 视图
  function node(s) {
    var busy = state.status === "sending" || state.status === "polishing";
    var okState = state.status === "ok";
    var failState = state.status === "fail";
    var ta = h("textarea", {
      class: "shot-input",
      rows: 2,
      placeholder: "问点什么…（留空就只发图）",
      dataset: { focus: "shot-input" },
      disabled: busy || okState ? true : null,
    });
    ta.value = state.text || "";
    ta.addEventListener("input", function () {
      state.text = ta.value;
      if (state.polishNote) state.polishNote = "";
    });
    ta.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        // 卡片刚弹出时忽略回车：截图时按下的那一下 Enter 可能刚好落到这张卡上
        if (Date.now() - (state.openedAt || 0) < 350) return;
        send();
      }
    });
    requestAnimationFrame(function () {
      if (document.activeElement !== ta) return;
      ta.style.height = "auto";
      ta.style.height = Math.min(96, ta.scrollHeight) + "px";
    });

    var statusRow = null;
    if (state.status === "sending" || state.status === "polishing") {
      statusRow = h(
        "div",
        { class: "shot-status is-busy" },
        h("span", { class: "spinner" }),
        h("span", null, state.message)
      );
    } else if (okState) {
      statusRow = h("div", { class: "shot-status is-ok" }, h("span", null, state.message || "已发送"));
    } else if (failState || (state.message && state.status === "draft")) {
      statusRow = h("div", { class: "shot-status is-fail" }, h("span", null, state.message));
    }

    return h(
      "div",
      { class: "form form-shot" },
      h(
        "div",
        { class: "shot-card" + (okState ? " is-ok" : "") + (failState ? " is-fail" : "") },
        h(
          "div",
          { class: "shot-head" },
          h("span", { class: "shot-title" }, "截图提问"),
          h("span", { class: "shot-meta" }, state.width && state.height ? state.width + " × " + state.height : ""),
          targetBtn(s),
          h(
            "button",
            {
              class: "icon-btn shot-close",
              "aria-label": "关闭",
              onClick: function () {
                if (state.status !== "sending") close();
              },
            },
            XJ.icon("close", 16)
          )
        ),
        // 会话选择器：内联展开（不搞浮层——独立窗高度跟内容走，浮层探出窗口会被裁）
        state.pickerOpen ? pickerNode(s) : null,
        h(
          "div",
          { class: "shot-thumb" },
          state.dataUrl ? h("img", { src: state.dataUrl, alt: "截图预览" }) : null
        ),
        ta,
        state.polishNote ? h("div", { class: "shot-note" }, "✨ " + state.polishNote) : null,
        statusRow,
        h(
          "div",
          { class: "shot-actions" },
          h(
            "button",
            {
              class: "btn-ghost btn-sm shot-wand" + (state.status === "polishing" ? " is-busy" : ""),
              disabled: busy || okState ? true : null,
              onClick: polish,
            },
            "✨ 优化"
          ),
          h("span", { class: "spacer" }),
          h(
            "button",
            {
              class: "btn-ghost btn-sm",
              disabled: busy || okState ? true : null,
              onClick: function () {
                if (state.status !== "sending") close();
              },
            },
            "取消"
          ),
          h(
            "button",
            {
              class: "btn-ghost btn-sm",
              disabled: busy || okState ? true : null,
              onClick: retake,
            },
            "重新截"
          ),
          h(
            "button",
            {
              class: "btn-solid btn-sm shot-send",
              disabled: busy || okState ? true : null,
              onClick: send,
            },
            state.status === "sending" ? "发送中…" : "发送"
          )
        )
      )
    );
  }

  XJ.shot = {
    state: state,
    open: open,
    close: close,
    done: done,
    polished: polished,
    polishFailed: polishFailed,
    send: send,
    retake: retake,
    polish: polish,
    node: node,
    get active() {
      return state.active;
    },
  };
  window.XJShot = XJ.shot;
})();
