/* =============================================================================
   view-panel.js · 形态四「面板 400 × 480/560/600」（§8.3 / §8.6 / §9.5）
   布局：头部 56 · 快捷动作 64 · 审批卡（钉顶，不进滚动）· 会话滚动区 · Composer（钉底）
   ========================================================================== */
(function () {
  const XJ = (window.XJ = window.XJ || {});
  const { h, fmtRel, truncate } = XJ.dom;
  const S = () => XJ.state.store.state;
  const A = () => XJ.state.actions;

  function panel(s) {
    const st = XJ.state.mainStatus(s);
    const counts = { pending: st.pending, unread: st.unread };
    const pending = XJ.state.pendingList(s);
    const hasPending = counts.pending > 0;

    // 高度档位：空态 480 / 常规 560 / 有待办 600
    const size = counts.pending > 0 ? "600" : s.sessions.length ? "560" : "480";

    const el = h(
      "div",
      { class: "form panel glass h" + size, role: "dialog", "aria-label": "哦鲸鲸面板" },
      header(s, st, counts),
      quickActions(s, counts),
      hasPending ? pendingZone(s, pending) : null,
      sessionList(s),
      XJ.composer.render(s, "panel")
    );
    return el;
  }

  /* ---------------- 头部 ---------------- */
  function header(s, st, counts) {
    const offline = s.connection === "offline";
    return h(
      "div",
      { class: "panel-head" },
      XJ.ui.whale(st.expression, 40),
      h(
        "div",
        { class: "panel-head-text" },
        h(
          "div",
          { class: "panel-head-title" },
          "哦鲸鲸",
          h(
            "span",
            { class: "t-ter", style: { fontWeight: "400", fontSize: "11px", marginLeft: "7px" } },
            offline ? "离线" : "已连接"
          )
        ),
        h(
          "div",
          { class: "panel-head-sub" },
          offline
            ? "连接已断开，正在重连…"
            : XJ.ui.headline(s)
        )
      ),
      XJ.ui.iconBtn("settings", { title: "设置", size: 16, onClick: () => XJ.app.openSettings() }),
      XJ.ui.iconBtn("collapse", { title: "收起（Esc）", size: 16, onClick: () => XJ.app.collapse() })
    );
  }

  /* ---------------- 快捷动作 ---------------- */
  function quickActions(s, counts) {
    const offline = s.connection === "offline";
    return h(
      "div",
      { class: "quick-actions" },
      qa("plus", "新会话", XJ.ui.guard(s, () => XJ.app.openNewSession())),
      qa(
        "shield",
        "审批中心",
        XJ.ui.guard(s, () => XJ.app.openApprovalCenter()),
        counts.pending > 0 ? h("span", { class: "qa-badge" }, counts.pending > 9 ? "9+" : counts.pending) : null
      ),
      qa(
        "grid",
        "多会话",
        () => {
          const sc = document.querySelector("#xj-stage .scroll");
          if (sc) sc.scrollTo({ top: 0, behavior: window.__XJ_RENDER__ === "sw" ? "auto" : "smooth" });
          XJ.ui.toast({ type: "info", title: "共 " + s.sessions.length + " 个会话", sub: "点会话卡可以切为发送目标" });
        }
      ),
      qa("external", "主界面", () => XJ.app.openMainWindow(), null, offline)
    );
  }

  function qa(icon, label, onClick, badge, disabled) {
    return h(
      "button",
      { class: "qa", onclick: onClick, disabled: disabled || null, title: label },
      XJ.icon(icon, 17),
      h("span", null, label),
      badge || null
    );
  }

  /* ---------------- 审批区（钉顶） ---------------- */
  function pendingZone(s, list) {
    // 面板内只钉一张卡：多出来的去审批中心看（§8.3 审批卡不进滚动区 → 不能靠滚动塞下多张）
    const shown = list.slice(0, 1);
    const more = list.length - shown.length;
    return h(
      "div",
      { class: "approval-zone" },
      h(
        "div",
        { class: "section-label" },
        XJ.icon("shield", 12),
        h("span", null, "需要你点头"),
        h("span", { class: "count" }, list.length),
        h("span", { class: "spacer" }),
        more > 0 ? h("button", { onclick: () => XJ.app.openApprovalCenter() }, "查看全部 " + list.length + " 项") : null
      ),
      shown.map((item) => pendingCard(s, item)),
      more > 0
        ? h(
            "button",
            { class: "more-pending", onclick: () => XJ.app.openApprovalCenter() },
            "还有 " + more + " 项待确认",
            h("span", { class: "spacer" }),
            "去审批中心 →"
          )
        : null
    );
  }

  /** 待办卡分派：审批卡 / 提问卡（§4.3 N = approval + question） */
  function pendingCard(s, item, opts) {
    return item.kind === "question" ? questionCard(s, item, opts) : approvalCard(s, item, opts);
  }

  /**
   * 提问卡：Agent 在等用户回答问题。
   * 浮窗只做「告诉你 + 带你去回答」，真正的回答在主界面（§5 F4 只内嵌审批）。
   */
  function questionCard(s, item) {
    const sess = XJ.state.sessionById(s, item.sessionId);
    const presenting = XJ.state.presenting(s);
    return h(
      "div",
      { class: "approval-card question-card" },
      h(
        "div",
        { class: "appr-top" },
        h("span", { class: "risk risk-question" }, "提问"),
        h("span", { class: "appr-session ellipsis" }, "《" + (sess ? XJ.state.displayTitle(s, sess) : "未知会话") + "》"),
        h("span", { class: "spacer" }),
        XJ.ui.waitNode(item.waitingSince, item.id)
      ),
      h(
        "div",
        { class: "appr-summary" },
        presenting ? "Agent 有一个问题等你回答" : item.text || "Agent 想问你一个问题"
      ),
      h(
        "div",
        { class: "appr-actions" },
        h(
          "button",
          {
            class: "btn-solid",
            onclick: () => {
              A().sessionViewed(item.sessionId);
              A().approvalResolved(item.id, "answered", "widget");
              XJ.app.openMainWindow();
              XJ.ui.toast({ type: "info", title: "去主界面回答", sub: "这个问题需要输入文字，浮窗里不处理" });
            },
          },
          XJ.icon("chat", 13),
          "去回答"
        )
      )
    );
  }

  /* ---------------- 审批卡 ---------------- */
  function approvalCard(s, item, opts) {
    const o = opts || {};
    const meta = XJ.state.RISK[item.risk] || XJ.state.RISK.exec;
    const sess = XJ.state.sessionById(s, item.sessionId);
    const ui = s.ui;
    const isDetail = !!o.detail;
    const pending = item.status === "pending";
    const submitting = item.status === "submitting";
    const failed = item.status === "failed";
    const expired = item.status === "expired";
    const lowRisk = item.risk === "read";

    // 本卡片的局部交互状态
    ui.approvalLocal = ui.approvalLocal || {};
    const local = (ui.approvalLocal[item.id] = ui.approvalLocal[item.id] || {
      expandedCmd: false,
      denyConfirm: false,
      scopeSession: false,
      revealConfirm: false,
      revealed: false,
    });

    // §10.5 演示模式：命令正文 / 影响面默认折叠成一句摘要，需二次确认才展开
    const presenting = XJ.state.presenting(s);
    const masked = presenting && !local.revealed;

    const act = (decision) => XJ.app.decideApproval(item, decision, { scope: local.scopeSession ? "session" : "once" });

    const cmdBox = masked
      ? h(
          "button",
          {
            class: "cmd-box masked",
            onclick: () => {
              if (!local.revealConfirm) {
                local.revealConfirm = true;
                A().patchSettings({});
                return;
              }
              local.revealConfirm = false;
              local.revealed = true;
              A().patchSettings({});
            },
          },
          XJ.icon("eye", 12),
          h("span", null, local.revealConfirm ? "确认展开？会显示在共享画面上" : "点击展开（会显示在共享画面上）")
        )
      : item.command && isDetail
        ? h(
            "div",
            { class: "cmd-box" + (local.expandedCmd ? "" : " clamped") },
            h("code", { class: "mono" }, item.command),
            String(item.command).length > 90
              ? h(
                  "button",
                  { class: "cmd-more", onclick: () => { local.expandedCmd = !local.expandedCmd; A().patchSettings({}); } },
                  local.expandedCmd ? "收起" : "展开全部",
                  XJ.icon(local.expandedCmd ? "chevronDown" : "chevronRight", 11)
                )
              : null
          )
        : item.command
        ? h("div", { class: "cmd-box clamped" }, h("code", { class: "mono" }, item.command))
        : null;

    const stateRow = expired
      ? h("div", { class: "appr-state grey" }, XJ.icon("clock", 12), "这个审批已经失效")
      : failed
      ? h(
          "div",
          { class: "appr-state err" },
          XJ.icon("alert", 12),
          h("span", null, item.error || "没发出去，重试？"),
          h("span", { class: "spacer" }),
          h("button", { class: "btn-mini", onclick: () => act(item.pendingDecision || "allow") }, "重试")
        )
      : submitting
      ? h("div", { class: "appr-state grey" }, h("span", { class: "spinner" }), "正在处理…")
      : null;

    const actions = pending || failed
      ? local.denyConfirm
        ? h(
            "div",
            { class: "appr-actions", style: { flexWrap: "wrap" } },
            h("span", { class: "t-aux", style: { flex: "1 1 100%", color: "#ffd98a", fontSize: "11px" } }, "拒绝后这个任务会中断"),
            h(
              "button",
              {
                class: "btn-ghost btn-sm danger",
                onclick: () => {
                  local.denyConfirm = false;
                  act("deny");
                },
              },
              "确认拒绝"
            ),
            h(
              "button",
              {
                class: "btn-ghost btn-sm",
                onclick: () => {
                  local.denyConfirm = false;
                  A().patchSettings({});
                },
              },
              "算了"
            )
          )
        : h(
            "div",
            { class: "appr-actions" },
            h(
              "button",
              {
                class: "btn-solid",
                onclick: () => {
                  if (item.risk === "danger" && !local.confirmDanger) {
                    local.confirmDanger = true;
                    XJ.ui.toast({ type: "warn", title: "再点一次「确定通过」", sub: "这一步影响面比较大", duration: 2600 });
                    A().patchSettings({});
                    return;
                  }
                  local.confirmDanger = false;
                  act("allow");
                },
              },
              XJ.icon("check", 13),
              item.risk === "danger" && local.confirmDanger ? "确定通过" : "通过"
            ),
            h(
              "button",
              {
                class: "btn-ghost",
                onclick: () => {
                  local.denyConfirm = true;
                  A().patchSettings({});
                },
              },
              "拒绝"
            ),
            lowRisk
              ? h(
                  "button",
                  {
                    class: "appr-scope",
                    title: "本会话内同一类操作不再询问",
                    onclick: () => {
                      local.scopeSession = !local.scopeSession;
                      A().patchSettings({});
                    },
                  },
                  h("span", { class: "checkbox" + (local.scopeSession ? " on" : "") }, XJ.icon("check", 10)),
                  "本会话内都允许"
                )
              : h("span", { class: "appr-scope", style: { cursor: "default", color: "var(--text-tertiary)" }, title: meta.hint }, "仅限本次")
          )
      : null;

    const settledText = expired
      ? null
      : item.status === "resolved"
      ? "已处理"
      : null;

    return h(
      "div",
      {
        class:
          "approval-card" +
          (item.risk === "danger" ? " danger-card" : "") +
          (expired ? " is-settled" : "") +
          (o.compact ? " compact" : ""),
        dataset: { approvalId: item.id },
      },
      h(
        "div",
        { class: "appr-top" },
        XJ.ui.riskTag(item.risk),
        h("span", { class: "appr-session ellipsis" }, sess ? "《" + truncate(XJ.state.displayTitle(s, sess), 16) + "》" : "未知会话"),
        XJ.ui.waitNode(item.waitingSince, item.id)
      ),
      h("div", { class: "appr-summary" }, masked ? "1 项待确认 · " + meta.label : item.summary),
      cmdBox,
      !masked && item.impact
        ? h(
            "div",
            { class: "appr-impact" },
            XJ.icon("info", 13),
            h("span", null, item.impact)
          )
        : null,
      stateRow,
      settledText ? h("div", { class: "appr-state grey" }, XJ.icon("check", 12), settledText) : null,
      actions
    );
  }

  /* ---------------- 会话列表 ---------------- */
  function sessionList(s) {
    const sessions = XJ.state.sortedSessions(s);
    const working = sessions.filter((x) => x.state === "working");
    const idle = sessions.filter((x) => x.state !== "working");
    const pendingBySession = new Map();
    XJ.state.pendingList(s).forEach((p) => {
      if (!pendingBySession.has(p.sessionId)) pendingBySession.set(p.sessionId, []);
      pendingBySession.get(p.sessionId).push(p);
    });

    const scroll = h("div", { class: "scroll" });

    if (!sessions.length) {
      scroll.appendChild(
        h(
          "div",
          { class: "empty" },
          h("div", { class: "empty-whale" }, XJ.ui.whale("sleep", 56)),
          h("div", { class: "empty-title" }, "现在没有在跑的任务"),
          h("div", { class: "empty-sub" }, "在下面问点什么，就开始第一个会话")
        )
      );
      return scroll;
    }

    if (working.length) {
      scroll.appendChild(
        h(
          "div",
          { class: "section-label" },
          h("span", null, "正在执行"),
          h("span", { class: "count" }, working.length)
        )
      );
      working.forEach((x) => scroll.appendChild(sessionCard(s, x, pendingBySession.get(x.id))));
    }
    if (idle.length) {
      scroll.appendChild(
        h(
          "div",
          { class: "section-label", style: { marginTop: "12px" } },
          h("span", null, "最近完成"),
          h("span", { class: "count" }, idle.length),
          h("span", { class: "spacer" }),
          idle.some((x) => x.unread)
            ? h("button", { onclick: () => A().markAllRead() }, "全部已读")
            : null
        )
      );
      idle.forEach((x) => scroll.appendChild(sessionCard(s, x, pendingBySession.get(x.id))));
    }
    scroll.appendChild(h("div", { style: { height: "4px" } }));
    return scroll;
  }

  function sessionCard(s, sess, pending) {
    const hasPending = pending && pending.length;
    const isTarget = (s.composer.targetSessionId || (s.sessions.find((x) => x.active) || {}).id) === sess.id;
    const confirming = s.ui.stopConfirmSessionId === sess.id;

    // §10.5 演示模式：动作行里的文件名/路径也要遮掉
    const actText =
      XJ.state.presenting(s) && sess.state === "working"
        ? "正在处理"
        : sess.state === "working"
        ? sess.action || "正在处理"
        : sess.stoppedByUser
        ? "已停止"
        : sess.unread
        ? "已完成，还没看"
        : "已完成";

    return h(
      "div",
      {
        class: "sess-card" + (isTarget ? " is-active" : ""),
        onclick: () => {
          A().composerTarget(sess.id);
          A().sessionViewed(sess.id);
        },
      },
      h(
        "div",
        { class: "sess-top" },
        sess.unread ? h("span", { class: "unread-dot" }) : null,
        h("span", { class: "sess-title ellipsis", title: XJ.state.displayTitle(s, sess) }, XJ.state.displayTitle(s, sess)),
        XJ.ui.sessionPill(sess, hasPending)
      ),
      h(
        "div",
        { class: "sess-action" },
        h("span", { class: "ellipsis" }, actText),
        h("span", { class: "spacer" }),
        h("span", { class: "t-ter" }, fmtRel(sess.lastActivityAt))
      ),
      sess.state === "working"
        ? h("div", { class: "progress" }, h("i", { style: { width: Math.round(sess.progress || 0) + "%" } }))
        : sess.progress === 100
        ? h("div", { class: "progress done" }, h("i", { style: { width: "100%" } }))
        : null,
      confirming
        ? h(
            "div",
            { class: "sess-foot", onclick: (e) => e.stopPropagation() },
            h("span", { class: "t-aux", style: { color: "#ffd98a", fontSize: "11px" } }, "停止这个任务？已改动的文件会保留"),
            h("span", { class: "spacer" }),
            h(
              "button",
              {
                class: "btn-mini",
                style: { color: "#ffb0b0" },
                onclick: () => {
                  s.ui.stopConfirmSessionId = null;
                  XJ.app.stopSession(sess.id);
                },
              },
              "停止"
            ),
            h(
              "button",
              {
                class: "btn-mini",
                onclick: () => {
                  s.ui.stopConfirmSessionId = null;
                  A().patchSettings({});
                },
              },
              "继续"
            )
          )
        : h(
            "div",
            { class: "sess-foot", onclick: (e) => e.stopPropagation() },
            isTarget ? h("span", { class: "t-ter", style: { color: "var(--accent-soft)" } }, "· 发送目标") : null,
            h("span", { class: "spacer" }),
            sess.state === "working"
              ? h(
                  "button",
                  {
                    class: "btn-mini",
                    onclick: () => {
                      s.ui.stopConfirmSessionId = sess.id;
                      A().patchSettings({});
                    },
                  },
                  XJ.icon("stop", 11),
                  "停止"
                )
              : sess.unread
              ? h(
                  "button",
                  {
                    class: "btn-mini",
                    onclick: () => {
                      A().sessionViewed(sess.id);
                      XJ.app.openMainWindow();
                    },
                  },
                  "去看看"
                )
              : h("span", { class: "t-ter" }, "空闲")
          )
    );
  }

  XJ.views = XJ.views || {};
  XJ.views.panel = panel;
  XJ.views.approvalCard = approvalCard;
  XJ.views.pendingCard = pendingCard;
  XJ.views.questionCard = questionCard;
  XJ.views.sessionCard = sessionCard;
  XJ.views.header = header;
})();
