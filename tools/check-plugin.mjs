/**
 * 自检：哦鲸鲸插件是否已经被 DSH 加载。
 *
 *   node tools/check-plugin.mjs              # 默认探测 43120
 *   node tools/check-plugin.mjs --port 1234
 *
 * 判据（前三项必须全部满足）：
 *   1. GET  /xj/inject.js  200   → 路由注册成功，插件 apply 跑过了
 *   2. GET  /xj/app.html   200   → 静态产物在
 *   3. GET  /xj/state      200 JSON（api_version=v1） → 数据通路通
 *
 * 第四项「页面注入」默认关闭（INJECT_IN_PAGE=false，独立桌面窗只需要 /xj/*），
 * 所以 GET / 返回 401（DSH 要求渲染器专用请求头）属于正常，仅作提示、不计入失败。
 */
const args = process.argv.slice(2);
const portArg = args.indexOf("--port");
const PORT = portArg >= 0 ? Number(args[portArg + 1]) : 43120;
const BASE = `http://127.0.0.1:${PORT}`;

const results = [];

async function probe(label, pathname, check, { soft = false } = {}) {
  try {
    const res = await fetch(BASE + pathname, { cache: "no-store", headers: { connection: "close" } });
    const text = await res.text();
    const ok = res.ok && (check ? check(text, res) : true);
    results.push({ label, ok: ok || soft, soft: soft && !ok, detail: `HTTP ${res.status}` });
    return { ok, text, res };
  } catch (err) {
    results.push({ label, ok: false, detail: String(err && err.message) });
    return { ok: false, text: "" };
  }
}

const inject = await probe("路由 /xj/inject.js", "/xj/inject.js", (t) => t.includes("__XJ_OVERLAY_HOSTED__"));
await probe("页面 /xj/app.html", "/xj/app.html", (t) => t.includes("xj-stage"));
const state = await probe("/xj/state", "/xj/state", (t) => {
  try {
    return JSON.parse(t).api_version === "v1";
  } catch {
    return false;
  }
});
// 注入默认关：401/不含脚本都算正常，只提示
const index = await probe("页面注入（默认关闭，仅提示）", "/", (t) => t.includes("/xj/inject.js"), { soft: true });

if (state.ok) {
  try {
    const data = JSON.parse(state.text);
    const sessions = data.sessions || [];
    const pending = data.pending || [];
    console.log(`会话 ${sessions.length} 个，待确认 ${pending.length} 项`);
  } catch {}
}

for (const r of results) {
  const tag = r.soft ? "hint" : r.ok ? "ok  " : "FAIL";
  console.log(`${tag}  ${r.label}  ${r.detail}`);
}

if (index.ok) {
  console.log("提示：注入已出现在页面 HTML 里（说明 INJECT_IN_PAGE 被改回了 true）。");
} else {
  console.log("提示：页面内注入是关闭的；独立桌面窗不受影响，它直接读 /xj/state。");
}

const allOk = results.every((r) => r.ok);
console.log(allOk ? "\n插件已加载 ✅" : "\n还没装好/没重启，见 PLUGIN.md");
// 显式关掉 keep-alive 连接再退出，避免 Node 24 在 Windows 上触发 libuv 断言
process.exitCode = allOk ? 0 : 2;
setTimeout(() => process.exit(process.exitCode), 50).unref();
