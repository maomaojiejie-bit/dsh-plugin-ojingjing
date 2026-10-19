/* =============================================================================
   tools/dev/scroll-probe.mjs · 量面板滚动时的帧间隔（怀疑是 mask / 模糊把主线程压住）
   用法：node tools/dev/scroll-probe.mjs
   说明：headless Chrome 关掉 GPU，尽量接近 Qt 外壳的软件光栅路径；
        先用「旧做法」= 给滚动容器加回 mask-image，再测「新做法」= 现在的 CSS。
   输出：每种做法的 fps / 中位 / p95 / 超过 32ms 的帧数
   结论（2026-10-18 实测）：**没用**。headless 里三种做法的帧间隔都是 16.7ms / 0 掉帧，
   说明它的 rAF 只是跟着 vsync 走，并不反映窗口侧的真实重绘；要判断滚动是否顺，
   只能在真机（Qt 外壳）里看，或者看 QtWebEngineProcess 的 CPU 占用。
   ========================================================================== */
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORT = 9339;
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

const launch = () => {
  const profile = mkdtempSync(join(tmpdir(), "xj-scroll-"));
  return spawn(
    CHROME,
    [
      "--headless=new",
      "--disable-gpu",
      "--disable-gpu-compositing",
      "--disable-accelerated-2d-canvas",
      "--hide-scrollbars",
      "--no-first-run",
      "--disable-features=Translate",
      "--force-device-scale-factor=1",
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${profile}`,
      "--window-size=1440,900",
      "about:blank",
    ],
    { stdio: "ignore" }
  );
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitTarget(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === "page");
      if (page?.webSocketDebuggerUrl) return page;
    } catch {}
    await sleep(200);
  }
  throw new Error("CDP 超时");
}

function connect(url) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(url);
    const pending = new Map();
    let seq = 0;
    ws.addEventListener("open", () => {
      const send = (method, params = {}) =>
        new Promise((resolveP) => {
          const id = ++seq;
          pending.set(id, resolveP);
          ws.send(JSON.stringify({ id, method, params }));
        });
      ws.addEventListener("message", (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.id && pending.has(msg.id)) {
          pending.get(msg.id)(msg);
          pending.delete(msg.id);
        }
      });
      res({ send });
    });
    ws.addEventListener("error", rej);
  });
}

/** 注入采样：rAF 记帧间隔；同时由外面持续发滚轮事件 */
const START_SAMPLER = `(() => {
  window.__xjFrames = [];
  let last = performance.now();
  const loop = (t) => { window.__xjFrames.push(t - last); last = t; if (window.__xjSampling) requestAnimationFrame(loop); };
  window.__xjSampling = true;
  requestAnimationFrame(loop);
  return true;
})()`;

async function measure(send, label, prepare) {
  // 每次都在干净文档上跑，避免上一轮残渣
  const url = "file:///" + join(ROOT, "app", "index.html").replace(/\\/g, "/") + "?t=" + Date.now() + "#demo=panel";
  await send("Page.navigate", { url });
  for (let i = 0; i < 40; i++) {
    await sleep(120);
    const r = await send("Runtime.evaluate", {
      expression: "!!(window.XJ && XJ.state && XJ.state.store.state.connection)",
      returnByValue: true,
    });
    if (r.result?.result?.value) break;
  }
  await sleep(500);
  await send("Runtime.evaluate", { expression: "document.documentElement.classList.add('xj-sw')" });
  if (prepare) await send("Runtime.evaluate", { expression: prepare });
  await sleep(200);
  await send("Runtime.evaluate", { expression: START_SAMPLER });

  // 12 次滚轮，间隔 24ms，模拟快速滑动
  for (let i = 0; i < 12; i++) {
    await send("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x: 1180,
      y: 520,
      deltaX: 0,
      deltaY: -240,
      pointerType: "mouse",
    });
    await sleep(24);
  }
  await sleep(400);
  const r = await send("Runtime.evaluate", {
    expression: `(() => {
      window.__xjSampling = false;
      const f = window.__xjFrames.slice(2);
      const sorted = [...f].sort((a, b) => a - b);
      const pick = (p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
      return JSON.stringify({
        frames: f.length,
        avg: +(f.reduce((a, b) => a + b, 0) / f.length).toFixed(1),
        median: +pick(0.5).toFixed(1),
        p95: +pick(0.95).toFixed(1),
        max: +sorted[sorted.length - 1].toFixed(1),
        over32: f.filter((x) => x > 32).length,
        over50: f.filter((x) => x > 50).length,
      });
    })()`,
    returnByValue: true,
  });
  const data = JSON.parse(r.result.result.value);
  console.log("\n" + label);
  console.log(
    "  frames=" + data.frames + " avg=" + data.avg + "ms median=" + data.median + "ms p95=" + data.p95 + "ms max=" + data.max + "ms"
  );
  console.log("  掉帧（>32ms）=" + data.over32 + "  >50ms=" + data.over50);
  return data;
}

async function main() {
  const proc = launch();
  const target = await waitTarget();
  const { send } = await connect(target.webSocketDebuggerUrl);
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

  // A：旧做法 —— 滚动容器加 mask-image（滚动时整层每帧重新栅格化）
  await measure(
    send,
    "A 旧：mask-image 淡出",
    `(() => {
      const s = document.createElement('style');
      s.textContent = '.panel > .scroll { -webkit-mask-image: linear-gradient(to bottom, #000 calc(100% - 18px), transparent 100%); mask-image: linear-gradient(to bottom, #000 calc(100% - 18px), transparent 100%); } .panel > .scroll::after { display: none; }';
      document.head.appendChild(s);
      return true;
    })()`
  );

  // B：新做法 —— 去掉 mask，靠 sticky 渐变
  await measure(send, "B 新：去 mask + sticky 渐变", "true");

  // C：再把输入区上沿的模糊投影加回来，看那一条 18px 的模糊带值多少
  await measure(
    send,
    "C 新做法 + 输入区模糊投影",
    `(() => {
      const s = document.createElement('style');
      s.textContent = '.composer-zone { box-shadow: 0 -12px 18px -14px rgba(8,13,26,.75) !important; background-image: none !important; }';
      document.head.appendChild(s);
      return true;
    })()`
  );

  await send("Browser.close").catch(() => {});
  proc.kill();
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
