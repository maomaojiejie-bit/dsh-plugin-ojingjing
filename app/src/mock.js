/* =============================================================================
   mock.js · 模拟 Harness 后端（§11 接口契约的可运行替身）
   目的：让交互与状态机可以在浏览器里完整走通，包括不美好路径（409/410/超时/断线）。
   ========================================================================== */
(function () {
  const XJ = (window.XJ = window.XJ || {});
  const { uid, uuidv7, wait } = XJ.dom;

  /* ---------- 会话种子：一个"有故事"的现场 ---------- */
  function seedSessions() {
    const t = Date.now();
    return [
      {
        id: "s_auth",
        title: "重构 auth 模块的 token 刷新",
        state: "working",
        action: "正在编辑 src/auth/token.ts",
        progress: 62,
        unread: false,
        active: true,
        startedAt: t - 6 * 60e3,
        lastActivityAt: t - 40e3,
      },
      {
        id: "s_test",
        title: "给登录页补 3 个单测",
        state: "working",
        action: "正在运行 npm test",
        progress: 34,
        unread: false,
        startedAt: t - 3 * 60e3,
        lastActivityAt: t - 15e3,
      },
      {
        id: "s_lic",
        title: "检查依赖里的许可证冲突",
        state: "idle",
        action: "已完成",
        progress: 100,
        unread: true,
        endedAt: t - 4 * 60e3,
        lastActivityAt: t - 4 * 60e3,
      },
      {
        id: "s_doc",
        title: "把 README 的截图流程写成脚本",
        state: "idle",
        action: "已完成",
        progress: 100,
        unread: true,
        endedAt: t - 42 * 60e3,
        lastActivityAt: t - 42 * 60e3,
      },
    ];
  }

  /* ---------- 审批样本 ---------- */
  const SAMPLES = {
    exec: {
      risk: "exec",
      summary: "安装依赖 zod@3.23.8",
      command: "npm i zod@3.23.8 --save",
      impact: "会在项目目录写入 node_modules 并更新 package.json",
    },
    write: {
      risk: "write",
      summary: "修改 src/auth/token.ts 的刷新逻辑",
      command: "src/auth/token.ts · 第 42–88 行 · 改动 47 行",
      impact: "会覆盖现有实现，旧代码进 git 历史，可回滚",
    },
    read: {
      risk: "read",
      summary: "读取项目里的配置文件",
      command: "src/config/app.config.ts",
      impact: "只读取，不修改任何文件",
    },
    network: {
      risk: "network",
      summary: "访问 GitHub 查询 zod 的最新版本",
      command: "GET https://api.github.com/repos/colinhacks/zod/releases",
      impact: "会把仓库名发送到外部，不含项目代码",
    },
    danger: {
      risk: "danger",
      summary: "删除 legacy/ 目录",
      command: "Remove-Item -Recurse -Force ./legacy",
      impact: "会删除 128 个文件，不可撤销，也不会进回收站",
    },
  };

  /* ---------- Mock 后端 ---------- */
  class Harness {
    constructor() {
      this.sessions = seedSessions();
      this.approvals = new Map(); // id -> {payload, status, decidedAt}
      this.questions = new Map();
      this.idempotency = new Map(); // key -> {status, body, at}
      this.attachments = new Map();
      this.listeners = new Set();
      this.connected = true;
      this.paused = false;
      this.latency = 320;
      this.seedApproval();
    }

    seedApproval() {
      const id = "ap_seed";
      this.approvals.set(id, {
        id,
        sessionId: "s_auth",
        risk: "exec",
        summary: SAMPLES.exec.summary,
        command: SAMPLES.exec.command,
        impact: SAMPLES.exec.impact,
        status: "pending",
        createdAt: Date.now(),
        expiresAt: Date.now() + 10 * 60e3,
      });
      return id;
    }

    on(fn) {
      this.listeners.add(fn);
      return () => this.listeners.delete(fn);
    }
    emit(type, payload) {
      for (const fn of this.listeners) {
        try {
          fn(type, payload);
        } catch (err) {
          console.error("[mock] listener", err);
        }
      }
    }

    /* ----- 快照 / 轮询对账（§11.4） ----- */
    snapshot() {
      return {
        api_version: "v1",
        generated_at: new Date().toISOString(),
        connection: this.connected ? "online" : "offline",
        sessions: this.sessions.map((s) => ({ ...s })),
        pending: [...this.approvals.values()]
          .filter((a) => a.status === "pending")
          .map((a) => ({
            id: a.id,
            session_id: a.sessionId,
            risk: a.risk,
            summary: a.summary,
            command: a.command,
            impact: a.impact,
            expires_at: new Date(a.expiresAt).toISOString(),
          })),
        // 原型的用量：数字会随会话数慢慢涨，看起来像在记账（真实数据由插件 lib/usage.js 下发）
        usage: this.usageSnapshot(),
      };
    }

    usageSnapshot() {
      if (!this._mockUsage) {
        this._mockUsage = { today: 0.084, tokens: 18420, balance: 11.42, at: Date.now() };
      }
      const u = this._mockUsage;
      const drift = this.sessions.filter((s) => s.state === "working").length;
      if (drift) {
        u.today = Math.round((u.today + 0.0021) * 10000) / 10000;
        u.tokens += 420;
        u.balance = Math.max(0, Math.round((u.balance - 0.0021) * 10000) / 10000);
      }
      return {
        day: new Date().toISOString().slice(0, 10),
        today: u.today,
        tokens: u.tokens,
        sessions: {},
        balance: u.balance,
        currency: "CNY",
        balance_at: u.at,
        balance_error: "",
      };
    }

    /* ----- 审批决策（§11.3.2） ----- */
    async decide(approvalId, opts) {
      const { decision, idempotencyKey, scope } = opts;
      await wait(this.latency + Math.random() * 160);
      if (!this.connected) throw { code: 503, error: "harness_unavailable" };

      const cached = this.idempotency.get(idempotencyKey);
      if (cached) return cached.body; // 幂等重放，直接返回首次结果

      const ap = this.approvals.get(approvalId);
      if (!ap) throw { code: 404, error: "not_found" };
      if (ap.status === "resolved" || ap.status === "expired") {
        if (ap.status === "resolved") throw { code: 409, error: "already_decided", by: ap.decidedBy };
        throw { code: 410, error: "expired" };
      }
      if (ap.expiresAt < Date.now()) {
        ap.status = "expired";
        throw { code: 410, error: "expired" };
      }
      if (scope === "session" && !["read"].includes(ap.risk)) {
        throw { code: 422, error: "scope_not_allowed", hint: "本会话内都允许仅适用只读操作" };
      }

      ap.status = "resolved";
      ap.decision = decision;
      ap.decidedBy = "widget";
      ap.decidedAt = Date.now();
      const body = {
        approval_id: approvalId,
        decision,
        scope: scope || "once",
        resolved_at: new Date().toISOString(),
      };
      this.idempotency.set(idempotencyKey, { status: 200, body });

      // 主窗口与悬浮窗同步（§9.5.2）
      this.emit("approval.resolved", {
        approval_id: approvalId,
        decision,
        by: "widget",
        session_id: ap.sessionId,
      });

      // 会话继续跑
      const sess = this.sessions.find((s) => s.id === ap.sessionId);
      if (sess && decision === "allow") {
        sess.state = "working";
        sess.action = ap.risk === "exec" ? "正在安装依赖" : "正在继续执行";
        sess.progress = Math.max(sess.progress, 18);
        sess.unread = false;
        sess.lastActivityAt = Date.now();
        this.emit("sessions.changed", { sessions: this.sessions.map((s) => ({ ...s })) });
      }
      if (sess && decision === "deny") {
        sess.state = "idle";
        sess.action = "已停止（审批被拒绝）";
        sess.progress = 0;
        sess.stoppedByUser = true;
        sess.lastActivityAt = Date.now();
        this.emit("sessions.changed", { sessions: this.sessions.map((s) => ({ ...s })) });
      }
      return body;
    }

    /* ----- 主窗口抢先处理（模拟跨端竞争） ----- */
    resolveElsewhere(approvalId, decision) {
      const ap = this.approvals.get(approvalId);
      if (!ap || ap.status !== "pending") return false;
      ap.status = "resolved";
      ap.decision = decision || "allow";
      ap.decidedBy = "web";
      ap.decidedAt = Date.now();
      this.emit("approval.resolved", {
        approval_id: approvalId,
        decision: ap.decision,
        by: "web",
        session_id: ap.sessionId,
      });
      return true;
    }

    /* ----- 新审批 ----- */
    pushApproval(kind, sessionId) {
      const s = SAMPLES[kind] || SAMPLES.exec;
      const id = "ap_" + uid("x").slice(2);
      const ap = {
        id,
        sessionId: sessionId || (this.sessions[0] && this.sessions[0].id),
        ...s,
        status: "pending",
        createdAt: Date.now(),
        expiresAt: Date.now() + (kind === "danger" ? 90e3 : 5 * 60e3),
      };
      this.approvals.set(id, ap);
      this.emit("approval.requested", {
        approval_id: id,
        session_id: ap.sessionId,
        risk: ap.risk,
        summary: ap.summary,
        command: ap.command,
        impact: ap.impact,
        expires_at: new Date(ap.expiresAt).toISOString(),
      });
      return ap;
    }

    pushQuestion(text) {
      const id = "q_" + uid("x").slice(2);
      this.questions.set(id, { id, status: "pending" });
      this.emit("question.requested", {
        question_id: id,
        session_id: this.sessions[0] && this.sessions[0].id,
        text: text || "这个接口要不要兼容旧版本？",
      });
      return id;
    }

    expireApproval(approvalId) {
      const ap = this.approvals.get(approvalId);
      if (!ap) return;
      ap.status = "expired";
      this.emit("approval.expired", { approval_id: approvalId });
    }

    /* ----- 发送 prompt（§9.1.4 队列 vs 打断） ----- */
    async prompt(sessionId, opts) {
      const { text, clientMsgId, queue } = opts;
      await wait(this.latency);
      if (!this.connected) throw { code: 503, error: "harness_unavailable" };
      const cached = this.idempotency.get(clientMsgId);
      if (cached) return cached.body;

      let sess = this.sessions.find((s) => s.id === sessionId);
      if (!sess) {
        // 目标会话不存在 → 新建（§9.1.2 第 4 条）
        sess = {
          id: "s_" + uid("n").slice(2),
          title: String(text || "新会话").slice(0, 22),
          state: "working",
          action: "正在思考",
          progress: 6,
          unread: false,
          active: true,
          startedAt: Date.now(),
          lastActivityAt: Date.now(),
        };
        this.sessions.unshift(sess);
      } else {
        this.sessions.forEach((s) => (s.active = s.id === sessionId));
        sess.lastActivityAt = Date.now();
        if (sess.state === "working" && queue !== false) {
          // 排队：不打断，模拟"当前任务完成后处理"
          const body = { message_id: clientMsgId, queued: true };
          this.idempotency.set(clientMsgId, { status: 202, body });
          this.emit("sessions.changed", { sessions: this.sessions.map((s) => ({ ...s })) });
          return body;
        }
        sess.state = "working";
        sess.action = "正在理解你的问题";
        sess.progress = 8;
        sess.unread = false;
      }
      const body = { message_id: clientMsgId, queued: false };
      this.idempotency.set(clientMsgId, { status: 202, body });
      this.emit("sessions.changed", { sessions: this.sessions.map((s) => ({ ...s })) });

      // 流式回复
      this.streamReply(sess, text);
      return body;
    }

    async streamReply(sess, text) {
      const lines = replyFor(text);
      await wait(420);
      let acc = "";
      sess.action = "正在回答";
      sess.progress = 45;
      this.emit("sessions.changed", { sessions: this.sessions.map((s) => ({ ...s })) });
      for (const chunk of lines) {
        if (!this.connected) return;
        await wait(160 + Math.random() * 180);
        acc += chunk;
        this.emit("message.delta", { session_id: sess.id, text: chunk, full: acc });
        sess.progress = Math.min(92, sess.progress + 9);
      }
      sess.state = "idle";
      sess.action = "已完成";
      sess.progress = 100;
      sess.endedAt = Date.now();
      sess.unread = true;
      sess.reply = acc;
      sess.lastActivityAt = Date.now();
      this.emit("session.completed", { session_id: sess.id, reply: acc });
      this.emit("sessions.changed", { sessions: this.sessions.map((s) => ({ ...s })) });
    }

    async stop(sessionId) {
      await wait(180);
      const sess = this.sessions.find((s) => s.id === sessionId);
      if (!sess) throw { code: 404, error: "not_found" };
      sess.state = "idle";
      sess.action = "已停止";
      sess.progress = 0;
      sess.unread = false;
      sess.stoppedByUser = true;
      sess.lastActivityAt = Date.now();
      this.emit("sessions.changed", { sessions: this.sessions.map((s) => ({ ...s })) });
      return { stopped: true };
    }

    async newSession(text) {
      await wait(this.latency);
      if (!this.connected) throw { code: 503, error: "harness_unavailable" };
      const sess = {
        id: "s_" + uid("n").slice(2),
        title: String(text || "新会话").slice(0, 24),
        state: "working",
        action: "正在理解你的问题",
        progress: 8,
        unread: false,
        active: true,
        startedAt: Date.now(),
        lastActivityAt: Date.now(),
      };
      this.sessions.forEach((s) => (s.active = false));
      this.sessions.unshift(sess);
      this.emit("sessions.changed", { sessions: this.sessions.map((s) => ({ ...s })) });
      this.streamReply(sess, text);
      return sess;
    }

    async uploadAttachment(att) {
      await wait(260 + Math.random() * 240);
      if (!this.connected) throw { code: 503, error: "harness_unavailable" };
      const id = "att_" + uid("x").slice(2);
      this.attachments.set(id, att);
      return {
        attachment_id: id,
        kind: att.kind,
        name: att.name,
        size: att.size,
        width: att.width,
        height: att.height,
      };
    }

    /* ----- 会话推进（模拟真实活动） ----- */
    tick() {
      if (!this.connected || this.paused) return;
      let changed = false;
      for (const s of this.sessions) {
        if (s.state !== "working") continue;
        const before = s.progress;
        s.progress = Math.min(96, s.progress + Math.random() * 4);
        if (Math.random() < 0.25) {
          s.action = pickAction(s);
        }
        s.lastActivityAt = Date.now();
        changed = changed || s.progress > before;
      }
      if (changed) {
        this.emit("sessions.changed", { sessions: this.sessions.map((s) => ({ ...s })) });
      }
    }

    setConnected(v) {
      this.connected = v;
      this.emit(v ? "connection.online" : "connection.offline", {});
    }

    reset() {
      this.sessions = seedSessions();
      this.approvals.clear();
      this.questions.clear();
      this.idempotency.clear();
      this.seedApproval();
      this.connected = true;
      this.emit("sessions.changed", { sessions: this.sessions.map((s) => ({ ...s })) });
    }
  }

  function pickAction(s) {
    const pool = ["正在读取 src/auth/token.ts", "正在运行 npm test", "正在搜索相关引用", "正在修改 3 个文件", "正在等待测试结果"];
    return pool[Math.floor(Math.random() * pool.length)];
  }

  function replyFor(text) {
    const t = String(text || "");
    if (/测试|test/i.test(t)) {
      return ["我在项目里找到了", " 12 个测试文件，", "先跑一遍基线：", "**全部通过**（耗时 3.4s）。", "接下来我会给登录页补上 3 个用例，", "覆盖空密码、超长输入和网络超时。"];
    }
    if (/图|截|看一/.test(t)) {
      return ["我看了这张截图。", "界面上的问题主要是：", "间距和卡片圆角不一致，", "建议把卡片圆角统一成 12px。", "要我直接改吗？"];
    }
    return ["收到，我先看一眼上下文。", "相关实现集中在 auth/token.ts，", "刷新逻辑和过期判断耦合在一起。", "拆开之后会更好测，", "预计改动 3 个文件。"];
  }

  XJ.mock = { Harness, SAMPLES, seedSessions };
})();
