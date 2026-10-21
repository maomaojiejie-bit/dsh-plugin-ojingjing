/* =============================================================================
   view-bubble.js · 形态一「收起态 64px」+ 形态二「气泡 360」
   ========================================================================== */
(function () {
  const XJ = (window.XJ = window.XJ || {});
  const { h, truncate } = XJ.dom;
  const A = () => XJ.state.actions;

  /* ============================ 收起态 ============================ */
  function collapsed(s) {
    const st = XJ.state.mainStatus(s);
    const counts = { pending: st.pending, unread: st.unread };

    const orb = h(
      "div",
      {
        // is-offline / is-reconnecting 不只为视觉：连接态变化必须让 stage HTML 变化，
        // 否则 render 的 diff 闸门会把「重连恢复」整段跳过，B3 的苏醒动画就没了触发点
        //（reconnecting 和 online 的表情/光环可以一模一样，光看 whale 是分别不出来的）。
        class:
          "orb" +
          (s.connection === "offline" ? " is-offline" : "") +
          (s.connection === "reconnecting" ? " is-reconnecting" : ""),
        role: "button",
        tabindex: "0",
        "aria-label": "哦鲸鲸 · " + st.label + (counts.pending ? "，" + counts.pending + " 项待确认" : ""),
        title: "哦鲸鲸 · " + st.label,
        onpointerdown: (e) => XJ.app.orbPointerDown(e),
        onkeydown: (e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            XJ.app.openPanel();
          }
        },
        oncontextmenu: (e) => {
          e.preventDefault();
          XJ.app.openPanel();
        },
        onmouseenter: () => XJ.app.orbHoverStart(),
        onmouseleave: (e) => XJ.app.orbHoverEnd(e),
      },
      h("div", { class: "aura aura-" + st.aura + (st.aura !== "none" ? " show" : "") }),
      XJ.ui.whale(st.expression, 52),
      XJ.ui.needsBadges(counts) ? XJ.ui.badges(counts) : null,
      h("div", { class: "drop-hint" }, "松手发送到《" + (XJ.state.resolveTargetSession(s) || {}).title + "》")
    );

    return h("div", { class: "form form-collapsed" }, orb);
  }

  /* ============================ 气泡 ============================ */
  function bubble(s) {
    const st = XJ.state.mainStatus(s);
    const counts = { pending: st.pending, unread: st.unread };
    const sessions = XJ.state.sortedSessions(s);
    const shown = sessions.slice(0, 5);
    const pendingBySession = new Map();
    XJ.state.pendingList(s).forEach((p) => {
      if (!pendingBySession.has(p.sessionId)) pendingBySession.set(p.sessionId, []);
      pendingBySession.get(p.sessionId).push(p);
    });

    /* --- 头部 --- */
    const head = h(
      "div",
      { class: "bubble-head" },
      XJ.ui.whale(st.expression, 32),
      h(
        "div",
        { class: "bubble-head-text" },
        h(
          "div",
          { class: "bubble-status" },
          XJ.ui.statusDot(st.tone === "warning" ? "amber" : st.tone === "success" ? "green" : st.tone === "offline" ? "gray" : ""),
          h("span", { class: "ellipsis" }, st.label)
        ),
        h(
          "div",
          { class: "bubble-sub" },
          h("span", { class: "ellipsis" }, compactHeadline(s))
        )
      ),
      h("div", { class: "spacer" }),
      XJ.ui.iconBtn("collapse", { title: "收起", size: 15, onClick: () => XJ.app.collapse() })
    );

    /* --- 会话行 --- */
    let rows;
    if (s.connection === "offline") {
      rows = h(
        "div",
        { class: "empty" },
        h("div", { class: "empty-whale" }, XJ.ui.whale("offline", 56)),
        h("div", { class: "empty-title" }, "连不上 Harness"),
        h("div", { class: "empty-sub" }, "正在自动重连，恢复后我会马上同步"),
        h(
          "div",
          { style: { marginTop: "14px", display: "flex", justifyContent: "center" } },
          h("button", { class: "btn-ghost btn-sm", onclick: () => XJ.app.reconnect() }, XJ.icon("refresh", 13), "立即重连")
        )
      );
    } else if (!shown.length) {
      rows = h(
        "div",
        { class: "empty" },
        h("div", { class: "empty-whale" }, XJ.ui.whale("sleep", 56)),
        h("div", { class: "empty-title" }, "都跑完了，没有待处理的"),
        h("div", { class: "empty-sub" }, "有新进展我第一时间喊老大")
      );
    } else {
      rows = h(
        "div",
        { class: "rows" },
        shown.map((sess) => {
          const pend = pendingBySession.get(sess.id) || [];
          return sessionRow(s, sess, pend);
        })
      );
    }

    /* --- 底部工具条 --- */
    const dndOn = XJ.state.inDndWindow(s);
    const foot = h(
      "div",
      { class: "bubble-foot" },
      h("span", { class: "foot-count" }, "共 " + sessions.length + " 个会话"),
      h("div", { class: "spacer" }),
      XJ.ui.iconBtn("camera", {
        title: "截图提问（Ctrl+Shift+A）",
        size: 15,
        onClick: XJ.ui.guard(s, () => XJ.app.startCapture()),
      }),
      XJ.ui.iconBtn("chat", {
        title: "快速对话（Ctrl+Shift+Q）",
        size: 15,
        onClick: XJ.ui.guard(s, () => XJ.app.openQuickbar()),
      }),
      XJ.ui.iconBtn("moon", {
        title: dndOn ? "免打扰进行中，点击关闭" : "开启免打扰 1 小时",
        size: 15,
        active: dndOn,
        onClick: () => XJ.app.toggleDndQuick(),
      }),
      XJ.ui.iconBtn("settings", { title: "设置", size: 15, onClick: () => XJ.app.openSettings() }),
      h(
        "button",
        { class: "btn-link primary", onclick: () => XJ.app.openPanel() },
        "展开面板",
        XJ.icon("chevronRight", 12)
      ),
      h(
        "button",
        { class: "btn-solid btn-sm", onclick: () => XJ.app.openMainWindow() },
        XJ.icon("external", 12),
        "主界面"
      )
    );

    /* --- 台词条：鲸鱼开口说的第一句 --- */
    /* 放在「状态行」下面、「会话列表」上面：先打个招呼，再报数据。
       ui.line 由 app.js 在 hover 时刷新；这里是兜底（比如键盘触发没走 hover），
       抽完必须写回状态，否则每次 render 都会重新抽、台词乱跳。 */
    let line = XJ.lines ? s.ui.line : null;
    if (!line && XJ.lines) {
      s.ui.line = XJ.lines.pick(s);
      line = s.ui.line;
    }
    const lineNode = line
      ? h(
          "div",
          {
            class: "bubble-line line-" + line.ctx,
            role: "note",
            "aria-live": "polite",
            dataset: { enterKey: "line:" + line.text },
          },
          h("span", { class: "line-text" }, line.text)
        )
      : null;

    return h(
      "div",
      { class: "form bubble glass", onmouseenter: () => XJ.app.cancelHoverTimer(), onmouseleave: (e) => XJ.app.orbHoverEnd(e) },
      head,
      lineNode,
      rows,
      foot
    );
  }

  /** 气泡头部副标题：比面板更短，360px 里放得下（§8.2） */
  function compactHeadline(s) {
    const st = XJ.state.mainStatus(s);
    if (s.connection === "offline") return "连不上 Harness，正在重试";
    if (s.connection === "reconnecting") return "重连中…";
    const bits = [];
    const working = s.sessions.filter((x) => x.state === "working").length;
    if (working) bits.push("正在执行 " + working + " 个任务");
    if (st.pending) bits.push(st.pending + " 项待确认");
    if (st.unread) bits.push(st.unread + " 条未读");
    return bits.join(" · ") || "现在没有在跑的任务";
  }

  function sessionRow(s, sess, pending) {
    const hasPending = pending.length > 0;
    const masked = XJ.state.presenting(s);
    const meta = [];
    if (hasPending) {
      meta.push("等你确认");
    } else if (sess.state === "working") {
      meta.push(masked ? "正在处理" : truncate(sess.action || "正在处理", 20));
    } else if (sess.unread) {
      meta.push("刚跑完");
    } else {
      meta.push(masked ? "空闲" : truncate(sess.action || "空闲", 20));
    }

    return h(
      "div",
      {
        class: "row",
        role: "button",
        tabindex: "0",
        title: sess.title,
        dataset: { sessionId: sess.id },
        onclick: () => {
          if (hasPending) {
            XJ.app.openApprovalCenter(pending[0].id);
          } else if (sess.unread) {
            A().sessionViewed(sess.id);
            XJ.app.openPanel();
          } else {
            A().sessionViewed(sess.id);
            XJ.app.openMainWindow();
          }
        },
        onkeydown: (e) => {
          if (e.key === "Enter") e.currentTarget.click();
        },
      },
      h(
        "div",
        { class: "row-main" },
        h(
          "div",
          { class: "row-title" },
          sess.unread ? h("span", { class: "unread-dot" }) : null,
          h("span", { class: "ellipsis" }, XJ.state.displayTitle(s, sess))
        ),
        h("div", { class: "row-meta" }, h("span", { class: "ellipsis" }, meta[0]), h("span", { class: "t-ter" }, "·"), XJ.ui.rel(sess.lastActivityAt))
      ),
      hasPending
        ? h("button", { class: "btn-mini", onclick: (e) => { e.stopPropagation(); XJ.app.openApprovalCenter(pending[0].id); } }, "查看")
        : XJ.ui.sessionPill(sess, false)
    );
  }

  XJ.views = XJ.views || {};
  XJ.views.collapsed = collapsed;
  XJ.views.bubble = bubble;
})();
