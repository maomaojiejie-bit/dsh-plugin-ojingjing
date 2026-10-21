/**
 * 探测「真的装在 DSH 里」的页面：直接打开宿主提供的 /xj/app.html?embed=1，
 * 收集控制台错误 + 断言 XJ 初始化 + 截图。
 *
 *   node tools/probe-embed.mjs             # 默认 http://127.0.0.1:43120
 *   node tools/probe-embed.mjs --port 1234
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { connect, launchChrome, sleep } from "./cdp.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SHOTS = join(ROOT, ".shots");
const PORT_CDP = 9339;
const W = 520;
const H = 700;

const args = process.argv.slice(2);
const i = args.indexOf("--port");
const HOST_PORT = i >= 0 ? Number(args[i + 1]) : 43120;
const URL_ = `http://127.0.0.1:${HOST_PORT}/xj/app.html?embed=1`;

mkdirSync(SHOTS, { recursive: true });

const W_ = W;
const H_ = H;
const DPR = 1;
const WIN_W = W_ * DPR;
const WIN_H = H_ * DPR;

const chrome = launchChrome(PORT_CDP, { width: WIN_W, height: WIN_H, extraFlags: ["--no-sandbox"], prefix: "xj-embed-" });

const { send, events, close } = await connect(PORT_CDP);

await send("Page.enable");
await send("Runtime.enable");
await send("Log.enable");
await send("Emulation.setDeviceMetricsOverride", {
  width: W_,
  height: H_,
  deviceScaleFactor: DPR,
  mobile: false,
});

await send("Page.navigate", { url: URL_ });

let state = null;
for (let n = 0; n < 60; n++) {
  await sleep(200);
  const r = await send("Runtime.evaluate", {
    expression: `(() => {
      const ready = !!(window.XJ && XJ.app && XJ.state && XJ.state.store.state.connection);
      const s = ready ? XJ.state.store.state : null;
      return JSON.stringify({
        ready,
        embed: !!(window.XJ && XJ.embed && XJ.embed.enabled),
        harness: !!(window.__XJ_EMBED_HARNESS__),
        sessions: s ? s.sessions.length : -1,
        pending: s ? Object.keys(s.approvals || {}).length : -1,
        form: s ? s.ui.form : "",
        errors: (window.__xjErrors || []).slice(-4),
        bodyClass: document.body.className,
        composerDisplay: (() => { const el = document.querySelector('.composer-zone'); return el ? getComputedStyle(el).display : 'none-node'; })(),
        embedCssLoaded: [...document.styleSheets].some((s) => (s.href || '').includes('embed.css')),
        stage: document.getElementById('xj-stage') ? document.getElementById('xj-stage').getBoundingClientRect().toJSON() : null,
      });
    })()`,
    returnByValue: true,
  });
  const val = r.result && r.result.result && r.result.result.value;
  if (val) {
    state = JSON.parse(val);
    if (state.ready) break;
  }
}

const consoleErrors = events
  .filter((e) => e.method === "Runtime.exceptionThrown" || (e.method === "Runtime.consoleAPICalled" && e.params.type === "error"))
  .map((e) =>
    e.method === "Runtime.exceptionThrown"
      ? e.params.exceptionDetails.text + " " + (e.params.exceptionDetails.exception && e.params.exceptionDetails.exception.description || "")
      : (e.params.args || []).map((a) => a.value || a.description || "").join(" ")
  )
  .slice(-6);

// --form panel|bubble|quickbar：截一张对应形态的图
const formArg = args.indexOf("--form");
const form = formArg >= 0 ? args[formArg + 1] : "collapsed";
if (form !== "collapsed") {
  const expr =
    form === "panel"
      ? "XJ.app.openPanel()"
      : form === "bubble"
        ? "XJ.state.actions.setForm('bubble')"
        : "XJ.app.openQuickbar()";
  await send("Runtime.evaluate", { expression: expr, returnByValue: true });
  await sleep(600);
  const formInfo = await send("Runtime.evaluate", {
    expression: `JSON.stringify({
      quickbar: !!document.querySelector('.quickbar'),
      panel: !!document.querySelector('.panel'),
      composer: (() => { const el = document.querySelector('.composer-zone'); return el ? getComputedStyle(el).display : 'no-composer'; })(),
      density: document.body.classList.contains('density'),
      stageH: document.getElementById('xj-stage').getBoundingClientRect().height,
    })`,
    returnByValue: true,
  });
  console.log("form:", formInfo.result && formInfo.result.result ? formInfo.result.result.value : "?");
}

console.log("URL:", URL_);
console.log("state:", JSON.stringify(state, null, 2));
if (consoleErrors.length) console.log("console errors:\n" + consoleErrors.join("\n"));

const shot = await send("Page.captureScreenshot", { format: "png", fromSurface: true });
const out = join(SHOTS, "embed-live.png");
writeFileSync(out, Buffer.from(shot.result.data, "base64"));
console.log("截图 →", out);

close();
chrome.close();
process.exit(state && state.ready && !consoleErrors.length ? 0 : 2);
