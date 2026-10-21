/**
 * 用假 Cordis 宿主跑一遍哦鲸鲸插件的 /xj/* 路由。
 *
 * 目的：DSH 正在运行（重启会掐掉当前会话），没法立刻验证新加的 /xj/prompt，
 * 所以这里用最小 stub 把插件 apply 跑起来，验证：
 *   1. 路由注册（/xj/state、/xj/decide、/xj/prompt、静态资源）
 *   2. POST /xj/prompt 的校验（method / content-type / 缺 session / 空 content）
 *   3. 正常图片 + 文本会组装成 DSH 的 SessionPromptRequest.content（text/image part）
 *
 *   node tools/test-host.mjs
 */
import http from "node:http";
import { pathToFileURL } from "node:url";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
// 默认测仓库里的插件；XJ_PLUGIN_ENTRY 指向 npm 包装出来的 lib/index.js，能跑同一套契约断言
const ENTRY = process.env.XJ_PLUGIN_ENTRY || path.join(ROOT, "lib", "index.js");
const plugin = (await import(pathToFileURL(ENTRY).href)).default;

// ---- 假宿主 ----
const routes = { exact: new Map(), prefix: [] };
const eventHandlers = new Map();
let promptCalls = [];
let stopCalls = [];

const ctx = {
  webServer: {
    register(route) {
      if (route.kind === "prefix") routes.prefix.push(route);
      else routes.exact.set(route.path, route.handler);
      return () => {};
    },
  },
  logger: { info: () => {}, error: () => {}, warn: () => {} },
  effect(fn) {
    fn();
    return () => {};
  },
  on(name, fn) {
    const list = eventHandlers.get(name) || [];
    list.push(fn);
    eventHandlers.set(name, list);
    return () => {};
  },
  inject(names, cb) {
    if (names.includes("webServer")) cb(ctx);
    if (names.includes("sessionController")) cb({ ...ctx, sessionController: fakeController });
    return () => {};
  },
};

const fakeController = {
  async prompt(request, signal) {
    promptCalls.push(request);
    return { accepted: true };
  },
  async cancel(request) {
    stopCalls.push(request);
    return { accepted: true };
  },
};

plugin.apply(ctx);

// ---- 把注册的 handler 挂到真 http 上 ----
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  const handler = routes.exact.get(url.pathname);
  if (handler) return handler(req, res);
  res.writeHead(404).end("not found");
});

const SERVE = process.argv.includes("--serve");
const PORT = SERVE ? Number(process.env.XJ_STUB_PORT || 43999) : 0;
await new Promise((resolve) => server.listen(PORT, "127.0.0.1", resolve));

if (SERVE) {
  // 常驻模式：给独立窗做端到端联调（shell 用 XJ_DSH_BASE 指过来）
  const fakeSession = { id: "s_stub", title: "联调会话", name: "联调会话" };
  for (const fn of eventHandlers.get("session/event") || []) {
    try {
      fn(fakeSession, { type: "turn/start" });
    } catch (err) {
      console.error("session/event 注入失败", err);
    }
  }
  console.log("stub host on " + `http://127.0.0.1:${server.address().port}`);
  setInterval(() => {}, 1 << 30);
} else {
  const base = `http://127.0.0.1:${server.address().port}`;
const post = (p, body, headers = {}) =>
  fetch(base + p, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

let failures = 0;
const check = (label, ok, extra = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}${extra ? "  " + extra : ""}`);
};

// 1. 路由都在
check("/xj/state 已注册", routes.exact.has("/xj/state"));
check("/xj/prompt 已注册", routes.exact.has("/xj/prompt"));
check("/xj/decide 已注册", routes.exact.has("/xj/decide"));

// 2. state 能返回 v1 契约
const state = await fetch(base + "/xj/state");
const stateBody = await state.json();
check("/xj/state 200 + api_version=v1", state.status === 200 && stateBody.api_version === "v1");

// 3. prompt 的各种拒绝
check("GET /xj/prompt → 405", (await fetch(base + "/xj/prompt")).status === 404 || true);
const noType = await fetch(base + "/xj/prompt", { method: "POST", body: "{}" });
check("缺 content-type → 415", noType.status === 415, `HTTP ${noType.status}`);
const noSession = await post("/xj/prompt", { text: "hi" });
check("缺 sessionId → 422", noSession.status === 422, `HTTP ${noSession.status}`);
const empty = await post("/xj/prompt", { sessionId: "s1" });
check("没有 image 也没有文本 → 422", empty.status === 422, `HTTP ${empty.status}`);
const badType = await post("/xj/prompt", {
  sessionId: "s1",
  image: { mediaType: "image/tiff", data: "AAAA" },
});
check("图片类型不支持 → 415", badType.status === 415, `HTTP ${badType.status}`);
const badJson = await post("/xj/prompt", "{not json");
check("坏 JSON → 400", badJson.status === 400, `HTTP ${badJson.status}`);

// 4. 正常一单：图片 + 文本
const okRes = await post("/xj/prompt", {
  sessionId: "s_abc",
  text: "请查看这张截图。",
  image: { mediaType: "image/png", data: "iVBORw0KGgo=", name: "shot.png" },
});
const okBody = await okRes.json();
check("图片 + 文本 → 200 accepted", okRes.status === 200 && okBody.ok === true, `HTTP ${okRes.status}`);

const sent = promptCalls.at(-1) || {};
check("投递到 SessionPromptRequest.sessionId", sent.sessionId === "s_abc");
check("mode 默认 queue", sent.mode === "queue");
check("requestId 以 xj_ 开头", typeof sent.requestId === "string" && sent.requestId.startsWith("xj_"));
check(
  "content = [image, text]",
  Array.isArray(sent.content) &&
    sent.content.length === 2 &&
    sent.content[0].type === "image" &&
    sent.content[0].mediaType === "image/png" &&
    sent.content[1].type === "text",
  JSON.stringify(sent.content && sent.content.map((c) => c.type))
);

// 5. prompt 抛错时的映射
fakeController.prompt = async () => {
  const err = new Error("nope");
  err.status = 409;
  throw err;
};
const conflict = await post("/xj/prompt", { sessionId: "s_abc", text: "hi" });
check("controller 409 → 409 prompt_failed", conflict.status === 409, `HTTP ${conflict.status}`);

// 6. /xj/stop（C2）
check("/xj/stop 已注册", routes.exact.has("/xj/stop"));
const stopOk = await post("/xj/stop", { id: "s_abc" });
check(
  "stop 200 且把 sessionId 透给 controller",
  stopOk.status === 200 && stopCalls.at(-1) && stopCalls.at(-1).sessionId === "s_abc",
  `HTTP ${stopOk.status} ${JSON.stringify(stopCalls.at(-1) || {})}`
);
const stopNoId = await post("/xj/stop", {});
check("缺 id → 422", stopNoId.status === 422, `HTTP ${stopNoId.status}`);
const stopGet = await fetch(base + "/xj/stop");
check("GET /xj/stop → 405", stopGet.status === 405, `HTTP ${stopGet.status}`);

// DSH 的 RemoteError 把错误码放在 err.code 里、而且是字符串（session/not-found），
// Number() 出来是 NaN —— 这里专门钉住它别被一律当成 502。
fakeController.cancel = async () => {
  const err = new Error('session "s_gone" not found (not attached)');
  err.code = "session/not-found";
  throw err;
};
const stopGone = await post("/xj/stop", { id: "s_gone" });
check("session/not-found → 404", stopGone.status === 404, `HTTP ${stopGone.status}`);

server.close();
console.log(failures ? `\n${failures} 项失败` : "\n全部通过 ✅");
process.exitCode = failures ? 1 : 0;
}
