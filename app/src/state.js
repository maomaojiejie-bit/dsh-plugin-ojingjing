/* =============================================================================
   state.js · 状态引擎
   核心：§4.3 三维正交模型 —— 展示 = f(连接态, 任务态, 待办 N, 未读数 M)
         §4.3.2 展示优先级是唯一真值表
         §4.3.3 完成态为"未读制"，不设计时器
   ========================================================================== */
(function () {
  const XJ = (window.XJ = window.XJ || {});
  const D = XJ.dom;

  /* ---------- 术语与枚举（§17.3 统一用词） ---------- */
  const RISK = {
    read: { label: "读文件", rank: 1, hint: "读取项目里的文件内容", scopeAllowed: true },
    write: { label: "写文件", rank: 2, hint: "修改项目里的文件", scopeAllowed: false },
    exec: { label: "执行命令", rank: 3, hint: "在你的项目目录执行一条命令", scopeAllowed: false },
    network: { label: "网络访问", rank: 4, hint: "访问外部网络地址", scopeAllowed: false },
    danger: { label: "删除 / 高危", rank: 5, hint: "删除文件或执行高危操作", scopeAllowed: false },
  };

  const SESSION_STATE = { working: "工作中", idle: "空闲" };

  /* ---------- 默认设置（§8.4 完整清单） ---------- */
  function defaultSettings() {
    return {
      autostart: false,
      hotkeyPanel: "Ctrl+Shift+Space",
      hotkeyCapture: "Ctrl+Shift+A",
      hotkeyQuick: "Ctrl+Shift+Q",
      dndEnabled: true,
      dndFrom: "22:00",
      dndTo: "08:00",
      dndRingApproval: false,
      notifyComplete: true,
      soundComplete: true,
      soundApproval: true,
      pollInterval: 15,
      port: "auto",
      clickThrough: false,
      motion: "system", // system | reduce
      presentation: "auto", // auto | always | off
      telemetry: true,
      confirmDrop: true,
      reduceAnim: false,
      // 闲下来主动搭话：闲置多久说一句（分钟）；连着没人理会自动拉长间隔
      idleNudge: true,
      idleNudgeMin: 6,
    };
  }

  /* ---------- 初始状态 ---------- */
  function createState() {
    return {
      connection: "online", // online | reconnecting | offline
      lastSyncAt: Date.now(),
      /* 用量与余额：由插件的 /xj/state 下发（lib/usage.js 算的），这里只做搬运与展示。
         sessions 是「每个会话今天花了多少」，键是 sessionId。 */
      usage: {
        day: "",
        today: 0,
        tokens: 0,
        sessions: {},
        balance: null,
        currency: "CNY",
        balanceAt: 0,
        error: "",
        loading: false,
      },
      sessions: [],
      approvals: {}, // id -> approval
      questions: {}, // id -> question
      audit: [], // §9.5.7 本地审计（仅元数据，30 天）
      settings: Object.assign(defaultSettings(), XJ.platform.store.get("settings", {})),
      runtime: {
        dnd: { active: false },
        sharing: false, // 共享/投屏检测结果
        fullscreen: false,
        presenting: false, // 生效中的演示模式
        silent: false, // 全屏静默
        dpi: 100,
        viewport: "1920x1080",
        tokenInvalid: false,
        simSendFail: false,
        simApprovalExpire: false,
        imeComposing: false,
        foreground: "dsh-main", // 前台窗口（§4.4 焦点归还）
      },
      ui: {
        form: "collapsed", // collapsed | bubble | quickbar | panel
        panelScreen: "home", // home | approvalCenter
        onboardingStep: 0,
        showOnboarding: false,
        pendingCounter: 0,
        toastQueue: [],
        dropState: null, // { files, targetSessionId, phase }
        screenshot: null, // 截图状态机（§9.2.2）
        stopConfirmSessionId: null,
        approvalDetailId: null,
        line: null, // 当前台词 { text, ctx, at }（lines.js 抽，hover 时刷新）
      },
      composer: {
        text: "",
        attachments: [], // {localId, name, size, kind, attachmentId, status}
        targetSessionId: null,
        clientMsgId: null,
        sending: false,
        error: null,
        lastReply: null, // {sessionId, text, done}
      },
      events: [], // 事件日志（原型控制台用）
      metrics: { launchedAt: Date.now(), promptSent: 0, approvalDecided: 0 },
    };
  }

  /* ---------- 派生：真值表（§4.3.2） ---------- */
  /** 待办列表：风险从高到低，其次等得久的在前（§9.5 审批中心排序 = 风险 > 等待时长） */
  function pendingList(s) {
    const list = [...Object.values(s.approvals), ...Object.values(s.questions)].filter(
      (x) => x.status === "pending" || x.status === "submitting" || x.status === "failed"
    );
    const rank = (x) => (RISK[x.risk] ? RISK[x.risk].rank : 3);
    return list.sort((a, b) => rank(b) - rank(a) || (a.waitingSince || 0) - (b.waitingSince || 0));
  }

  function counts(s) {
    const pending = pendingList(s).filter((x) => x.status !== "resolved").length;
    const unread = s.sessions.filter((x) => x.unread).length;
    return { pending, unread };
  }

  function anyWorking(s) {
    return s.sessions.some((x) => x.state === "working");
  }

  /**
   * 主状态：按优先级 1→5 顺序匹配，命中即停；角标不受命中行影响，独立显示。
   */
  function mainStatus(s) {
    const c = counts(s);
    const base = { pending: c.pending, unread: c.unread };
    if (s.connection === "offline") {
      return {
        ...base,
        level: 1,
        expression: "offline",
        aura: "gray",
        label: "连不上 Harness",
        tone: "offline",
      };
    }
    if (c.pending > 0) {
      return {
        ...base,
        level: 2,
        expression: "alert",
        aura: "amber",
        label: "有个操作等你点头",
        tone: "warning",
      };
    }
    if (anyWorking(s)) {
      return {
        ...base,
        level: 3,
        expression: "focus",
        aura: "blue",
        label: "正在干活",
        tone: "accent",
      };
    }
    if (c.unread > 0) {
      return {
        ...base,
        level: 4,
        expression: "happy",
        aura: "green",
        label: "跑完了，去看看？",
        tone: "success",
      };
    }
    return {
      ...base,
      level: 5,
      expression: "sleep",
      aura: "none",
      label: "歇着呢，有事叫我",
      tone: "idle",
    };
  }

  /* ---------- 派生：会话排序（§8.2 待办 > 工作中 > 未读） ---------- */
  function sessionRank(sess, s) {
    const hasPending = pendingList(s).some((x) => x.sessionId === sess.id);
    if (hasPending) return 0;
    if (sess.state === "working") return 1;
    if (sess.unread) return 2;
    return 3;
  }

  function sortedSessions(s) {
    return [...s.sessions].sort((a, b) => {
      const r = sessionRank(a, s) - sessionRank(b, s);
      if (r !== 0) return r;
      return b.lastActivityAt - a.lastActivityAt;
    });
  }

  function sessionById(s, id) {
    return s.sessions.find((x) => x.id === id) || null;
  }

  /** 目标会话判定顺序（§9.1.2） */
  function resolveTargetSession(s) {
    const c = s.composer;
    if (c.targetSessionId) {
      const found = sessionById(s, c.targetSessionId);
      if (found && found.state !== "closed") return found;
    }
    // 主窗口当前会话（模拟客户端提供 active_session_id）
    const active = s.sessions.find((x) => x.active);
    if (active) return active;
    const alive = s.sessions.filter((x) => x.state !== "closed");
    if (alive.length) {
      return alive.sort((a, b) => b.lastActivityAt - a.lastActivityAt)[0];
    }
    return null;
  }

  /* ---------- 派生：免打扰 / 演示模式（§6.7 / §10.5） ---------- */
  function inDndWindow(s, now) {
    if (!s.settings.dndEnabled) return false;
    const t = now || new Date();
    const cur = t.getHours() * 60 + t.getMinutes();
    const [fh, fm] = s.settings.dndFrom.split(":").map(Number);
    const [th, tm] = s.settings.dndTo.split(":").map(Number);
    const from = fh * 60 + fm,
      to = th * 60 + tm;
    return from <= to ? cur >= from && cur < to : cur >= from || cur < to;
  }

  /** 演示模式是否生效：自动档看共享检测，常开档永远开 */
  function presenting(s) {
    const mode = s.settings.presentation;
    if (mode === "off") return false;
    if (mode === "always") return true;
    return !!s.runtime.sharing || !!s.runtime.fullscreen;
  }

  /** 演示模式下的对外标题：会话标题降级为「会话 1 / 会话 2」（§10.5） */
  function displayTitle(s, sess) {
    if (!sess) return "未知会话";
    if (!presenting(s)) return sess.title;
    const idx = s.sessions.findIndex((x) => x.id === sess.id);
    return "会话 " + (idx >= 0 ? idx + 1 : 1);
  }

  /** 提醒等级（§6.7 表格）：strong | notifyOnly | silent */
  function reminderLevel(s, kind) {
    if (s.runtime.silent) return "silent";
    if (presenting(s)) return "notifyOnly";
    if (inDndWindow(s)) return s.settings.dndRingApproval && kind === "approval" ? "strong" : "notifyOnly";
    return "strong";
  }

  /* ---------- Store ---------- */
  const store = {
    state: null,
    subs: new Set(),
    logs: [],
    init() {
      this.state = createState();
      this.state.composer.targetSessionId = null;
      return this.state;
    },
    get s() {
      return this.state;
    },
    subscribe(fn) {
      this.subs.add(fn);
      return () => this.subs.delete(fn);
    },
    /** 记录一条假 SSE 事件，供原型控制台回放 */
    log(type, payload) {
      this.state.events.unshift({
        type,
        payload,
        at: Date.now(),
      });
      if (this.state.events.length > 60) this.state.events.length = 60;
    },
    emit() {
      for (const fn of this.subs) {
        try {
          fn(this.state);
        } catch (err) {
          console.error("[哦鲸鲸] 订阅者异常", err);
        }
      }
    },
    patch(fn) {
      fn(this.state);
      this.emit();
    },
  };

  /* ---------- Actions ---------- */
  const actions = {
    setConnection(conn) {
      const s = store.state;
      if (s.connection === conn) return;
      store.log("connection.changed", { from: s.connection, to: conn });
      s.connection = conn;
      s.lastSyncAt = Date.now();
      store.emit();
    },

    setSnapshot(snapshot) {
      const s = store.state;
      const prevUnread = new Set(s.sessions.filter((x) => x.unread).map((x) => x.id));
      s.sessions = snapshot.sessions.map((x) => ({
        ...x,
        lastActivityAt: x.lastActivityAt || Date.now(),
        unread: prevUnread.has(x.id) ? true : !!x.unread,
      }));
      s.connection = snapshot.connection || s.connection;
      s.lastSyncAt = Date.now();
      store.log("sessions.changed", { count: s.sessions.length });
      store.emit();
    },

    /** §11.3 approval.requested —— N+1 + 强提醒 */
    approvalRequested(a) {
      const s = store.state;
      s.approvals[a.id] = {
        id: a.id,
        kind: "approval",
        sessionId: a.sessionId,
        risk: a.risk || "exec",
        summary: a.summary,
        command: a.command || "",
        impact: a.impact || "",
        status: "pending",
        waitingSince: Date.now(),
        expiresAt: a.expiresAt || Date.now() + 120000,
      };
      store.log("approval.requested", { approval_id: a.id, session_id: a.sessionId, risk: a.risk });
      s.ui.pendingCounter++;
      store.emit();
      return s.approvals[a.id];
    },

    questionRequested(q) {
      const s = store.state;
      s.questions[q.id] = {
        id: q.id,
        kind: "question",
        sessionId: q.sessionId,
        risk: "read",
        summary: q.text,
        command: "",
        text: q.text,
        status: "pending",
        waitingSince: Date.now(),
        expiresAt: Date.now() + 900000,
      };
      store.log("question.requested", { question_id: q.id, session_id: q.sessionId });
      s.ui.pendingCounter++;
      store.emit();
      return s.questions[q.id];
    },

    /** §4.3.5 审批被处理（任一端）→ N-1，跨端同步 */
    approvalResolved(id, decision, by) {
      const s = store.state;
      const item = s.approvals[id] || s.questions[id];
      if (!item) return;
      item.status = "resolved";
      item.decision = decision;
      item.resolvedBy = by || "web";
      item.resolvedAt = Date.now();
      delete s.approvals[id];
      if (s.questions[id]) delete s.questions[id];
      // §9.5.7 审计：只存元数据（提问不算审批决定，不写审计）
      if (item.kind !== "question") {
        s.audit.unshift({
          at: Date.now(),
          id,
          sessionId: item.sessionId,
          risk: item.risk,
          decision,
          by: item.resolvedBy,
          waitedMs: Date.now() - item.waitingSince,
        });
        if (s.audit.length > 200) s.audit.length = 200;
      }
      store.log("approval.resolved", { approval_id: id, decision, by: item.resolvedBy });
      store.emit();
    },

    approvalSubmitting(id) {
      const s = store.state;
      const a = s.approvals[id];
      if (!a) return;
      a.status = "submitting";
      a.error = null;
      store.emit();
    },

    approvalFailed(id, message) {
      const s = store.state;
      const a = s.approvals[id];
      if (!a) return;
      a.status = "failed";
      a.error = message || "没发出去，重试？";
      store.emit();
    },

    approvalExpired(id) {
      const s = store.state;
      const a = s.approvals[id];
      if (!a) return;
      a.status = "expired";
      store.log("approval.expired", { approval_id: id });
      store.emit();
      setTimeout(() => {
        if (s.approvals[id] && s.approvals[id].status === "expired") {
          delete s.approvals[id];
          store.emit();
        }
      }, 4000);
    },

    /** §4.3.3 会话结束且未查看 → M+1（按会话计，不按事件计） */
    sessionCompleted(sessionId, opts) {
      const s = store.state;
      const sess = sessionById(s, sessionId);
      if (!sess) return;
      sess.state = "idle";
      sess.action = "已完成";
      sess.progress = 100;
      sess.endedAt = Date.now();
      sess.lastActivityAt = Date.now();
      if (!(opts && opts.userStopped)) {
        sess.unread = true;
      }
      store.log("session.completed", { session_id: sessionId, unread: sess.unread });
      store.emit();
    },

    /** 用户点停止并确认 → 不产生未读（§4.3.5） */
    sessionStopped(sessionId) {
      const s = store.state;
      const sess = sessionById(s, sessionId);
      if (!sess) return;
      sess.state = "idle";
      sess.action = "已停止";
      sess.progress = 0;
      sess.unread = false;
      sess.stoppedByUser = true;
      sess.lastActivityAt = Date.now();
      store.log("session.stopped", { session_id: sessionId });
      store.emit();
    },

    /** 点击 unread 会话 → M-1 */
    sessionViewed(sessionId) {
      const s = store.state;
      const sess = sessionById(s, sessionId);
      if (!sess) return;
      if (sess.unread) {
        sess.unread = false;
        store.emit();
      }
    },

    markAllRead() {
      const s = store.state;
      s.sessions.forEach((x) => (x.unread = false));
      store.emit();
    },

    sessionWorking(sessionId, action, progress) {
      const s = store.state;
      const sess = sessionById(s, sessionId);
      if (!sess) return;
      sess.state = "working";
      sess.action = action || sess.action;
      sess.progress = progress == null ? sess.progress : progress;
      sess.unread = false;
      sess.lastActivityAt = Date.now();
      store.emit();
    },

    setActiveSession(sessionId) {
      const s = store.state;
      s.sessions.forEach((x) => (x.active = x.id === sessionId));
      store.emit();
    },

    patchSettings(patch) {
      const s = store.state;
      Object.assign(s.settings, patch);
      XJ.platform.store.set("settings", s.settings);
      store.emit();
    },

    /** 各形态互斥（§9.4.3：同一时刻只有一个 Composer 可见） */
    setForm(form) {
      const s = store.state;
      if (s.ui.form === form) return;
      s.ui.form = form;
      if (form !== "panel") s.ui.panelScreen = "home";
      store.emit();
    },

    setPanelScreen(screen) {
      store.state.ui.panelScreen = screen;
      store.emit();
    },

    composerText(text) {
      store.state.composer.text = text;
      // 不 emit：避免每次按键重渲染打断输入
      XJ.platform.store.set("draft", { text, at: Date.now() });
    },

    composerTarget(sessionId) {
      const s = store.state;
      s.composer.targetSessionId = sessionId;
      store.state.sessions.forEach((x) => (x.active = x.id === sessionId));
      store.emit();
    },

    composerError(msg) {
      store.state.composer.error = msg;
      store.emit();
    },

    composerAttachments(fn) {
      fn(store.state.composer);
      store.emit();
    },

    /** 用量快照落地（/xj/state 的 usage 字段，或刷新余额后单独拉回来的） */
    setUsage(u) {
      const s = store.state;
      if (!u) return;
      const prev = s.usage;
      const next = {
        day: u.day || prev.day,
        today: Number(u.today) || 0,
        tokens: Number(u.tokens) || 0,
        sessions: u.sessions && typeof u.sessions === "object" ? u.sessions : prev.sessions,
        balance: u.balance == null ? (u.balance === null ? null : prev.balance) : Number(u.balance),
        currency: u.currency || prev.currency,
        balanceAt: Number(u.balance_at || u.balanceAt) || prev.balanceAt,
        error: u.balance_error != null ? String(u.balance_error || "") : u.error != null ? String(u.error) : prev.error,
        loading: u.loading == null ? prev.loading : !!u.loading,
      };
      // 数字没变就别 emit：面板每 15 秒拉一次快照，白重渲染一次就是白抖一次
      const same =
        next.day === prev.day &&
        next.today === prev.today &&
        next.tokens === prev.tokens &&
        next.balance === prev.balance &&
        next.balanceAt === prev.balanceAt &&
        next.error === prev.error &&
        next.loading === prev.loading &&
        JSON.stringify(next.sessions) === JSON.stringify(prev.sessions);
      if (same) return;
      s.usage = next;
      store.emit();
    },

    usageLoading(on) {
      store.state.usage.loading = !!on;
      store.emit();
    },
  };

  XJ.state = {
    store,
    actions,
    RISK,
    pendingList,
    counts,
    mainStatus,
    sortedSessions,
    sessionById,
    resolveTargetSession,
    inDndWindow,
    presenting,
    displayTitle,
    reminderLevel,
    defaultSettings,
    sessionRank,
  };
})();
