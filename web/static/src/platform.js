/* =============================================================================
   platform.js · 平台适配层
   原型里用 Web API 模拟 Windows 能力；真实实现替换为 Tauri command / Win32 调用。
   这一层的存在是为了让上层组件不直接依赖 navigator / localStorage / DOM 焦点细节。
   ========================================================================== */
(function () {
  const XJ = (window.XJ = window.XJ || {});

  /* ---------- 本地持久化（草稿 24h、设置、审计） ---------- */
  const NS = "xj.";
  const store = {
    get(key, fallback) {
      try {
        const raw = localStorage.getItem(NS + key);
        if (raw === null) return fallback;
        const box = JSON.parse(raw);
        if (box && box.expiresAt && box.expiresAt < Date.now()) {
          localStorage.removeItem(NS + key);
          return fallback;
        }
        return box && "v" in box ? box.v : fallback;
      } catch (_) {
        return fallback;
      }
    },
    set(key, value, ttlMs) {
      try {
        localStorage.setItem(
          NS + key,
          JSON.stringify({ v: value, expiresAt: ttlMs ? Date.now() + ttlMs : null })
        );
      } catch (_) {}
    },
    remove(key) {
      try {
        localStorage.removeItem(NS + key);
      } catch (_) {}
    },
  };

  /* ---------- 剪贴板 ---------- */
  const clipboard = {
    async writeText(text) {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch (_) {
        return false;
      }
    },
    async readText() {
      try {
        return await navigator.clipboard.readText();
      } catch (_) {
        return "";
      }
    },
  };

  /* ---------- 文件选择 / 读取 ---------- */
  function pickFiles() {
    return new Promise((resolve) => {
      const input = document.createElement("input");
      input.type = "file";
      input.multiple = true;
      input.style.position = "fixed";
      input.style.left = "-2000px";
      input.addEventListener("change", () => {
        resolve(Array.from(input.files || []));
        input.remove();
      });
      // 取消选择不会触发 change：1 分钟兜底回收
      setTimeout(() => input.remove(), 60000);
      document.body.appendChild(input);
      input.click();
    });
  }

  function readAsDataURL(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = reject;
      r.readAsDataURL(file);
    });
  }

  function readAsText(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).slice(0, 20000));
      r.onerror = reject;
      r.readAsText(file);
    });
  }

  /** §9.3.3 接受类型判定（模拟 Windows 侧规则，原型只用扩展名 + MIME） */
  const IMAGE_EXT = ["png", "jpg", "jpeg", "webp", "gif"];
  const TEXT_EXT = [
    "txt","md","markdown","json","js","mjs","cjs","ts","tsx","jsx","css","scss","html","htm",
    "xml","yml","yaml","toml","ini","cfg","py","rb","go","rs","java","kt","c","h","cpp","hpp",
    "cs","php","sh","ps1","bat","sql","csv","log","vue","svelte","lua","dart","swift","m","mm",
  ];
  const DOC_EXT = ["pdf"];

  function classifyFile(file) {
    const name = file.name || "";
    const ext = (name.split(".").pop() || "").toLowerCase();
    if (IMAGE_EXT.includes(ext) || /^image\//.test(file.type || "")) return "image";
    if (DOC_EXT.includes(ext) || file.type === "application/pdf") return "pdf";
    if (TEXT_EXT.includes(ext) || /^text\//.test(file.type || "")) return "text";
    return "binary";
  }

  /** 把 File 变成可发送的附件对象（含 20MB / 50MB 规则） */
  async function prepareAttachment(file) {
    const kind0 = classifyFile(file);
    if (kind0 === "binary") {
      return { ok: false, reason: "这个格式暂不支持", name: file.name };
    }
    if (kind0 === "image" && file.size > 20 * 1024 * 1024) {
      return { ok: false, reason: "图片超过 20MB", name: file.name };
    }
    if (kind0 !== "image" && file.size > 50 * 1024 * 1024) {
      return { ok: false, reason: "文件超过 50MB", name: file.name };
    }
    const att = {
      localId: XJ.dom.uid("att"),
      name: file.name,
      size: file.size,
      kind: kind0,
      status: "ready",
      mime: file.type,
    };
    if (kind0 === "image") {
      try {
        att.preview = await readAsDataURL(file);
        // 读取真实像素尺寸，用于缩略图比例
        const dim = await new Promise((res) => {
          const img = new Image();
          img.onload = () => res({ w: img.naturalWidth, h: img.naturalHeight });
          img.onerror = () => res(null);
          img.src = att.preview;
        });
        if (dim) {
          att.width = dim.w;
          att.height = dim.h;
        }
      } catch (_) {}
    }
    if (kind0 === "text") {
      try {
        att.previewText = (await readAsText(file)).slice(0, 240);
      } catch (_) {}
    }
    return { ok: true, att };
  }

  /* ---------- 快捷键 ---------- */
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform || "");
  function comboFromEvent(e) {
    const parts = [];
    if (e.ctrlKey) parts.push("Ctrl");
    if (e.altKey) parts.push("Alt");
    if (e.shiftKey) parts.push("Shift");
    const k = e.key;
    const modOnly = ["Control", "Alt", "Shift", "Meta"];
    if (modOnly.includes(k)) return null; // 还在按修饰键
    let key = k;
    if (k === " ") key = "Space";
    else if (k.length === 1) key = k.toUpperCase();
    else if (/^F\d{1,2}$/.test(k)) key = k;
    else if (k === "ArrowUp") key = "Up";
    else if (k === "ArrowDown") key = "Down";
    else if (k === "ArrowLeft") key = "Left";
    else if (k === "ArrowRight") key = "Right";
    else if (k === "Escape") key = "Esc";
    else return null;
    if (!parts.length) return null;
    parts.push(key);
    return parts.join("+");
  }

  function parseCombo(combo) {
    if (!combo) return null;
    const parts = String(combo).split("+");
    const key = parts.pop();
    return {
      ctrl: parts.includes("Ctrl"),
      alt: parts.includes("Alt"),
      shift: parts.includes("Shift"),
      key: key === "Space" ? " " : key.toLowerCase(),
    };
  }

  function matchCombo(e, combo) {
    const c = parseCombo(combo);
    if (!c) return false;
    const key = e.key === " " ? " " : e.key.toLowerCase();
    return (
      !!e.ctrlKey === c.ctrl &&
      !!e.altKey === c.alt &&
      !!e.shiftKey === c.shift &&
      key === c.key.toLowerCase()
    );
  }

  /* ---------- 提示音（默认关：仅在完成且用户开启时响） ---------- */
  let ac = null;
  function playChime(kind) {
    try {
      ac = ac || new (window.AudioContext || window.webkitAudioContext)();
      const t = ac.currentTime;
      const notes = kind === "approval" ? [523.25, 783.99] : [659.25, 987.77];
      notes.forEach((f, i) => {
        const o = ac.createOscillator();
        const g = ac.createGain();
        o.type = "sine";
        o.frequency.value = f;
        g.gain.setValueAtTime(0, t + i * 0.11);
        g.gain.linearRampToValueAtTime(0.06, t + i * 0.11 + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.11 + 0.34);
        o.connect(g).connect(ac.destination);
        o.start(t + i * 0.11);
        o.stop(t + i * 0.11 + 0.4);
      });
    } catch (_) {}
  }

  /* ---------- 焦点归还（§4.4）：记录唤起前的焦点 ---------- */
  const focusMemory = {
    lastExternal: null,
    remember() {
      const a = document.activeElement;
      if (a && a !== document.body && !a.closest("#xj-stage")) {
        this.lastExternal = a;
      }
    },
    restore() {
      if (this.lastExternal && document.contains(this.lastExternal)) {
        try {
          this.lastExternal.focus({ preventScroll: true });
        } catch (_) {}
      }
      const active = document.activeElement;
      if (active && active.closest && active.closest("#xj-stage")) {
        active.blur();
      }
      document.body.focus({ preventScroll: true });
    },
  };

  /* ---------- 环境 ---------- */
  const env = {
    dpr: () => window.devicePixelRatio || 1,
    isReducedMotion: () =>
      window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    isWindows: /Windows/.test(navigator.userAgent),
    accentDark: true,
  };

  XJ.platform = {
    store,
    clipboard,
    pickFiles,
    readAsDataURL,
    readAsText,
    classifyFile,
    prepareAttachment,
    comboFromEvent,
    parseCombo,
    matchCombo,
    playChime,
    focusMemory,
    env,
    isMac,
  };
})();
