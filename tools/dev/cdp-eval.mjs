// 探查任意 CDP 页面：node tools/dev/cdp-eval.mjs <port> "<js expression>" [--shot out.png]
// 用途：外壳（WebView2）或插件页面加载异常时，看它到底停在什么状态、报了什么错。
import { writeFile } from "node:fs/promises";

import { connect } from "./cdp.mjs";

const port = process.argv[2] || "9223";
const expr = process.argv[3] || "document.title";
const shotIdx = process.argv.indexOf("--shot");
const shotPath = shotIdx > 0 ? process.argv[shotIdx + 1] : null;

const { send, events, close } = await connect(port);
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
close();
