/* 验证滚轮缓动：找到真正的滚动容器，在它中心发滚轮，采样 scrollTop 是否逐帧逼近 */
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { connect, launchChrome, sleep } from "./cdp.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 9347;

const chrome = launchChrome(PORT, { prefix: "xj-w4-" });
const { send, close } = await connect(PORT);

const evalJs = async (expr) => {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true });
  if (r.result?.exceptionDetails) console.log("eval error:", r.result.exceptionDetails.text);
  return r.result?.result?.value;
};

await send("Page.enable");
await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
await send("Page.navigate", {
  url: "file:///" + join(ROOT, "app", "index.html").replace(/\\/g, "/") + "?t=" + Date.now() + "#demo=panel",
});
for (let i = 0; i < 40; i++) {
  await sleep(120);
  if (await evalJs("!!(window.XJ && XJ.state && XJ.state.store.state.connection)")) break;
}
await sleep(600);

const found = await evalJs(`(() => {
  const out = [];
  document.querySelectorAll('*').forEach((el) => {
    const s = getComputedStyle(el);
    if (/(auto|scroll)/.test(s.overflowY) && el.scrollHeight - el.clientHeight > 4) {
      const r = el.getBoundingClientRect();
      out.push({ cls: el.className || el.tagName, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), sh: el.scrollHeight, ch: el.clientHeight });
    }
  });
  return JSON.stringify(out);
})()`);
console.log("可滚动容器:", found);
const list = JSON.parse(found);
if (!list.length) {
  console.log("没有可滚动容器，换场景");
  process.exit(1);
}
const box = list[0];

await evalJs(`(() => {
  const el = [...document.querySelectorAll('*')].find((e) => {
    const s = getComputedStyle(e);
    return /(auto|scroll)/.test(s.overflowY) && e.scrollHeight - e.clientHeight > 4;
  });
  window.__sc = el;
  el.scrollTop = 0;
  window.__samples = [];
  const loop = () => { window.__samples.push(Math.round(el.scrollTop)); if (window.__sampling) requestAnimationFrame(loop); };
  window.__sampling = true;
  requestAnimationFrame(loop);
  return true;
})()`);

await send("Input.dispatchMouseEvent", { type: "mouseWheel", x: box.x, y: box.y, deltaX: 0, deltaY: 120, pointerType: "mouse" });
await sleep(40);
await send("Input.dispatchMouseEvent", { type: "mouseWheel", x: box.x, y: box.y, deltaX: 0, deltaY: 120, pointerType: "mouse" });
await sleep(800);

const samples = JSON.parse(await evalJs("(() => { window.__sampling = false; return JSON.stringify(window.__samples); })()"));
console.log("目标容器:", box.cls, "scrollTop 采样:", samples.join(" → "));
const distinct = new Set(samples).size;
console.log("不同值个数 =", distinct, distinct > 3 ? "（有缓动过程 ✅）" : "（一步到位或没动 ❌）");

await send("Browser.close").catch(() => {});
close();
chrome.close();
process.exit(0);
