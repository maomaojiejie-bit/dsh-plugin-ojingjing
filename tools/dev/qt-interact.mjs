// 在 QtWebEngine 页面里做真实鼠标交互：node tools/qt-interact.mjs <port>
// 步骤：收起 → 悬停鲸鱼（等气泡）→ 单击（切气泡）→ 点「展开面板」→ 收起
import { writeFile } from "node:fs/promises";

const port = process.argv[2] || "9223";
const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = list.find((t) => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
ws.addEventListener("message", (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
});
const send = (method, params = {}) =>
  new Promise((resolve) => {
    const myId = ++id;
    pending.set(myId, resolve);
    ws.send(JSON.stringify({ id: myId, method, params }));
  });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const evalJs = async (expr) => {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  return r.result?.result?.value;
};

await new Promise((r) => (ws.readyState === WebSocket.OPEN ? r() : ws.addEventListener("open", r, { once: true })));
await send("Runtime.enable");
await send("Input.setIgnoreInputEvents", { ignore: false }).catch(() => {});

const state = async (label) => {
  const s = await evalJs(
    `JSON.stringify({ form: XJ.state.store.state.ui.form, screen: XJ.state.store.state.ui.panelScreen, w: innerWidth, h: innerHeight })`,
  );
  console.log(label, s);
};

const move = (x, y) => send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none", buttons: 0 });
const click = async (x, y) => {
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
  await wait(60);
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 });
};

await evalJs("XJ.app.collapse()");
await wait(500);
await state("collapsed");

// 鲸鱼中心（收起态窗口 108×108，右侧 10 / 下侧 10 的 64px 圆）
const ox = 108 - 10 - 32;
const oy = 108 - 10 - 32;
await move(ox, oy);
await wait(600);
await state("after-hover");

await click(ox, oy);
await wait(700);
await state("after-click");

// 面板里的「展开面板」按钮：用 JS 找它的中心再点，更稳
const pt = await evalJs(`(() => {
  const b = Array.from(document.querySelectorAll('button')).find((x) => (x.textContent || '').includes('展开面板'));
  if (!b) return null;
  const r = b.getBoundingClientRect();
  return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) });
})()`);
console.log("expand-button", pt);
if (pt) {
  const { x, y } = JSON.parse(pt);
  await click(x, y);
  await wait(900);
  await state("after-expand");
}

const shot = await send("Page.captureScreenshot", { format: "png" });
if (shot.result?.data) {
  const out = new URL("../../.shots/qt-interact.png", import.meta.url);
  await writeFile(out, Buffer.from(shot.result.data, "base64"));
  console.log("screenshot ->", out.pathname);
}
ws.close();
