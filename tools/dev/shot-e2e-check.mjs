// 截图提问 · 独立窗端到端回归（真外壳，不是 stub）
// 起一个多会话 mock DSH → 起真 exe → 页面触发截图 → 外壳抓屏推卡片 →
// 开选择器 → 换目标 → 发送 → 校验 mock 收到的 /xj/prompt 带着用户挑的 sessionId。
// 用法：node tools/dev/shot-e2e-check.mjs
import http from "node:http";
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, readFile } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, extname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { launchChrome, connect, sleep } from "./cdp.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const EXE = join(ROOT, "dist", "Ojingjing-CS", "Ojingjing.exe");
const WEB = join(ROOT, "web");
const MOCK_PORT = 43188;
const CDP_PORT = 43199;

const shots = mkdtempSync(join(tmpdir(), "xj-shot-e2e-"));
let shotN = 0;

/* ---------------- 设置文件：把端口临时指向 mock，跑完还原 ----------------
   不杀 DSH（老大可能在用）：exe 启动时先信 settings.Port，指到 mock 就留在 mock 上。
   正在跑的那个哦鲸鲸实例不会重读文件（端口没变就不会写回），互不干扰。
   配置目录有两处候选：正常在 %APPDATA%\ojingjing\，沙箱里会退化到 exe 旁边的 data\，
   两处都改，哪处被用到都能指到 mock。 */
const SETTINGS_PATHS = [
  join(process.env.APPDATA || "", "ojingjing", "settings.json"),
  join(ROOT, "dist", "Ojingjing-CS", "data", "settings.json"),
];
const settingsBackup = {};
for (const p of SETTINGS_PATHS) {
  if (existsSync(p)) {
    // exe 目录那份可能带 BOM（PowerShell/宿主写的），JSON.parse 前剥掉
    const raw0 = readFileSync(p, "utf8").replace(/^\uFEFF/, "");
    settingsBackup[p] = raw0;
    const cfg = JSON.parse(raw0);
    cfg.port = MOCK_PORT;
    writeFileSync(p, JSON.stringify(cfg, null, 2), "utf8");
    console.log("端口临时指向 " + MOCK_PORT + "：" + p);
  }
}

/* ---------------- mock DSH：4 个会话 + /xj/prompt 记账 ---------------- */
const SESSIONS = [
  { id: "s_work", title: "重构歌词解析器", state: "working", action: "正在编辑 parser.ts", progress: 40, unread: false, lastActivityAt: Date.now() - 30000 },
  { id: "s_done", title: "给登录页补单测", state: "idle", action: "已完成", progress: 100, unread: true, lastActivityAt: Date.now() - 120000 },
  { id: "s_idle", title: "整理依赖许可证", state: "idle", action: "已完成", progress: 100, unread: false, lastActivityAt: Date.now() - 600000 },
  { id: "s_old", title: "旧会话：写周报", state: "idle", action: "已完成", progress: 100, unread: false, lastActivityAt: Date.now() - 3600000 },
];
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".json": "application/json",
};
const prompts = [];
const mock = http.createServer((req, res) => {  const u = new URL(req.url, "http://127.0.0.1");
  if (u.pathname === "/xj/state") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ api_version: "v1", sessions: SESSIONS, pending: [], questions: [], usage: { today: 0 } }));
    return;
  }
  if (u.pathname === "/xj/prompt" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let parsed = {};
      try {
        parsed = JSON.parse(body);
      } catch {}
      prompts.push({ sessionId: parsed.sessionId, text: parsed.text, hasImage: !!(parsed.image && parsed.image.data), at: Date.now() });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, requestId: "xj_test" }));
    });
    return;
  }
  if (u.pathname.startsWith("/xj/")) {
    // 其它 /xj/* 一律当插件静态资源：剥前缀从 web/ 读（外壳 ProbePage 要这个）
    const f = join(WEB, u.pathname.slice(3));
    if (!f.startsWith(WEB) || !existsSync(f)) {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    readFile(f, (err, buf) => {
      if (err) {
        res.writeHead(404);
        res.end("not found");
        return;
      }
      res.writeHead(200, { "content-type": MIME[extname(f).toLowerCase()] || "application/octet-stream", "cache-control": "no-store" });
      res.end(buf);
    });
    return;
  }
  res.writeHead(404);
  res.end("not found");
});

const pass = [];
const fail = [];
const check = (name, cond) => (cond ? pass.push(name) : fail.push(name));

let exe = null;
try {
  await new Promise((r) => mock.listen(MOCK_PORT, "127.0.0.1", r));
  console.log("mock DSH on " + MOCK_PORT);

  // 单实例 mutex：开跑前清场（老大自启的那个由调用方负责在测试后拉起，
  // 测试期间任何 Ojingjing 进程都应该是我的，直接杀干净）
  spawn("taskkill", ["/IM", "Ojingjing.exe", "/F"], { stdio: "ignore" });
  await sleep(800);

  exe = spawn(EXE, [], {
    env: { ...process.env, XJ_DEBUG_PORT: String(CDP_PORT), XJ_NO_SELECT: "1" },
    stdio: "ignore",
    windowsHide: false,
  });
  console.log("exe pid " + exe.pid);

  const { send, close } = await connect(CDP_PORT, { timeoutMs: 30000 });
  await send("Runtime.enable");
  await send("Page.enable");

  async function evalJs(expression) {
    const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) throw new Error("JS 异常: " + JSON.stringify(r.result.exceptionDetails).slice(0, 400));
    return r.result?.result?.value;
  }
  async function shot(name) {
    const r = await send("Page.captureScreenshot", { format: "png" });
    const p = join(shots, String(++shotN).padStart(2, "0") + "-" + name + ".png");
    if (r.result?.data) await writeFile(p, Buffer.from(r.result.data, "base64"));
    return p;
  }

  /* 1. 等 exe 发现 mock 并切到服务器页，页面拿到 4 个会话 */
  let ready = false;
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    const st = await evalJs(`(() => { try { return JSON.stringify({ href: location.href, n: (window.XJ && XJ.state.store.state ? XJ.state.store.state.sessions.length : -1), conn: window.XJ && XJ.state.store.state ? XJ.state.store.state.connection : "?" }); } catch (e) { return "ERR " + e.message; } })()`);
    if (i % 4 === 0) console.log("  等待页面就绪:", st);
    if (st && st.includes('"n":4')) {
      ready = true;
      break;
    }
  }
  if (!ready) throw new Error("exe 60 秒没连上 mock（端口发现或导航失败）");
  check("exe 发现 mock 并拿到 4 个会话", true);
  console.log("页面就绪");

  /* 2. 触发截图（页面 → 外壳 → 抓屏 → 推卡片） */
  await evalJs(`XJ.app.startCapture(); 'ok'`);
  let card = false;
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    if (await evalJs(`!!document.querySelector(".form-shot")`)) {
      card = true;
      break;
    }
  }
  check("外壳抓屏后弹出截图提问卡", card);
  if (!card) throw new Error("截图卡没出来（外壳抓屏链路断了）");
  await sleep(300);
  console.log("截图:", await shot("e2e-card"));

  /* 3. 默认目标 = 外壳自动挑的（working 优先 → s_work） */
  const pill0 = await evalJs(`document.querySelector(".shot-target").textContent`);
  console.log("默认 pill:", pill0.trim());
  check("pill 默认显示外壳挑的干活中的会话", pill0.includes("重构歌词解析器"));

  /* 4. 开选择器 → 换到 s_idle */
  await evalJs(`document.querySelector(".shot-target").click(); 'ok'`);
  await sleep(250);
  check("选择器展开", await evalJs(`!!document.querySelector(".shot-pick")`));
  const rows = await evalJs(`[...document.querySelectorAll(".xj-pick-row")].map(r => r.textContent.replace(/\\s+/g," ").trim())`);
  console.log("选择器行:", JSON.stringify(rows));
  check("选择器列出全部 4 个会话", rows.length === 4);
  console.log("截图:", await shot("e2e-picker"));

  await evalJs(`[...document.querySelectorAll(".xj-pick-row")].find(r => r.textContent.includes("整理依赖许可证")).click(); 'ok'`);
  await sleep(250);
  const pill1 = await evalJs(`document.querySelector(".shot-target").textContent`);
  check("换目标后 pill 更新", pill1.includes("整理依赖许可证"));
  check("选完选择器收起", await evalJs(`!document.querySelector(".shot-pick")`));

  /* 5. 填问题 → 发送 */
  await evalJs(`
    var ta = document.querySelector(".shot-input");
    ta.value = "这个依赖冲突怎么解";
    ta.dispatchEvent(new Event("input"));
    'ok'`);
  await evalJs(`[...document.querySelectorAll(".shot-actions button")].find(b => b.textContent.includes("发送")).click(); 'ok'`);

  /* 6. 等 mock 收到 prompt，校验 sessionId 是用户挑的 */
  let got = null;
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    if (prompts.length) {
      got = prompts[prompts.length - 1];
      break;
    }
  }
  console.log("mock 收到的 prompt:", JSON.stringify(got));
  check("mock 收到了 /xj/prompt", !!got);
  check("带着用户挑中的 sessionId（s_idle）", !!got && got.sessionId === "s_idle");
  check("带着问题文字", !!got && got.text === "这个依赖冲突怎么解");
  check("带着截图（base64 图片）", !!got && got.hasImage === true);

  /* 7. 外壳回执后卡片收掉 */
  let gone = false;
  for (let i = 0; i < 20; i++) {
    await sleep(250);
    if (!(await evalJs(`!!document.querySelector(".form-shot")`))) {
      gone = true;
      break;
    }
  }
  check("发送成功后卡片收起", gone);
  console.log("截图:", await shot("e2e-after"));

  close();
} catch (e) {
  console.error("运行失败:", e);
  fail.push("运行异常: " + (e && e.message));
} finally {
  // 收尸：先礼后兵，杀完再确认一次（单实例 mutex 下，残留一个下次就全跑不了）
  try {
    if (exe) exe.kill();
  } catch {}
  try {
    if (exe && exe.pid) spawn("taskkill", ["/PID", String(exe.pid), "/F", "/T"], { stdio: "ignore" });
  } catch {}
  await sleep(600);
  try {
    spawn("taskkill", ["/IM", "Ojingjing.exe", "/F"], { stdio: "ignore" });
  } catch {}
  for (const [p, raw] of Object.entries(settingsBackup)) {
    try {
      writeFileSync(p, raw, "utf8");
      console.log("已还原：" + p);
    } catch (e) {
      console.error("还原失败，请手动把 port 改回 43120：" + p);
    }
  }
  mock.close();
}

console.log("\n===== 结果 =====");
pass.forEach((p) => console.log("  ok   " + p));
fail.forEach((f) => console.log("  FAIL " + f));
console.log(fail.length ? `\n${fail.length} 项未过 ❌` : "\n全部通过 ✅");
console.log("截图目录:", shots);
process.exit(fail.length ? 1 : 0);
