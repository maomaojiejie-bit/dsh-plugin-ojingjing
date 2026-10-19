/* =============================================================================
   view-quickbar.js · 形态三「快捷输入条 360 × 44–108」（§9.4）
   唤起即聚焦；发送后原地显示回复预览；Esc 关闭并归还焦点；不保留历史。
   ========================================================================== */
(function () {
  const XJ = (window.XJ = window.XJ || {});
  const { h, truncate } = XJ.dom;
  const S = () => XJ.state.store.state;
  const A = () => XJ.state.actions;

  function quickbar(s) {
    const c = s.composer;
    const offline = s.connection === "offline";
    const target = XJ.state.resolveTargetSession(s);
    const targetTitle = target ? target.title : "新会话";
    const working = target && target.state === "working";
    const reply = c.lastReply;

    /* --- 目标会话 chip：点击可切换 --- */
    const chip = h(
      "button",
      {
        class: "qb-summon",
        title: "更换目标会话",
        onclick: () => {
          const alive = s.sessions.filter((x) => x.state !== "closed");
          if (alive.length < 2) {
            XJ.ui.toast({ type: "info", title: "只有一个会话", sub: "打开面板可以新建会话" });
            return;
          }
          const idx = alive.findIndex((x) => target && x.id === target.id);
          const next = alive[(idx + 1) % alive.length];
          A().composerTarget(next.id);
          XJ.ui.toast({ type: "info", title: "发给《" + truncate(next.title, 14) + "》" });
        },
      },
      XJ.icon("chat", 11),
      h("span", { class: "ellipsis" }, truncate(targetTitle, 10))
    );

    const ta = h("textarea", {
      class: "qb-input",
      rows: 1,
      placeholder: offline ? "连接断开中…" : "问点什么…",
      "aria-label": "提问内容",
      dataset: { focus: "composer" },
      disabled: offline ? true : null,
    });
    ta.value = c.text || "";
    requestAnimationFrame(() => {
      ta.style.height = "auto";
      ta.style.height = Math.min(ta.scrollHeight, 76) + "px";
    });
    ta.addEventListener("input", () => {
      s.composer.text = ta.value;
      s.composer.error = null;
      XJ.platform.store.set("draft", { text: ta.value, at: Date.now() }, 24 * 3600e3);
      ta.style.height = "auto";
      ta.style.height = Math.min(ta.scrollHeight, 76) + "px";
      const btn = ta.parentElement.querySelector(".qb-send");
      if (btn) btn.disabled = !ta.value.trim() || offline || s.composer.sending;
    });
    ta.addEventListener("keydown", (e) => {
      if (e.isComposing || s.runtime.imeComposing || e.keyCode === 229) return;
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        XJ.composer.doSend("quickbar", { force: e.ctrlKey || e.metaKey });
      }
      if (e.key === "Escape") {
        e.preventDefault();
        XJ.app.closeQuickbar();
      }
    });
    ta.addEventListener("compositionstart", () => (s.runtime.imeComposing = true));
    ta.addEventListener("compositionend", () => (s.runtime.imeComposing = false));

    const sendBtn = h(
      "button",
      {
        class: "qb-send",
        title: "发送（Enter）",
        "aria-label": "发送",
        disabled: offline || s.composer.sending || !(c.text || "").trim() ? true : null,
        onclick: () => XJ.composer.doSend("quickbar"),
      },
      s.composer.sending ? h("span", { class: "spinner" }) : XJ.icon("send", 14)
    );

    const main = h(
      "div",
      { class: "qb-main" },
      chip,
      ta,
      h(
        "div",
        { class: "qb-tools" },
        XJ.ui.iconBtn("camera", {
          title: "截图提问",
          size: 15,
          onClick: XJ.ui.guard(s, () => XJ.app.startCapture()),
        }),
        XJ.ui.iconBtn("paperclip", {
          title: "添加文件",
          size: 15,
          onClick: XJ.ui.guard(s, async () => {
            const files = await XJ.platform.pickFiles();
            if (files.length) XJ.composer.addFiles(files, { confirm: true, source: "pick" });
          }),
        }),
        sendBtn
      )
    );

    /* --- 附件缩略 --- */
    const atts = c.attachments.length
      ? h(
          "div",
          { class: "composer-attach", style: { padding: "0 12px 8px" } },
          c.attachments.map((att) =>
            att.kind === "image" && att.preview
              ? h("div", { class: "thumb", title: att.name }, h("img", { src: att.preview, alt: att.name }))
              : h("div", { class: "file-chip", title: att.name }, XJ.icon("file", 13), h("span", { class: "ellipsis" }, att.name))
          )
        )
      : null;

    /* --- 回复预览（最多 3 行 + 查看完整回复） --- */
    let replyBlock = null;
    if (reply) {
      const text = reply.queued
        ? "已排队，当前任务完成后我会处理这条消息。"
        : reply.busy
        ? reply.text || "正在处理…"
        : reply.text;
      replyBlock = h(
        "div",
        { class: "qb-foot", style: { flexDirection: "column", alignItems: "flex-start", gap: "6px" } },
        h(
          "div",
          { class: "qb-reply", style: { width: "100%" } },
          h(
            "div",
            { class: "qb-reply-head" },
            XJ.ui.whale(reply.busy ? "focus" : "happy", 14),
            h("span", { class: "ellipsis" }, "《" + truncate(reply.title || "", 12) + "》"),
            h("span", { class: "spacer" }),
            reply.queued
              ? h("span", { class: "t-ter" }, "已排队")
              : reply.busy
              ? h("span", { class: "t-ter" }, "正在回复…")
              : h("span", { class: "t-ter" }, "已完成")
          ),
          h(
            "div",
            { class: "clamp2" },
            text
              ? XJ.markdown ? XJ.markdown(text) : text
              : "…"
          )
        ),
        h(
          "div",
          { style: { display: "flex", alignItems: "center", gap: "8px", width: "100%" } },
          h("span", { class: "t-ter", style: { fontSize: "10.5px" } }, "Enter 发送 · Shift+Enter 换行 · Esc 收起"),
          h("span", { class: "spacer" }),
          h(
            "button",
            { class: "btn-link primary", onclick: () => XJ.app.openPanel() },
            "面板里看完整回复",
            XJ.icon("chevronRight", 12)
          )
        )
      );
    } else {
      replyBlock = h(
        "div",
        { class: "qb-foot" },
        h("span", null, "Enter 发送 · Shift+Enter 换行 · Esc 收起"),
        h("span", { class: "spacer" }),
        working
          ? h("span", { style: { color: "#ffd98a" } }, "· 当前任务完成后处理")
          : h("button", { class: "btn-link", style: { fontSize: "11px" }, onclick: () => XJ.app.openPanel() }, "打开面板")
      );
    }

    const err = c.error
      ? h(
          "div",
          { class: "composer-error", style: { padding: "0 12px 8px" } },
          XJ.icon("alert", 12),
          h("span", null, c.error)
        )
      : null;

    return h(
      "div",
      { class: "form quickbar glass", onmousedown: (e) => e.stopPropagation() },
      main,
      atts,
      err,
      replyBlock
    );
  }

  XJ.views = XJ.views || {};
  XJ.views.quickbar = quickbar;
})();
