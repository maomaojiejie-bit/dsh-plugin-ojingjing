// 量独立窗的帧率：node tools/dev/fps-probe.mjs [port] [seconds]
// 需要外壳带 --remote-debugging-port=<port> 启动（QTWEBENGINE_CHROMIUM_FLAGS）。
import { connect } from "./cdp.mjs";

const port = process.argv[2] || "9223";
const secs = Number(process.argv[3] || 3);

const { send, close } = await connect(port);
await send("Runtime.enable");

const expr = `(async () => {
  const t = []; let last = performance.now();
  await new Promise((done) => {
    const stop = performance.now() + ${secs * 1000};
    const tick = (now) => { t.push(now - last); last = now; now < stop ? requestAnimationFrame(tick) : done(); };
    requestAnimationFrame(tick);
  });
  t.shift();
  const s = [...t].sort((a, b) => a - b);
  const p = (q) => s[Math.min(s.length - 1, Math.floor(s.length * q))];
  return JSON.stringify({
    frames: t.length,
    fps: +(1000 / (t.reduce((a, b) => a + b, 0) / t.length)).toFixed(1),
    median_ms: +p(0.5).toFixed(1),
    p95_ms: +p(0.95).toFixed(1),
    max_ms: +Math.max(...t).toFixed(1),
    over_32ms: t.filter((v) => v > 32).length,
    over_50ms: t.filter((v) => v > 50).length,
    form: window.XJ?.state?.store?.state?.ui?.form ?? null,
    size: [innerWidth, innerHeight],
  });
})()`;

const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
console.log(r.result?.result?.value ?? JSON.stringify(r));
close();
