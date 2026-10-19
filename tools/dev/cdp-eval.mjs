// 探查任意 CDP 页面：node tools/cdp-eval.mjs <port> "<js expression>" [--shot out.png]
// 用途：PySide6 的 QtWebEngine 窗口里页面加载失败时，看它到底停在什么状态。
import { writeFile } from "node:fs/promises";

const port = process.argv[2] || "9223";
const expr = process.argv[3] || "document.title";
const shotIdx = process.argv.indexOf("--shot");
const shotPath = shotIdx > 0 ? process.argv[shotIdx + 1] : null;

const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = list.find((t) => t.type === "page");
if (!page) {
  console.error("no page target");
  process.exit(1);
}

const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const events = [];

ws.addEventListener("message", (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  } else if (msg.method) {
    events.push(msg);
  }
});

function send(method, params = {}) {
  return new Promise((resolve) => {
    const myId = ++id;
    pending.set(myId, resolve);
    ws.send(JSON.stringify({ id: myId, method, params }));
  });
}

await new Promise((resolve) => {
  if (ws.readyState === WebSocket.OPEN) resolve();
  else ws.addEventListener("open", resolve, { once: true });
});
await send("Runtime.enable");
await send("Log.enable");
await send("Network.enable");
await new Promise((r) => setTimeout(r, 1200));

const res = await send("Runtime.evaluate", {
  expression: `(() => { try { return JSON.stringify({ href: location.href, ready: document.readyState, title: document.title, bodyLen: (document.body && document.body.innerHTML.length) || 0, xj: !!(window.XJ && window.XJ.state), native: !!(window.xjNative), text: (document.body && document.body.innerText || '').slice(0, 200) }); } catch (e) { return 'ERR ' + e.message; } })()`,
  returnByValue: true,
  awaitPromise: false,
});
console.log("state:", res.result?.result?.value ?? JSON.stringify(res.result));

const probe = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
console.log("expr:", JSON.stringify(probe.result?.result?.value ?? probe.result));

const bad = events
  .filter((e) => e.method === "Log.entryAdded" || e.method === "Network.loadingFailed")
  .slice(-12)
  .map((e) => (e.method === "Log.entryAdded" ? `${e.params.entry.level}: ${e.params.entry.text}` : `loadingFailed ${e.params.errorText} ${e.params.blockedReason || ""}`));
console.log("events:", bad.length ? bad : "(none)");

if (shotPath) {
  const shot = await send("Page.captureScreenshot", { format: "png" });
  const data = shot.result?.data;
  if (data) {
    await writeFile(shotPath, Buffer.from(data, "base64"));
    console.log("screenshot ->", shotPath);
  } else {
    console.log("screenshot failed", JSON.stringify(shot));
  }
}
ws.close();
