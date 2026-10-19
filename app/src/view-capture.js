/* =============================================================================
   view-capture.js · 截图提问（§9.2 状态机）
   idle → arming（遮罩+十字光标）→ selecting（选区+尺寸）→ editing（标注工具条）
        → confirming（发送卡，禁止直发）→ sending → 关闭
   像素只在内存里：确认后交给 Composer 的附件队列，不落临时文件。
   真实实现用 Windows.Graphics.Capture；原型里用合成缩略图跑通交互。
   ========================================================================== */
(function () {
  const XJ = (window.XJ = window.XJ || {});
  const { h, clamp } = XJ.dom;
  const S = () => XJ.state.store.state;

  const cap = {
    phase: "idle",
    layer: null,
    sel: null,
    sizeEl: null,
    tools: null,
    tip: null,
    annots: [],
    tool: "rect",
    drag: null,
    question: "",
    keyHandler: null,
  };

  const TOOLS = [
    { id: "rect", icon: "square", label: "矩形" },
    { id: "arrow", icon: "arrowAnnotate", label: "箭头" },
    { id: "text", icon: "text", label: "文字" },
    { id: "mosaic", icon: "mosaic", label: "马赛克" },
    { id: "crop", icon: "crop", label: "裁剪" },
  ];

  /* ============================ 入口 ============================ */
  function start() {
    const s = S();
    if (s.runtime.presenting) {
      XJ.ui.toast({
        type: "warn",
        title: "演示模式中，截图入口已置灰",
        sub: "真要截图，先在设置里把演示模式改成「关」",
      });
      return;
    }
    if (cap.phase !== "idle") return;
    cap.phase = "arming";
    cap.annots = [];
    cap.tool = "rect";
    cap.drag = null;
    cap.sel = null;
    // §9.2：自身设 WDA_EXCLUDEFROMCAPTURE；原型里等价于截图期间隐藏悬浮窗（真实实现由系统排除）
    document.body.classList.add("xj-capturing");

    const layer = h("div", { class: "capture-layer", role: "dialog", "aria-label": "截图选区" });
    cap.layer = layer;
    layer.append(
      h("div", { class: "capture-mask", style: { left: "0", top: "0", width: "0", height: "0" } }),
      h("div", { class: "sel-crosshair-x", style: { top: "0" } }),
      h("div", { class: "sel-crosshair-y", style: { left: "0" } }),
      (cap.tip = h(
        "div",
        { class: "capture-tip" },
        "拖动框选区域 · 按 ",
        h("kbd", null, "Esc"),
        " 退出 · 选区确定后还要再点两次（标注 → 发送）"
      ))
    );
    document.body.appendChild(layer);

    layer.addEventListener("mousemove", onMove);
    layer.addEventListener("mousedown", onDown);
    layer.addEventListener("mouseup", onUp);
    cap.keyHandler = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        if (cap.phase === "confirming") backToEditing();
        else stop();
      }
    };
    document.addEventListener("keydown", cap.keyHandler, true);

    // 演示模式：入口置灰但不阻断（真实版本会二次确认）
    layer.style.cursor = "crosshair";
  }

  /* ============================ 选区 ============================ */
  function toRect(a, b) {
    return {
      x: Math.min(a.x, b.x),
      y: Math.min(a.y, b.y),
      w: Math.abs(a.x - b.x),
      h: Math.abs(a.y - b.y),
    };
  }

  function onMove(e) {
    const mask = cap.layer.querySelector(".capture-mask");
    const cx = cap.layer.querySelector(".sel-crosshair-x");
    const cy = cap.layer.querySelector(".sel-crosshair-y");

    if (cap.phase === "arming" || cap.phase === "selecting") {
      cx.style.top = e.clientY + "px";
      cy.style.left = e.clientX + "px";
    }

    if (cap.phase === "selecting" && cap.drag) {
      cap.sel = toRect(cap.drag, { x: e.clientX, y: e.clientY });
      paintSelection();
    }

    if (cap.phase === "editing" && cap.tool !== "text" && cap.drag && cap.sel) {
      // 在选区内画标注（相对坐标）
      const local = { x: e.clientX - cap.sel.x, y: e.clientY - cap.sel.y };
      const draft = toRect(cap.drag.local, local);
      if (cap.draftEl) cap.draftEl.remove();
      cap.draftEl = annotEl({ ...cap.tool, ...draft }, true);
      cap.sel.innerEl.appendChild(cap.draftEl);
    }
  }

  function onDown(e) {
    if (e.button !== 0) return;
    if (cap.phase === "arming") {
      cap.phase = "selecting";
      cap.drag = { x: e.clientX, y: e.clientY };
      buildSelection();
      paintSelection();
      return;
    }
    if (cap.phase === "selecting") {
      cap.drag = { x: cap.sel.x, y: cap.sel.y };
      return;
    }
    if (cap.phase === "editing" && cap.tool) {
      if (cap.tool === "text") {
        placeText(e);
        return;
      }
      cap.drag = {
        local: { x: e.clientX - cap.sel.x, y: e.clientY - cap.sel.y },
      };
    }
  }

  function onUp() {
    if (cap.phase === "selecting") {
      if (!cap.sel || cap.sel.w < 8 || cap.sel.h < 8) {
        // 误点：回到十字光标
        cap.phase = "arming";
        cap.sel = null;
        if (cap.selEl) {
          cap.selEl.remove();
          cap.selEl = null;
        }
        paintSelection();
        return;
      }
      cap.phase = "editing";
      showTools();
      paintSelection();
      return;
    }
    if (cap.phase === "editing" && cap.drag && cap.draftEl) {
      const el = cap.draftEl;
      cap.draftEl = null;
      const rect = {
        x: parseFloat(el.style.left),
        y: parseFloat(el.style.top),
        w: parseFloat(el.style.width),
        h: parseFloat(el.style.height),
      };
      if (cap.tool === "crop") {
        el.remove();
        const nx = cap.sel.x + rect.x;
        const ny = cap.sel.y + rect.y;
        cap.sel = { x: nx, y: ny, w: Math.max(8, rect.w), h: Math.max(8, rect.h) };
        cap.annots = [];
        rebuildSelectionDom();
        paintSelection();
        moveTools();
      } else if (rect.w < 4 || rect.h < 4) {
        el.remove();
      } else {
        el.remove();
        const data = { type: cap.tool === "crop" ? "rect" : cap.tool, ...rect };
        cap.annots.push(data);
        cap.sel.innerEl.appendChild(annotEl(data, false));
      }
      cap.drag = null;
      updateUndo();
    }
  }

  function buildSelection() {
    const selEl = h(
      "div",
      {
        class: "sel-rect",
        style: { left: "0", top: "0", width: "0", height: "0" },
      },
      h("div", { class: "sel-inner", style: { position: "absolute", inset: "0", overflow: "hidden" } })
    );
    cap.selEl = selEl;
    cap.sizeEl = h("div", { class: "sel-size" }, "0 × 0");
    selEl.appendChild(cap.sizeEl);
    cap.layer.appendChild(selEl);
    cap.sel = { x: 0, y: 0, w: 0, h: 0 };
  }

  function rebuildSelectionDom() {
    if (cap.selEl) cap.selEl.remove();
    const keep = cap.annots.slice();
    buildSelection();
    cap.annots = [];
    applySelBox();
    keep.forEach((a) => {
      cap.annots.push(a);
      cap.sel.innerEl.appendChild(annotEl(a, false));
    });
  }

  function applySelBox() {
    if (!cap.selEl || !cap.sel) return;
    const st = cap.selEl.style;
    st.left = cap.sel.x + "px";
    st.top = cap.sel.y + "px";
    st.width = cap.sel.w + "px";
    st.height = cap.sel.h + "px";
    if (cap.sizeEl) cap.sizeEl.textContent = Math.round(cap.sel.w) + " × " + Math.round(cap.sel.h);
  }

  function paintSelection() {
    const mask = cap.layer.querySelector(".capture-mask");
    applySelBox();
    if (cap.sel && cap.sel.w > 0) {
      mask.style.left = cap.sel.x + "px";
      mask.style.top = cap.sel.y + "px";
      mask.style.width = cap.sel.w + "px";
      mask.style.height = cap.sel.h + "px";
    } else {
      mask.style.left = "0";
      mask.style.top = "0";
      mask.style.width = "0";
      mask.style.height = "0";
    }
    cap.layer.classList.toggle("has-selection", !!(cap.sel && cap.sel.w > 0));
  }

  /* ============================ 标注 ============================ */
  function annotEl(a, draft) {
    const base = {
      position: "absolute",
      left: a.x + "px",
      top: a.y + "px",
      width: Math.max(a.w || 0, 1) + "px",
      height: Math.max(a.h || 0, 1) + "px",
      pointerEvents: "none",
    };
    if (a.type === "rect") {
      return h("div", {
        class: "annot-rect",
        style: { ...base, border: "2px solid #7CC2FF", borderRadius: "3px", background: "rgba(124,194,255,.08)" },
      });
    }
    if (a.type === "mosaic") {
      return h("div", {
        class: "annot-mosaic",
        style: {
          ...base,
          background:
            "repeating-conic-gradient(rgba(255,255,255,.16) 0 25%, rgba(20,28,46,.9) 0 50%) 0 0/12px 12px",
          filter: "blur(.4px)",
          border: "1px dashed rgba(255,255,255,.35)",
        },
      });
    }
    if (a.type === "arrow") {
      const w = Math.max(a.w, 2);
      const hh = Math.max(a.h, 2);
      const svg = XJ.dom.svg(
        "svg",
        {
          viewBox: "0 0 " + w + " " + hh,
          style: { width: "100%", height: "100%", overflow: "visible", position: "absolute", inset: "0" },
        },
        XJ.dom.svg("line", {
          x1: 0,
          y1: 0,
          x2: w,
          y2: hh,
          stroke: "#7CC2FF",
          "stroke-width": "2.5",
          "stroke-linecap": "round",
        }),
        XJ.dom.svg("path", {
          d: `M ${w} ${hh} l -9 -3.5 l 3.5 9`,
          fill: "#7CC2FF",
          stroke: "#7CC2FF",
          "stroke-width": "2",
          "stroke-linejoin": "round",
        })
      );
      const wrap = h("div", { style: { ...base, overflow: "visible" } }, svg);
      wrap.style.width = w + "px";
      wrap.style.height = hh + "px";
      return wrap;
    }
    if (a.type === "text") {
      return h(
        "div",
        {
          class: "annot-text",
          style: {
            position: "absolute",
            left: a.x + "px",
            top: a.y + "px",
            color: "#fff",
            font: "600 15px/1.3 var(--font-ui)",
            textShadow: "0 1px 3px rgba(0,0,0,.8)",
            padding: "1px 4px",
            background: "rgba(12,18,32,.55)",
            borderRadius: "4px",
          },
        },
        a.text || ""
      );
    }
    return h("div", { style: base });
  }

  function placeText(e) {
    const x = e.clientX - cap.sel.x;
    const y = e.clientY - cap.sel.y;
    const wrap = h("div", {
      style: {
        position: "absolute",
        left: x + "px",
        top: y + "px",
        zIndex: "5",
        background: "rgba(12,18,32,.8)",
        border: "1px solid rgba(124,194,255,.6)",
        borderRadius: "4px",
        padding: "0",
      },
    });
    const input = h("input", {
      class: "cap-text-input",
      placeholder: "输入文字，回车确认",
      style: {
        border: "0",
        background: "transparent",
        color: "#fff",
        font: "600 14px var(--font-ui)",
        padding: "4px 6px",
        width: "150px",
        outline: "0",
      },
    });
    wrap.appendChild(input);
    cap.sel.innerEl.appendChild(wrap);
    input.focus();
    const commit = () => {
      const val = input.value.trim();
      wrap.remove();
      if (val) {
        const data = { type: "text", x, y, text: val };
        cap.annots.push(data);
        cap.sel.innerEl.appendChild(annotEl(data, false));
        updateUndo();
      }
    };
    input.addEventListener("keydown", (ev) => {
      ev.stopPropagation();
      if (ev.key === "Enter") {
        ev.preventDefault();
        commit();
      }
      if (ev.key === "Escape") {
        ev.preventDefault();
        wrap.remove();
      }
    });
    input.addEventListener("blur", commit);
  }

  /* ============================ 工具条 ============================ */
  function showTools() {
    if (cap.tools) return;
    const bar = h("div", { class: "capture-tools", onmousedown: (e) => e.stopPropagation() });
    cap.tools = bar;

    TOOLS.forEach((t) => {
      bar.appendChild(
        h(
          "button",
          {
            class: "tool" + (cap.tool === t.id ? " on" : ""),
            title: t.label,
            "aria-label": t.label,
            dataset: { tool: t.id },
            onclick: () => {
              cap.tool = t.id;
              bar.querySelectorAll(".tool").forEach((el) => el.classList.toggle("on", el.dataset.tool === t.id));
              cap.layer.style.cursor = t.id === "text" ? "text" : "crosshair";
            },
          },
          XJ.icon(t.icon, 15)
        )
      );
    });

    bar.append(
      h("div", { class: "div" }),
      (cap.undoBtn = h(
        "button",
        {
          class: "tool",
          title: "撤销",
          "aria-label": "撤销",
          disabled: true,
          onclick: () => {
            const last = cap.annots.pop();
            if (last) {
              const nodes = cap.sel.innerEl.querySelectorAll(".annot-rect, .annot-mosaic, .annot-text");
              const el = nodes[nodes.length - 1];
              if (el) el.remove();
            }
            updateUndo();
          },
        },
        XJ.icon("undo", 15)
      )),
      h("div", { class: "div" }),
      h(
        "button",
        {
          class: "tool",
          title: "取消（Esc）",
          "aria-label": "取消",
          onclick: () => stop(),
        },
        XJ.icon("x", 15)
      ),
      h(
        "button",
        {
          class: "tool on",
          title: "完成，进入发送确认",
          "aria-label": "完成",
          style: { background: "rgba(124,194,255,.22)", color: "#dcefff" },
          onclick: () => {
            if (!cap.sel || cap.sel.w < 8) return;
            toConfirm();
          },
        },
        XJ.icon("check", 15)
      )
    );

    cap.layer.appendChild(bar);
    moveTools();
  }

  function moveTools() {
    if (!cap.tools || !cap.sel) return;
    const barW = 300;
    const below = cap.sel.y + cap.sel.h + 10;
    const top = below + 44 < window.innerHeight ? below : Math.max(10, cap.sel.y - 46);
    const left = clamp(cap.sel.x + cap.sel.w - barW, 10, window.innerWidth - barW - 10);
    cap.tools.style.left = left + "px";
    cap.tools.style.top = top + "px";
  }

  function updateUndo() {
    if (cap.undoBtn) cap.undoBtn.disabled = cap.annots.length === 0;
  }

  /* ============================ 发送卡 ============================ */
  function toConfirm() {
    if (!cap.sel) return;
    cap.phase = "confirming";
    if (cap.tools) cap.tools.style.display = "none";
    cap.layer.style.cursor = "default";

    const s = S();
    const w = Math.round(cap.sel.w);
    const hgt = Math.round(cap.sel.h);
    const thumbUrl = synth(w, hgt);
    cap.thumbUrl = thumbUrl;
    const card = h("div", { class: "cap-confirm", role: "dialog", "aria-label": "确认发送截图" });
    cap.card = card;

    const target = XJ.state.resolveTargetSession(s);
    const targetTitle = target ? target.title : "新会话";

    const ta = h("textarea", {
      class: "cap-q",
      rows: 2,
      placeholder: "对这张图有什么想问的？",
      "aria-label": "问题",
    });
    ta.value = cap.question || "";
    ta.addEventListener("input", () => (cap.question = ta.value));

    card.append(
      h(
        "div",
        { class: "cap-card-head" },
        h("span", { class: "cap-card-title" }, "确认发送"),
        h("span", { class: "t-ter", style: { fontSize: "11px" } }, w + " × " + hgt),
        h("span", { class: "spacer" }),
        h("button", { class: "icon-btn", title: "取消", onclick: () => stop() }, XJ.icon("x", 15))
      ),
      h(
        "div",
        { class: "cap-thumb" },
        h("img", { src: thumbUrl, alt: "截图预览 " + w + " × " + hgt })
      ),
      h(
        "button",
        {
          class: "cap-target",
          title: "更换目标会话",
          onclick: (e) => {
            const alive = s.sessions.filter((x) => x.state !== "closed");
            if (alive.length < 2) return;
            const idx = alive.findIndex((x) => target && x.id === target.id);
            const next = alive[(idx + 1) % alive.length];
            XJ.state.actions.composerTarget(next.id);
            e.currentTarget.lastChild.textContent = "《" + next.title + "》";
          },
        },
        XJ.icon("arrowRight", 12),
        h("span", { class: "ellipsis" }, "《" + targetTitle + "》")
      ),
      ta,
      h(
        "div",
        { class: "cap-hint" },
        XJ.icon("shield", 12),
        h("span", null, "截图只在本机处理，确认后才会发送到该会话")
      ),
      h(
        "div",
        { class: "cap-actions" },
        h(
          "button",
          {
            class: "btn-solid",
            onclick: () => send(),
          },
          XJ.icon("send", 13),
          "发送"
        ),
        h(
          "button",
          {
            class: "btn-ghost btn-sm",
            onclick: () => backToEditing(),
          },
          "重新框选"
        ),
        h("span", { class: "spacer" }),
        h("span", { class: "t-ter", style: { fontSize: "10.5px" } }, "Esc 返回")
      )
    );

    cap.layer.appendChild(card);
    requestAnimationFrame(() => ta.focus({ preventScroll: true }));
  }

  function backToEditing() {
    if (cap.card) {
      cap.card.remove();
      cap.card = null;
    }
    cap.phase = "editing";
    if (cap.tools) cap.tools.style.display = "";
    cap.layer.style.cursor = "crosshair";
  }

  async function send() {
    const s = S();
    const question = (cap.question || "").trim();
    const [wi, hi] = [Math.round(cap.sel.w), Math.round(cap.sel.h)];
    const url = cap.thumbUrl;
    stop();
    XJ.composer.addImageFromCapture(url, {
      name: "截图 " + XJ.dom.fmtClock(Date.now()) + ".png",
      size: Math.round(wi * hi * 0.35),
      width: wi,
      height: hi,
      question,
    });
    s.metrics.captureStarted = (s.metrics.captureStarted || 0) + 1;
    XJ.ui.toast({ type: "success", title: "已把截图放进输入框", sub: "加一句问题，回车就发出去" });
  }

  /* ============================ 合成缩略图 ============================ */
  function synth(w, h) {
    const scale = Math.min(1, 320 / Math.max(w, h));
    const W = Math.max(40, Math.round(w * scale));
    const H = Math.max(30, Math.round(h * scale));
    const pad = 8;
    const parts = [];
    parts.push(
      `<defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#26334f"/><stop offset="1" stop-color="#141d31"/></linearGradient></defs>`,
      `<rect width="${W}" height="${H}" fill="url(#bg)"/>`
    );
    // 模拟"被截到的窗口"：标题栏 + 几行文本 + 一块深色编辑器
    parts.push(`<rect x="${pad}" y="${pad}" width="${W - pad * 2}" height="${H - pad * 2}" rx="6" fill="#1d2842" stroke="rgba(255,255,255,.16)"/>`);
    parts.push(`<circle cx="${pad + 10}" cy="${pad + 10}" r="2.5" fill="#f87171"/><circle cx="${pad + 19}" cy="${pad + 10}" r="2.5" fill="#fbbf24"/><circle cx="${pad + 28}" cy="${pad + 10}" r="2.5" fill="#34d399"/>`);
    let y = pad + 22;
    const lineH = Math.max(5, Math.min(11, Math.round(H / 12)));
    while (y < H - pad - 10) {
      const lw = (W - pad * 3) * (0.45 + ((y * 37) % 50) / 100);
      const accent = y % 3 === 0;
      parts.push(
        `<rect x="${pad + 10}" y="${y}" width="${lw}" height="${Math.max(2, lineH * 0.34)}" rx="1.5" fill="${accent ? "#7cc2ff" : "rgba(255,255,255,.28)"}" opacity="${accent ? 0.85 : 0.6}"/>`
      );
      y += lineH;
    }
    // 标注也画进缩略图
    cap.annots.forEach((a) => {
      const x = pad + (a.x * scale);
      const yy = pad + (a.y * scale);
      const aw = (a.w || 0) * scale;
      const ah = (a.h || 0) * scale;
      if (a.type === "rect") {
        parts.push(`<rect x="${x}" y="${yy}" width="${Math.max(2, aw)}" height="${Math.max(2, ah)}" fill="rgba(124,194,255,.12)" stroke="#7cc2ff" stroke-width="1.5" rx="2"/>`);
      } else if (a.type === "mosaic") {
        parts.push(`<rect x="${x}" y="${yy}" width="${Math.max(2, aw)}" height="${Math.max(2, ah)}" fill="#1a2338" stroke="rgba(255,255,255,.35)" stroke-dasharray="3 3"/>`);
      } else if (a.type === "arrow") {
        parts.push(`<line x1="${x}" y1="${yy}" x2="${x + aw}" y2="${yy + ah}" stroke="#7cc2ff" stroke-width="2" stroke-linecap="round"/>`);
      } else if (a.type === "text") {
        parts.push(
          `<text x="${x}" y="${yy + 12}" fill="#ffffff" font-family="Microsoft YaHei, sans-serif" font-size="12" font-weight="600" style="paint-order:stroke" stroke="rgba(0,0,0,.6)" stroke-width="2">${escapeXml(a.text || "")}</text>`
        );
      }
    });
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${parts.join("")}</svg>`;
    return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
  }

  function escapeXml(t) {
    return String(t).replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" }[c]));
  }

  /* ============================ 收尾 ============================ */
  function stop() {
    cap.phase = "idle";
    document.body.classList.remove("xj-capturing");
    if (cap.keyHandler) document.removeEventListener("keydown", cap.keyHandler, true);
    cap.keyHandler = null;
    if (cap.layer) {
      cap.layer.classList.add("leaving");
      const el = cap.layer;
      setTimeout(() => el.remove(), 160);
    }
    cap.layer = null;
    cap.selEl = null;
    cap.sel = null;
    cap.tools = null;
    cap.card = null;
    cap.draftEl = null;
    cap.annots = [];
    cap.drag = null;
  }

  XJ.capture = { start, stop, state: cap };
})();
