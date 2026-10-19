/* =============================================================================
   composer.js · 统一 Composer（§9.1）
   键入 / 粘贴 / 截图 / 拖入 四种入口共享同一份草稿与附件队列。
   ========================================================================== */
(function () {
  const XJ = (window.XJ = window.XJ || {});
  const { h, fmtBytes } = XJ.dom;
  const A = () => XJ.state.actions;
  const S = () => XJ.state.store.state;

  /* ---------- 目标会话展示 ---------- */
  function targetLabel(s) {
    const sess = XJ.state.resolveTargetSession(s);
    if (!sess) return { title: "新会话", fresh: true };
    return { title: XJ.state.displayTitle(s, sess), fresh: false, sess };
  }

  /* ---------- 附件渲染 ---------- */
  function attachmentStrip(s, onRemove) {
    const c = s.composer;
    if (!c.attachments.length) return null;
    return h(
      "div",
      { class: "composer-attach" },
      c.attachments.map((att) => {
        if (att.kind === "image" && att.preview) {
          return h(
            "div",
            { class: "thumb", title: att.name },
            h("img", { src: att.preview, alt: att.name }),
            h("button", { class: "x", "aria-label": "移除 " + att.name, onclick: () => onRemove(att.localId) }, XJ.icon("x", 9))
          );
        }
        return h(
          "div",
          { class: "file-chip", title: att.name + " · " + fmtBytes(att.size) },
          XJ.icon(att.kind === "pdf" ? "file" : "file", 13),
          h("span", { class: "ellipsis" }, att.name),
          h("button", { class: "x", "aria-label": "移除 " + att.name, onclick: () => onRemove(att.localId) }, XJ.icon("x", 11))
        );
      })
    );
  }

  /* ---------- 主渲染 ---------- */
  function render(s, variant) {
    const c = s.composer;
    const offline = s.connection === "offline";
    const target = targetLabel(s);

    const removeAtt = (localId) =>
      A().composerAttachments((comp) => {
        comp.attachments = comp.attachments.filter((x) => x.localId !== localId);
      });

    const ta = h("textarea", {
      class: "composer-input",
      rows: 1,
      placeholder: offline ? "连接断开中，暂时发不出去" : "问点什么…",
      "aria-label": "提问内容",
      dataset: { focus: "composer" },
      disabled: offline ? true : null,
      oninput: onInput,
    });
    ta.value = c.text || "";
    requestAnimationFrame(() => autoGrow(ta));

    const sendBtn = h(
      "button",
      {
        class: "btn-solid btn-sm",
        onclick: () => doSend(variant),
        disabled: offline || c.sending ? true : null,
        "aria-label": "发送",
      },
      c.sending ? h("span", { class: "spinner" }) : XJ.icon("send", 14),
      h("span", null, c.sending ? "发送中" : "发送")
    );

    function onKey(e) {
      // IME 组合中的 Enter 不能触发发送（§4.4.3）
      if (e.isComposing || s.runtime.imeComposing || e.keyCode === 229) return;
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        doSend(variant);
      } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        doSend(variant, { force: true });
      }
    }
    ta.addEventListener("keydown", onKey);
    ta.addEventListener("compositionstart", () => (s.runtime.imeComposing = true));
    ta.addEventListener("compositionend", () => (s.runtime.imeComposing = false));

    const tools = h(
      "div",
      { class: "composer-tools" },
      XJ.ui.iconBtn("camera", {
        title: "截图提问（Ctrl+Shift+A）",
        size: 15,
        onClick: XJ.ui.guard(s, () => XJ.app.startCapture()),
      }),
      XJ.ui.iconBtn("paperclip", {
        title: "添加文件",
        size: 15,
        onClick: XJ.ui.guard(s, async () => {
          const files = await XJ.platform.pickFiles();
          if (files.length) XJ.composer.addFiles(files, { confirm: true });
        }),
      }),
      XJ.ui.iconBtn("chat", {
        title: "在新会话里提问",
        size: 15,
        onClick: () => {
          A().composerTarget(null);
          A().patchSettings({});
          XJ.app.openNewSession();
        },
      }),
      h("span", { class: "composer-hint" }, offline ? "连接断开" : "Enter 发送 · Shift+Enter 换行"),
      h("div", { class: "spacer" }),
      sendBtn
    );

    const box = h(
      "div",
      { class: "composer-box" + (c.error ? " has-error" : "") },
      target.fresh || variant === "panel"
        ? h(
            "div",
            { class: "composer-target", title: target.fresh ? "会新建一个会话" : "发送到当前会话" },
            XJ.icon(target.fresh ? "plus" : "chat", 11),
            h("span", { class: "ellipsis" }, target.fresh ? "新会话" : target.title)
          )
        : null,
      ta,
      attachmentStrip(s, removeAtt),
      tools
    );

    const wrap = h("div", { class: "composer-outer" }, box);

    if (c.error) {
      wrap.appendChild(
        h(
          "div",
          { class: "composer-error" },
          XJ.icon("alert", 12),
          h("span", null, c.error),
          h(
            "button",
            {
              class: "btn-mini",
              style: { marginLeft: "6px" },
              onclick: () => {
                A().composerError(null);
                doSend(variant, { retry: true });
              },
            },
            "重试"
          )
        )
      );
    }

    // 拖入/粘贴的二次确认（§9.3.5）
    if (s.ui.dropState && s.ui.dropState.phase === "confirm") {
      wrap.appendChild(renderConfirm(s));
    }
    return wrap;
  }

  function renderConfirm(s) {
    const d = s.ui.dropState;
    const target = targetLabel(s);
    return h(
      "div",
      { class: "attach-confirm", style: { marginTop: "8px" } },
      h(
        "div",
        { class: "attach-confirm-title" },
        XJ.icon(d.source === "paste" ? "image" : "folder", 13),
        h(
          "span",
          null,
          d.items.length + (d.source === "paste" ? " 张图片待发送" : " 个文件待发送") + " · 发给《" + target.title + "》"
        )
      ),
      h(
        "div",
        { class: "attach-confirm-foot" },
        h(
          "div",
          { class: "composer-attach", style: { flex: "1", minWidth: "0", padding: "0" } },
          d.items.map((att) =>
            att.kind === "image" && att.preview
              ? h("div", { class: "thumb", title: att.name }, h("img", { src: att.preview, alt: att.name }))
              : h(
                  "div",
                  { class: "file-chip", title: att.name },
                  XJ.icon("file", 13),
                  h("span", { class: "ellipsis" }, att.name)
                )
          )
        ),
        h(
          "button",
          {
            class: "btn-solid btn-sm",
            onclick: () => {
              const items = d.items;
              s.ui.dropState = null;
              A().composerAttachments((c) => {
                c.attachments = c.attachments.concat(items);
                if (!c.text) c.text = "";
              });
              XJ.app.toast({ type: "success", title: "已加到输入框", sub: "发给《" + target.title + "》，点发送就出发" });
            },
          },
          "发送"
        ),
        h(
          "button",
          {
            class: "btn-ghost btn-sm",
            onclick: () => {
              s.ui.dropState = null;
              XJ.state.store.emit();
            },
          },
          "移除"
        )
      ),
      s.settings.confirmDrop
        ? h("div", { class: "t-ter", style: { marginTop: "4px", fontSize: "10.5px" } }, "可在设置里关掉这个确认")
        : null
    );
  }

  function autoGrow(ta) {
    if (!ta || !ta.isConnected) return;
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 108) + "px";
  }

  function onInput(e) {
    const ta = e.target;
    const s = S();
    s.composer.text = ta.value;
    s.composer.error = null;
    XJ.platform.store.set("draft", { text: ta.value, at: Date.now() }, 24 * 3600e3);
    autoGrow(ta);
    const btn = ta.closest(".composer-box").querySelector(".btn-solid");
    if (btn) btn.disabled = !ta.value.trim() || s.connection === "offline" || s.composer.sending;
    const box = ta.closest(".composer-box");
    if (box && box.classList.contains("has-error")) {
      box.classList.remove("has-error");
      const err = box.parentElement.querySelector(".composer-error");
      if (err) err.remove();
    }
  }

  /* ---------- 加文件（拖入 / 粘贴 / 选择器共用） ---------- */
  async function addFiles(files, opts) {
    const s = S();
    const o = Object.assign({ confirm: true, source: "drag" }, opts);
    const list = Array.from(files);
    if (!list.length) return;

    if (list.length > 10) {
      XJ.ui.toast({ type: "warn", title: "一次最多 10 个文件", sub: "可以分几次发" });
      return;
    }
    const accepted = [];
    for (const f of list) {
      const res = await XJ.platform.prepareAttachment(f);
      if (!res.ok) {
        XJ.ui.toast({ type: "warn", title: res.reason, sub: res.name });
        continue;
      }
      accepted.push(res.att);
    }
    if (!accepted.length) return;

    const needConfirm = o.confirm && s.settings.confirmDrop;
    if (needConfirm) {
      s.ui.dropState = { phase: "confirm", items: accepted, source: o.source };
      XJ.state.store.emit();
      return;
    }
    A().composerAttachments((c) => {
      c.attachments = c.attachments.concat(accepted);
    });
    XJ.app.toast({ type: "success", title: "已加到输入框", sub: accepted.length + " 个文件" });
  }

  /* ---------- 发送（§9.1.3 三条不变式） ---------- */
  async function doSend(variant, opts) {
    const s = S();
    const o = opts || {};
    const c = s.composer;

    if (c.sending) return;
    if (s.connection === "offline") {
      XJ.ui.toast({ type: "warn", title: "连接已断开，恢复后可操作" });
      return;
    }
    const text = (c.text || "").trim();
    if (!text && !c.attachments.length) {
      c.error = null;
      return;
    }

    // 幂等键：重试复用同一个 client_msg_id（§9.1.3-3）
    if (!c.clientMsgId || !o.retry) c.clientMsgId = XJ.dom.uuidv7();
    c.sending = true;
    c.error = null;
    XJ.state.store.emit();

    const target = XJ.state.resolveTargetSession(s);
    const targetId = target ? target.id : null;
    const targetTitle = target ? target.title : "新会话";

    try {
      // 1) 附件上传（真实实现 8MB 上限 + 30 分钟有效期）
      const ids = [];
      for (const att of c.attachments) {
        if (!att.attachmentId) {
          const res = await XJ.mock.harness.uploadAttachment(att);
          att.attachmentId = res.attachment_id;
        }
        ids.push(att.attachmentId);
      }

      // 2) 发送
      let res;
      if (targetId) {
        res = await XJ.mock.harness.prompt(targetId, {
          text,
          clientMsgId: c.clientMsgId,
          attachment_ids: ids,
        });
      } else {
        const sess = await XJ.mock.harness.newSession(text);
        res = { message_id: c.clientMsgId, session_id: sess.id, queued: false, created: true };
      }

      // 3) 成功：清空草稿与附件
      const wasQueued = !!res.queued;
      c.sending = false;
      c.text = "";
      c.attachments = [];
      c.clientMsgId = null;
      c.error = null;
      XJ.platform.store.remove("draft");
      s.metrics.promptSent++;
      s.ui.dropState = null;
      XJ.state.store.emit();

      if (variant === "quickbar") {
        s.ui.form = "quickbar";
        c.lastReply = {
          sessionId: res.session_id || targetId,
          title: targetTitle,
          text: wasQueued ? "" : "正在处理…",
          busy: true,
          queued: wasQueued,
        };
        XJ.state.store.emit();
      } else {
        XJ.ui.toast({
          type: "success",
          title: wasQueued ? "已排队，当前任务完成后处理" : "已发送",
          sub: "发给《" + targetTitle + "》",
        });
        if (variant === "panel") A().setForm("collapsed");
      }
    } catch (err) {
      c.sending = false;
      const code = err && err.code;
      if (code === 503) {
        XJ.state.actions.setConnection("offline");
        c.error = "发送失败：Harness 未响应，草稿已保留";
      } else {
        c.error = "发送失败：没发出去，重试一下？";
      }
      XJ.state.store.emit();
    }
  }

  /* ---------- 截图 → 附件队列（§9.2.7：像素只在内存里，不落盘） ---------- */
  function addImageFromCapture(dataUrl, meta) {
    const s = S();
    const m = meta || {};
    const att = {
      localId: XJ.dom.uid("att"),
      name: m.name || "截图 " + XJ.dom.fmtClock(Date.now()) + ".png",
      size: m.size || 0,
      kind: "image",
      preview: dataUrl,
      width: m.width || 0,
      height: m.height || 0,
    };
    A().composerAttachments((c) => {
      c.attachments = c.attachments.concat(att);
      if (m.question) c.text = m.question;
    });
    // 截图失败兜底：至少让用户看到东西进了输入框
    A().setForm("panel");
    requestAnimationFrame(() => {
      const ta = document.querySelector('[data-focus="composer"]');
      if (ta) {
        ta.focus({ preventScroll: true });
        autoGrow(ta);
      }
      const thumb = document.querySelector(".composer-attach .thumb img");
      if (thumb) {
        thumb.scrollIntoView({ block: "nearest", inline: "nearest" });
      }
    });
    s.metrics.captureSent = (s.metrics.captureSent || 0) + 1;
  }

  XJ.composer = { render, addFiles, addImageFromCapture, doSend, autoGrow };
})();
