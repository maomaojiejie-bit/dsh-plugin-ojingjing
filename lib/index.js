/**
 * 哦鲸鲸悬浮窗 · DSH 宿主插件（入口：package.json 的 main → lib/index.js）
 *
 * 标准的 DSH bundle host 插件（Cordis 插件对象：`export default { name, apply(root) }`）：
 *   - 在宿主进程里注册 `approval/request` waterfall 应答者，把审批推给哦鲸鲸
 *   - 监听 `session/event` 汇总会话状态（工作中 / 跑完 / 未读）
 *   - 通过 ctx.webServer 暴露 /xj/* 路由（数据、决定回传、截图提问投递 /xj/prompt）
 *   - 可选：通过 `webserver/index-inject` 往 DSH 页面注入 iframe 承载的哦鲸鲸
 *     （默认关：`INJECT_IN_PAGE = false`，独立桌面窗只需要 /xj/* 数据接口）
 *   - 可选：DSH 启动时拉起独立窗（`~/.dsh/ojingjing-shell.json`）
 *
 * 约定：
 *   - 不同对象级 `inject`，`apply()` 立即执行；需要服务的逻辑各自 `root.inject([...], …)`，
 *     免得宿主启动时那一次注入表收集被推迟。
 *   - 卸载收尾挂 `root.effect(() => () => …)`；路由/监听器随插件作用域回收。
 *
 * 不读对话正文，不落盘命令内容：命令摘要只活在内存里，进程退出即消失。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createUsage } from "./usage.js";

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WEB_ROOT = path.join(PACKAGE_ROOT, "web");

/** 独立窗的启动配置：装着「外壳目录 + 解释器候选」，由 tools/install-plugin.mjs 写 */
const SHELL_CONFIG = path.join(os.homedir(), ".dsh", "ojingjing-shell.json");
let shellSpawned = false;
let shellChild = null;

/**
 * DSH 启动时顺手拉起独立窗（哦鲸鲸）。
 *
 * 为什么要放在插件里：插件跑在宿主 utility 进程里，能拿到 Node 的 child_process，
 * 而窗口本身必须由独立进程画（宿主没有 BrowserWindow）。所以「DSH 打开 → 哦鲸鲸出现」
 * 就是「宿主插件 fork 一个 pythonw」。
 *
 * 幂等靠两道锁：这里的 shellSpawned，以及外壳自己的命名互斥量（重复启动会自我退出）。
 */
function launchShellIfNeeded(root) {
  try {
    if (shellSpawned) return;
    if (!fs.existsSync(SHELL_CONFIG)) {
      root.logger?.info?.("[ojingjing] 没找到 ojingjing-shell.json，跳过自动拉起独立窗");
      return;
    }
    const cfg = JSON.parse(fs.readFileSync(SHELL_CONFIG, "utf8"));
    if (cfg.autoLaunch === false) {
      root.logger?.info?.("[ojingjing] autoLaunch=false，不自动拉起独立窗");
      return;
    }
    const shellDir = cfg.shellDir;
    const script = path.join(shellDir || "", cfg.script || "ojingjing_py.py");
    if (!shellDir || !fs.existsSync(script)) {
      root.logger?.info?.(`[ojingjing] 外壳脚本不存在（${script}），跳过自动拉起`);
      return;
    }
    const launcher = (cfg.launchers || []).find((p) => p && fs.existsSync(p));
    if (!launcher) {
      root.logger?.info?.("[ojingjing] 没有可用的 pythonw，跳过自动拉起");
      return;
    }
    const child = spawn(launcher, [script], {
      cwd: shellDir,
      detached: true,
      stdio: "ignore",
      env: { ...process.env, XJ_LAUNCHED_BY: "dsh" },
      windowsHide: true,
    });
    child.unref();
    shellSpawned = true;
    shellChild = child;
    root.logger?.info?.(`[ojingjing] 已拉起独立窗：${launcher} ${script}`);
  } catch (err) {
    root.logger?.info?.(`[ojingjing] 自动拉起失败：${err && err.message ? err.message : err}`);
  }
}

/**
 * 插件卸载 / DSH 退出时收尾：只关我们自己拉起来的那个子进程，
 * 用户手动启动的实例不动（那是他自己的窗口）。
 */
function stopShellIfOwned() {
  if (!shellChild) return;
  try {
    if (!shellChild.killed) shellChild.kill();
  } catch {}
  shellChild = null;
  shellSpawned = false;
}

/** 允许内联进 prompt 的图片类型（@deepseek-ai/dsh-attachment 的 ImageMediaType） */
const IMAGE_MEDIA_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
/** prompt 里内联图片的硬上限：20MiB（DSH 的 imageLimits.maxImageBytes 默认值），base64 后约 28MB */
const MAX_IMAGE_BASE64 = 28 * 1024 * 1024;

/** 审批 -> 风险等级（只用于展示与排序，不参与放行策略） */
function riskOf(toolName) {
  const n = String(toolName || "").toLowerCase();
  if (/delete|remove|rm|trash|unlink/.test(n)) return "danger";
  if (/bash|shell|exec|command|run|terminal|pwsh/.test(n)) return "exec";
  if (/write|edit|create|patch|apply/.test(n)) return "write";
  if (/fetch|http|browser|web|download|upload/.test(n)) return "network";
  return "read";
}

/** 会话标题：不同版本字段不一样，逐个兜底 */
function titleOf(session) {
  if (!session) return "会话";
  const cands = [
    session.name,
    session.title,
    session.label,
    session.summary && session.summary.title,
    session.meta && session.meta.title,
  ];
  for (const c of cands) if (typeof c === "string" && c.trim()) return c.trim();
  const id = String(session.id || "");
  return id ? "会话 " + id.slice(-4) : "会话";
}

function oneLine(value) {
  if (!value) return "";
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.replace(/\s+/g, " ").slice(0, 240);
}

/** 从工具参数里挑一句人话摘要 + 一段等宽命令 */
function describeToolCall(name, args) {
  const a = args && typeof args === "object" ? args : {};
  const pick = (...keys) => {
    for (const k of keys) if (typeof a[k] === "string" && a[k].trim()) return a[k].trim();
    return "";
  };
  const command = pick("command", "cmd", "script", "shell", "input", "query");
  const target = pick("path", "file_path", "filePath", "file", "url", "pattern", "target");
  const summary = command ? oneLine(command).slice(0, 80) : target ? oneLine(target).slice(0, 80) : oneLine(name);
  return { summary, command: command || target || "" };
}

export default {
  /** 和 package.json 的 name 一致（Cordis 用它做服务命名空间前缀） */
  name: "dsh-plugin-ojingjing",
  // 刻意不用对象级 inject：apply() 一进来就把注入行 / 路由注册好，
  // 需要服务的逻辑再各自 root.inject() 等，避免宿主启动的那一次收集被推迟。
  apply(root) {
    // 退订 / 子进程收尾都挂到 root.effect 上：插件卸载或 DSH 退出时自动执行。
    // （root.on / ctx.webServer.register 注册在插件作用域里，Cordis 会随插件卸载回收；
    //   唯一需要手动管的是我们 spawn 出来的独立窗进程。）
    root.effect(() => () => {
      stopShellIfOwned();
    });

    // 用量账本：从 session/event 的真实 usage 累出「今天 / 这个会话花了多少」，
    // 顺带每 60 秒问一次 DeepSeek 余额（见 lib/usage.js 顶部说明）
    const usage = createUsage();

    const state = {
      sessions: new Map(), // sessionId -> 只进内存的会话快照
      approvals: new Map(), // approvalId -> 待决定请求
      questions: new Map(), // questionId -> 待回答的提问（带选项的那种）
      calls: new Map(), // callId -> { name, args }
      seq: 0,
      lastWidgetPing: 0,
      rev: 0,
      sessionController: null, // 由下方 inject 填入，用于「截图提问」投递 prompt
    };

    const touch = () => {
      state.rev += 1;
    };

    const sessionRecord = (session) => {
      const id = String((session && session.id) || "unknown");
      let rec = state.sessions.get(id);
      if (!rec) {
        rec = {
          id,
          title: titleOf(session),
          state: "idle",
          action: "",
          progress: 0,
          unread: 0,
          lastActivityAt: Date.now(),
        };
        state.sessions.set(id, rec);
        touch();
      } else {
        const t = titleOf(session);
        if (t && t !== rec.title) rec.title = t;
      }
      return rec;
    };

    /* ---------------- 审批应答者 ---------------- */
    // waterfall：返回 outcome 即"由我作答"，否则 call next() 交给后面的应答者。
    // 只在页面哦鲸鲸在近 20 秒内 ping 过时才接管，避免用户没开浮窗时把审批吞掉。
    root.on("approval/request", async (req, next) => {
      const widgetAlive = Date.now() - state.lastWidgetPing < 20_000;
      if (!widgetAlive) return next();
      const id = "xj_ap_" + ++state.seq;
      const agent = req && req.agent;
      const session = agent && agent.session;
      const rec = sessionRecord(session);
      const call = req && req.callId ? state.calls.get(String(req.callId)) : undefined;
      const described = describeToolCall(req && req.toolName, call && call.args);
      const entry = {
        id,
        toolName: String((req && req.toolName) || "tool"),
        risk: riskOf(req && req.toolName),
        reason: oneLine(req && req.reason),
        summary: described.summary,
        command: described.command,
        sessionId: rec.id,
        sessionTitle: rec.title,
        requestedAt: Date.now(),
        resolve: null,
      };
      state.approvals.set(id, entry);
      touch();
      process.stderr.write(`ojingjing: approval ${entry.toolName} (${entry.risk}) pending\n`);

      return await new Promise((resolve) => {
        let settled = false;
        const finish = (outcome) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          state.approvals.delete(id);
          touch();
          resolve(outcome);
        };
        entry.resolve = finish;
        // 兜底：5 分钟没人点头 → fail closed，别把 agent 挂死
        const timer = setTimeout(() => finish("unavailable"), 5 * 60 * 1000);
        if (req && req.signal) {
          req.signal.addEventListener("abort", () => finish("cancelled"), { once: true });
        }
      });
    });

    /* ---------------- 提问应答者（带选项按钮的那种） ---------------- */
    // 跟审批同一套策略：浮窗近 20 秒 ping 过才接管，否则 next() 交给别的应答者
    // （DSH 自带 Web 界面就是另一个应答者）。区别是提问可能一次带好几个问题、
    // 每个问题一列可选项，所以条目里存整批 questions，答案按问题 id 逐条回。
    // 答案形状照 @deepseek-ai/dsh-user-questions 的约定：
    //   { answers: [{ id, selected: ["选项标签"], custom?: "自定义文本" }] }
    root.on("user-questions/request", async (req, next) => {
      const widgetAlive = Date.now() - state.lastWidgetPing < 20_000;
      if (!widgetAlive) return next();
      const list = Array.isArray(req && req.questions) ? req.questions : [];
      if (!list.length) return next();

      const id = "xj_q_" + ++state.seq;
      const agent = req && req.agent;
      const session = agent && agent.session;
      const rec = session ? sessionRecord(session) : null;
      const clip = (value, max) => oneLine(value).slice(0, max);
      const entry = {
        id,
        sessionId: rec ? rec.id : "",
        sessionTitle: rec ? rec.title : "",
        requestedAt: Date.now(),
        questions: list.map((q) => ({
          id: String((q && q.id) || ""),
          header: clip(q && q.header, 24),
          question: clip(q && q.question, 160),
          detail: q && q.detail ? clip(q.detail, 600) : "",
          multiSelect: !!(q && q.multiSelect),
          options: (Array.isArray(q && q.options) ? q.options : []).slice(0, 8).map((o) => ({
            label: clip(o && o.label, 60),
            description: clip(o && o.description, 120),
          })),
        })),
        resolve: null,
      };
      state.questions.set(id, entry);
      touch();
      process.stderr.write(`ojingjing: question ${entry.questions.length} 条 pending\n`);

      return await new Promise((resolve) => {
        let settled = false;
        const finish = (answers) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          state.questions.delete(id);
          touch();
          // 契约（@deepseek-ai/dsh-user-questions 的 answerBatchSchema）要的是
          // { answers: [...] } 而不是裸数组，工具侧 answerResult() 直接读 result.answers
          resolve({ answers });
        };
        entry.resolve = finish;
        // 15 分钟没人回答 → 空答案（等于「跳过」），别把 agent 挂死
        const timer = setTimeout(() => finish([]), 15 * 60 * 1000);
        if (req && req.signal) {
          // 提问被撤（agent 被中断 / 会话关了）：回空答案让它走「用户没答」那条路
          req.signal.addEventListener("abort", () => finish([]), { once: true });
        }
      });
    });

    /* ---------------- 会话状态 ---------------- */
    root.on("session/event", (session, event) => {
      try {
        const rec = sessionRecord(session);
        const type = event && event.type;
        const data = (event && event.data) || {};
        rec.lastActivityAt = Date.now();
        if (type === "turn/start") {
          rec.state = "working";
          rec.progress = 0.35;
          rec.action = rec.action || "正在处理";
        } else if (type === "turn/end") {
          rec.state = "idle";
          rec.progress = 0;
          rec.action = "刚跑完";
          rec.unread += 1;
        } else if (type === "tool/call") {
          const callId = data.callId || data.id;
          const name = data.name || data.toolName || "tool";
          if (callId) state.calls.set(String(callId), { name, args: data.arguments || data.args || data.input });
          if (rec.state === "working") rec.action = "正在" + String(name).replace(/^dsh(-tool)?[-_]?/i, "");
        } else if (type === "tool/result") {
          if (rec.state === "working") rec.action = "正在处理结果";
        } else if (type === "assistant/message") {
          // 唯一能算钱的信号：assistant/message 带真实 usage（input / 缓存读到 / 输出），
          // 乘当前模型价目表换成人民币，并进「今天」和「这个会话」（lib/usage.js）
          if (data.usage) {
            usage.observe({
              sessionId: rec.id,
              usage: data.usage,
              model: data.message && data.message.source ? data.message.source.model : "",
              at: Date.now(),
            });
          }
        }
        if (typeof data.title === "string" && data.title.trim()) rec.title = data.title.trim();
        if (state.calls.size > 400) {
          const keep = [...state.calls.keys()].slice(-200);
          state.calls = new Map();
          void keep;
        }
        touch();
      } catch (err) {
        process.stderr.write(`ojingjing: session event failed: ${String(err)}\n`);
      }
    });

    /* ---------------- HTTP ---------------- */
    const security = (req) => {
      // 只认回环 Host；带 Origin 时要求同源；跨站标记一律拒绝。
      try {
        const headers = (req && req.headers) || {};
        const host = String(headers.host || "");
        const hostName = host.replace(/:\d+$/, "").toLowerCase();
        const loopback =
          hostName === "127.0.0.1" ||
          hostName === "localhost" ||
          hostName === "[::1]" ||
          hostName === "::1";
        if (!loopback) return 403;
        if (String(headers["sec-fetch-site"] || "").toLowerCase() === "cross-site") return 403;
        const origin = headers.origin;
        if (typeof origin === "string" && origin && origin !== "null") {
          const u = new URL(origin);
          if (u.host.toLowerCase() !== host.toLowerCase()) return 403;
        }
        return 0;
      } catch {
        return 403;
      }
    };

    const json = (res, code, body) => {
      const text = JSON.stringify(body);
      res.writeHead(code, {
        "content-type": "application/json; charset=utf-8",
        "content-length": Buffer.byteLength(text),
        "cache-control": "no-store",
      });
      res.end(text);
    };

    const MIME = {
      ".html": "text/html; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".svg": "image/svg+xml",
      ".png": "image/png",
      ".json": "application/json; charset=utf-8",
      ".woff2": "font/woff2",
    };

    const serveFile = (res, rel) => {
      const target = path.resolve(WEB_ROOT, "." + rel);
      if (!target.startsWith(WEB_ROOT)) {
        res.writeHead(403);
        res.end("forbidden");
        return;
      }
      fs.readFile(target, (err, buf) => {
        if (err) {
          res.writeHead(404, { "cache-control": "no-store" });
          res.end("not found");
          return;
        }
        res.writeHead(200, {
          "content-type": MIME[path.extname(target).toLowerCase()] || "application/octet-stream",
          "content-length": buf.length,
          "cache-control": "no-store",
        });
        res.end(buf);
      });
    };

    const snapshot = () => {
      const now = Date.now();
      const pending = [...state.approvals.values()].map((a) => ({
        id: a.id,
        kind: "approval",
        session_id: a.sessionId,
        session_title: a.sessionTitle,
        risk: a.risk,
        summary: a.summary,
        command: a.command,
        reason: a.reason,
        tool: a.toolName,
        expires_at: null,
        requested_at: a.requestedAt,
      }));
      const sessions = [...state.sessions.values()]
        .filter((rec) => now - rec.lastActivityAt < 6 * 60 * 60 * 1000)
        .map((rec) => ({
          id: rec.id,
          title: rec.title,
          state: rec.state,
          action: rec.action,
          progress: rec.progress,
          unread: rec.unread,
          pending: pending
            .filter((p) => p.session_id === rec.id)
            .map((p) => ({ kind: "approval", id: p.id }))
            .concat(
              [...state.questions.values()]
                .filter((q) => q.sessionId === rec.id)
                .map((q) => ({ kind: "question", id: q.id }))
            ),
          last_activity_at: rec.lastActivityAt,
        }));
      const questions = [...state.questions.values()].map((q) => ({
        id: q.id,
        kind: "question",
        session_id: q.sessionId,
        session_title: q.sessionTitle,
        questions: q.questions,
        requested_at: q.requestedAt,
      }));
      return {
        api_version: "v1",
        generated_at: now,
        connection: "online",
        sessions,
        counts: {
          pending: pending.length + questions.length,
          unread: sessions.reduce((n, s) => n + s.unread, 0),
        },
        pending,
        // 提问：带选项的待回答问题，浮窗里直接点选项就回，不用切回主界面
        questions,
        // 用量：今日花费 / 每个会话花费 / DeepSeek 余额（余额有 60 秒缓存，拿不到就带 error）
        usage: usage.snapshot(),
      };
    };

    const readBody = (req, limit = 64 * 1024) =>
      new Promise((resolve, reject) => {
        let size = 0;
        const chunks = [];
        req.on("data", (c) => {
          size += c.length;
          if (size > limit) reject(new Error("payload too large"));
          else chunks.push(c);
        });
        req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        req.on("error", reject);
      });

    // 截图提问：拿到 SessionController 就能把「图片 + 文字」直接投进会话
  // （PromptContentPart 支持内联 base64 image，不需要额外上传服务）
  root.inject(["sessionController"], (sctx) => {
    const controller = sctx.sessionController;
    state.sessionController = controller;
    sctx.effect(() => () => {
      if (state.sessionController === controller) state.sessionController = null;
    });
  });

  root.inject(["webServer"], (ctx) => {
      const routes = [
        ["/xj/app.html", (req, res) => serveFile(res, "/app.html")],
        ["/xj/inject.js", (req, res) => serveFile(res, "/inject.js")],
        ["/xj/embed.js", (req, res) => serveFile(res, "/embed.js")],
        ["/xj/embed.css", (req, res) => serveFile(res, "/embed.css")],
        [
          "/xj/state",
          (req, res) => {
            const denied = security(req);
            if (denied) {
              res.writeHead(denied);
              res.end("denied");
              return;
            }
            state.lastWidgetPing = Date.now();
            usage.maybeRefreshBalance();
            json(res, 200, snapshot());
          },
        ],
        [
          "/xj/usage",
          async (req, res) => {
            if (security(req)) {
              res.writeHead(403);
              res.end("denied");
              return;
            }
            // POST = 面板上的「刷新余额」：等这一趟问完再回，前端好显示转圈
            if (req.method === "POST") {
              json(res, 200, await usage.refreshNow());
              return;
            }
            usage.maybeRefreshBalance();
            json(res, 200, usage.snapshot());
          },
        ],
        [
          "/xj/decide",
          async (req, res) => {
            if (req.method !== "POST") {
              json(res, 405, { error: "method_not_allowed" });
              return;
            }
            if (security(req)) {
              json(res, 403, { error: "forbidden" });
              return;
            }
            if (!/^application\/json/i.test(String(req.headers["content-type"] || ""))) {
              json(res, 415, { error: "unsupported_media_type" });
              return;
            }
            let body;
            try {
              body = JSON.parse(await readBody(req));
            } catch {
              json(res, 400, { error: "bad_json" });
              return;
            }
            const entry = state.approvals.get(String(body && body.id));
            if (!entry) {
              json(res, 409, { error: "already_decided" });
              return;
            }
            const decision = body && body.decision === "deny" ? "deny" : "allow";
            const outcome = decision === "deny" ? "rejected" : "allowed-once";
            const resolve = entry.resolve;
            state.approvals.delete(entry.id);
            touch();
            if (typeof resolve === "function") resolve(outcome);
            process.stderr.write(`ojingjing: approval ${entry.id} ${outcome}\n`);
            json(res, 200, { ok: true, outcome });
          },
        ],
        [
          "/xj/answer",
          async (req, res) => {
            if (req.method !== "POST") {
              json(res, 405, { error: "method_not_allowed" });
              return;
            }
            if (security(req)) {
              json(res, 403, { error: "forbidden" });
              return;
            }
            if (!/^application\/json/i.test(String(req.headers["content-type"] || ""))) {
              json(res, 415, { error: "unsupported_media_type" });
              return;
            }
            let body;
            try {
              body = JSON.parse(await readBody(req, 256 * 1024));
            } catch (err) {
              const tooLarge = String((err && err.message) || "").includes("payload too large");
              json(res, tooLarge ? 413 : 400, { error: tooLarge ? "payload_too_large" : "bad_json" });
              return;
            }
            const entry = state.questions.get(String(body && body.id));
            if (!entry) {
              json(res, 409, { error: "already_answered" });
              return;
            }
            // 两种载荷都收：整批 { answers: [...] }，或者单问的 { selected, custom }
            const list = Array.isArray(body && body.answers) ? body.answers : null;
            const answers = entry.questions.map((q) => {
              const hit = list ? list.find((a) => a && String(a.id) === q.id) : entry.questions.length === 1 ? body : null;
              if (!hit) return { id: q.id, selected: [] };
              const raw = hit.selected;
              const selected = (Array.isArray(raw) ? raw : raw == null ? [] : [raw])
                .map((s) => String(s))
                .filter((s) => s && q.options.some((o) => o.label === s));
              const custom = typeof hit.custom === "string" ? hit.custom.trim().slice(0, 2000) : "";
              // 单选题里 custom 会覆盖选中项（DSH 的约定），多选时它只是补充说明
              if (custom && !q.multiSelect) return { id: q.id, selected: [], custom };
              return custom ? { id: q.id, selected, custom } : { id: q.id, selected };
            });
            const resolve = entry.resolve;
            state.questions.delete(entry.id);
            touch();
            if (typeof resolve === "function") resolve(answers);
            process.stderr.write(`ojingjing: question ${entry.id} answered\n`);
            json(res, 200, { ok: true, answers });
          },
        ],
        [
          "/xj/prompt",
          async (req, res) => {
            if (req.method !== "POST") {
              json(res, 405, { error: "method_not_allowed" });
              return;
            }
            if (security(req)) {
              json(res, 403, { error: "forbidden" });
              return;
            }
            if (!/^application\/json/i.test(String(req.headers["content-type"] || ""))) {
              json(res, 415, { error: "unsupported_media_type" });
              return;
            }
            const controller = state.sessionController;
            if (!controller || typeof controller.prompt !== "function") {
              json(res, 503, { error: "prompt_unavailable" });
              return;
            }
            let body;
            try {
              // 截图走 base64，1.5MB 很常见，别用 64KB 的默认上限
              body = JSON.parse(await readBody(req, 40 * 1024 * 1024));
            } catch (err) {
              const tooLarge = String((err && err.message) || "").includes("payload too large");
              json(res, tooLarge ? 413 : 400, { error: tooLarge ? "payload_too_large" : "bad_json" });
              return;
            }
            const sessionId = String((body && body.sessionId) || "").trim();
            if (!sessionId) {
              json(res, 422, { error: "missing_session" });
              return;
            }
            const content = [];
            const image = body && body.image;
            if (image && image.data) {
              const mediaType = String(image.mediaType || "image/png").toLowerCase();
              if (!IMAGE_MEDIA_TYPES.has(mediaType)) {
                json(res, 415, { error: "unsupported_image_type" });
                return;
              }
              if (String(image.data).length > MAX_IMAGE_BASE64) {
                json(res, 413, { error: "image_too_large" });
                return;
              }
              content.push({
                type: "image",
                mediaType,
                data: String(image.data),
                ...(image.name ? { name: String(image.name) } : {}),
              });
            }
            const text = body && typeof body.text === "string" ? body.text : "";
            if (text.trim()) content.push({ type: "text", text });
            if (!content.length) {
              json(res, 422, { error: "empty_prompt" });
              return;
            }

            const requestId = "xj_" + randomUUID();
            const ac = new AbortController();
            try {
              await controller.prompt(
                {
                  requestId,
                  sessionId,
                  mode: body && body.mode === "steer" ? "steer" : "queue",
                  content,
                },
                ac.signal
              );
              process.stderr.write(`ojingjing: prompt ${sessionId} ${requestId}\n`);
              json(res, 200, { ok: true, requestId });
            } catch (err) {
              const code = Number(err && (err.status || err.statusCode || err.code));
              const known = [400, 404, 409, 413, 415, 422, 503].includes(code) ? code : 502;
              json(res, known, {
                error: "prompt_failed",
                detail: String((err && err.message) || err || ""),
              });
            }
          },
        ],
      ];

      for (const [p, handler] of routes) {
        ctx.effect(
          () =>
            ctx.webServer.register({
              kind: "exact",
              path: p,
              handler,
            }),
          `ojingjing: route ${p}`
        );
      }

      // 静态资源：/xj/static/<相对 web 根>
      ctx.effect(
        () =>
          ctx.webServer.register({
            kind: "prefix",
            path: "/xj/static",
            handler: (req, res) => {
              const url = String(req.url || "");
              const rel = decodeURIComponent(url.split("?")[0].replace(/^\/xj\/static/, ""));
              if (rel.includes("..")) {
                res.writeHead(403);
                res.end("forbidden");
                return;
              }
              // /xj/static/src/app.js → <web>/static/src/app.js
              serveFile(res, "/static" + rel);
            },
          }),
        "ojingjing: static"
      );

      ctx.logger.info("ojingjing overlay: routes ready at /xj/");
    });

    // 页面内注入开关：默认关闭。
    // 独立桌面窗（standalone/）只需要 /xj/* 数据接口，不需要往 DSH 页面里塞浮层；
    // 想恢复「页面内那版」，把它改成 true 并重启 DSH 客户端。
    const INJECT_IN_PAGE = false;

    if (INJECT_IN_PAGE) {
      // 页面注入：桌面端唯一通道是结构化行；web 形态另有 tapIndex。
      root.on("webserver/index-inject", (table) => {
        try {
          if (!Array.isArray(table)) return;
          const exists = table.some(
            (row) => row && row.kind === "script" && typeof row.text === "string" && row.text.includes("/xj/inject.js")
          );
          if (exists) return;
          table.push({
            kind: "script",
            placement: "body",
            text:
              "(function(){try{var d=document.body||document.documentElement;if(!d)return;" +
              'var s=document.createElement("script");s.src="/xj/inject.js";s.async=true;' +
              "s.onerror=function(){};d.appendChild(s)}catch(e){}})()",
          });
        } catch {}
      });
    }

    // 跟独立窗联动：DSH 起来时，如果哦鲸鲸没在跑就把它拉起来。
    // 配置由 tools/install-plugin.mjs 写到 ~/.dsh/ojingjing-shell.json（autoLaunch:false 可关）。
    launchShellIfNeeded(root);
  },
};

// 方便单测：tools/test-shell-launch.mjs 直接调它验证「DSH 起来 → 哦鲸鲸起来」
export { launchShellIfNeeded };
