/* =============================================================================
   ui.js · 共享视图零件（角标 / 状态点 / 风险标签 / Toast / 通知）
   原则：语义色只做图标、描边、角标（§7.1 使用纪律），正文一律白色。
   ========================================================================== */
(function () {
  const XJ = (window.XJ = window.XJ || {});
  const { h, fmtRel, fmtDuration } = XJ.dom;

  /* ---------- 状态点 ---------- */
  function statusDot(tone) {
    return h("span", { class: "status-dot " + (tone || "") });
  }

  /* ---------- 双角标（§4.3.4） ---------- */
  function badges(counts) {
    const n = counts.pending || 0;
    const m = counts.unread || 0;
    const el = h("div", { class: "badges" });
    if (n > 0) {
      el.appendChild(
        h("span", { class: "badge badge-pending", "aria-label": n + " 项待确认" }, n > 9 ? "9+" : String(n))
      );
    }
    if (m > 0) {
      el.appendChild(
        h("span", { class: "badge badge-unread", "aria-label": m + " 条未读" }, m > 9 ? "9+" : String(m))
      );
    }
    return el;
  }

  function needsBadges(counts) {
    return (counts.pending || 0) > 0 || (counts.unread || 0) > 0;
  }

  /* ---------- 风险标签（§8.6） ---------- */
  function riskTag(risk) {
    const meta = XJ.state.RISK[risk] || XJ.state.RISK.exec;
    return h("span", { class: "risk risk-" + risk }, meta.label);
  }

  /* ---------- 会话状态胶囊 ---------- */
  function sessionPill(sess, hasPending) {
    if (hasPending) return h("span", { class: "pill pill-pending" }, "等待审批");
    if (sess.state === "working") return h("span", { class: "pill pill-working" }, "工作中");
    if (sess.unread) return h("span", { class: "pill pill-unread" }, "已完成");
    if (sess.stoppedByUser) return h("span", { class: "pill pill-idle" }, "已停止");
    return h("span", { class: "pill pill-idle" }, "空闲");
  }

  /* ---------- 聚合状态文案（§8.3 头部副标题） ---------- */
  function headline(s) {
    const counts = XJ.state.counts(s);
    const working = s.sessions.filter((x) => x.state === "working").length;
    const parts = [];
    if (working > 0) parts.push("正在执行 " + working + " 个任务");
    if (counts.pending > 0) parts.push(counts.pending + " 项待确认");
    if (counts.unread > 0) parts.push(counts.unread + " 条未读");
    if (!parts.length) return s.connection === "offline" ? "连接已断开" : "都跑完了，没有待处理的";
    return parts.join(" · ");
  }

  /* ---------- 鲸鱼 ---------- */
  function whale(expression, size) {
    return XJ.whale.make(expression, size);
  }

  /* ---------- 等待时长文案 ---------- */
  function waitText(since) {
    const d = Date.now() - since;
    if (d < 60e3) return "等了 " + Math.max(1, Math.round(d / 1000)) + " 秒";
    return "等了 " + fmtDuration(d);
  }

  function waitNode(since, id) {
    return h("span", { class: "appr-wait", dataset: { waitId: id || "" }, "data-since": String(since) }, waitText(since));
  }

  /* ---------- Toast（§6.3 反馈覆盖） ---------- */
  function toast(opts) {
    const o = Object.assign({ type: "info", duration: 3600 }, opts);
    const layer = document.getElementById("toast-layer");
    if (!layer) return () => {};
    const iconName = o.type === "success" ? "check" : o.type === "error" ? "alert" : o.type === "warn" ? "alert" : "info";
    const actions = (o.actions || []).map((a) =>
      h("button", { class: "btn-mini", onclick: () => { a.onClick && a.onClick(); remove(); } }, a.label)
    );

    const el = h(
      "div",
      { class: "toast " + o.type, role: "status", "aria-live": "polite" },
      XJ.icon(iconName, 15),
      h(
        "div",
        { class: "toast-main" },
        h("div", { class: "toast-title" }, o.title || ""),
        o.sub ? h("div", { class: "toast-sub" }, o.sub) : null,
        actions.length ? h("div", { class: "toast-actions" }, actions) : null
      ),
      h("button", { class: "toast-close", "aria-label": "关闭", onclick: () => remove() }, XJ.icon("x", 13))
    );
    layer.appendChild(el);
    let done = false;
    function remove() {
      if (done) return;
      done = true;
      el.classList.add("leaving");
      setTimeout(() => el.remove(), 210);
    }
    if (o.duration > 0) setTimeout(remove, o.duration);
    return remove;
  }

  /* ---------- Windows 通知模拟（不展示命令文本与路径，§6.6） ---------- */
  function sysNotify(opts) {
    const layer = document.getElementById("notify-layer");
    if (!layer) return;
    const el = h(
      "div",
      { class: "sys-notify", role: "alert" },
      h("div", { class: "sys-notify-head" }, whale("focus", 15), h("span", null, "哦鲸鲸 · 来自 DeepSeek Harness")),
      h("div", { class: "sys-notify-body" }, opts.title),
      opts.sub ? h("div", { class: "sys-notify-sub" }, opts.sub) : null
    );
    el.addEventListener("click", () => {
      opts.onClick && opts.onClick();
      el.classList.add("leaving");
      setTimeout(() => el.remove(), 220);
    });
    layer.appendChild(el);
    setTimeout(() => {
      el.classList.add("leaving");
      setTimeout(() => el.remove(), 220);
    }, opts.duration || 5200);
  }

  /* ---------- 离线拦截 ---------- */
  function guard(s, fn) {
    return function (...args) {
      if (s.connection === "offline") {
        toast({ type: "warn", title: "连接已断开，恢复后可操作", sub: "正在重连 Harness，稍等一下" });
        return;
      }
      return fn.apply(this, args);
    };
  }

  /* ---------- 图标按钮 ---------- */
  function iconBtn(name, opts) {
    const o = opts || {};
    return h(
      "button",
      {
        class: "icon-btn" + (o.active ? " active" : "") + (o.class ? " " + o.class : ""),
        title: o.title || "",
        "aria-label": o.title || name,
        onclick: o.onClick || null,
        dataset: o.dataset || {},
      },
      XJ.icon(name, o.size || 16)
    );
  }

  /* ---------- 相对时间节点（定时刷新） ---------- */
  function rel(ts) {
    return h("span", { class: "rel", dataset: { since: String(ts) } }, fmtRel(ts));
  }

  XJ.ui = {
    statusDot,
    badges,
    needsBadges,
    riskTag,
    sessionPill,
    headline,
    whale,
    waitText,
    waitNode,
    toast,
    sysNotify,
    guard,
    iconBtn,
    rel,
  };
})();
