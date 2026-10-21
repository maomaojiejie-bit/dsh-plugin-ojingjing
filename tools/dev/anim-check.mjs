/* §24 动画增强批回归探针：node tools/dev/anim-check.mjs
   覆盖：视线跟随（眼球 + 头像脸双结构）· alert 瞪眼与跟随叠加 · 光环戴上 ·
        点击 Q 弹 · 苏醒/入睡 · 重连恢复 · reduce-motion 降级 · 静息暂停。
   跑完打 20 个断言，全过退出码 0，有失败 exit 1。
   环境备忘（都是实测踩过的坑，改这个文件前先读）：
   - 必须用 fs.readFile（callback 版）serve 文件：fs/promises 的 readFile 在沙箱里
     会既不回调也不报错地挂起，表现为「页面永远加载不完」。
   - Page.navigate 不能 await：页面引 Google Fonts，沙箱连不通 → load 事件不来 →
     navigate 永不返回。要拉黑字体域 + 不 await + 轮询 boot。
   - CDP Input.dispatchMouseEvent 的 pointerup 在 headless Chrome 的这个页面上会被吞
     （对照实验证实，与产品无关——QtWebEngine/真实浏览器没这问题）。Q 弹用页面内
     合成 PointerEvent 验，照样走完整处理器链路和 CSS 竞争。
   - 视口大小以 innerWidth/innerHeight 为准：--window-size 在 headless 下不一定生效。
   - reduce-motion 的降级断言走真设置（patchSettings({motion:'reduce'})）：render()
     按 settings 重置 body class，手搓 class 会被 mock tick 的 render 摘掉。 */
import fs from "node:fs";
import { createServer } from "node:http";
import { join, resolve, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { launchChrome, connect } from "./cdp.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const WEB = join(ROOT, "web");
const PORT_HTTP = 43131;
const PORT_CDP = 9356;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = createServer((req, res) => {
  const rel = req.url.split("?")[0];
  const p = rel.startsWith("/xj/") ? join(WEB, rel.slice(4)) : rel === "/" ? join(WEB, "app.html") : join(WEB, rel);
  fs.readFile(p, (err, buf) => {
    if (err) {
      res.writeHead(404);
      res.end("nope");
      return;
    }
    const mime = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".webp": "image/webp" };
    res.writeHead(200, { "content-type": mime[extname(p)] || "application/octet-stream" });
    res.end(buf);
  });
});
await new Promise((r) => server.listen(PORT_HTTP, "127.0.0.1", r));

const chrome = launchChrome(PORT_CDP, { url: "about:blank", w: 520, h: 700 });
const { send, close } = await connect(PORT_CDP, { timeoutMs: 12000 });
const evalJs = async (expr) => {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result && r.result.exceptionDetails) throw new Error("页面异常: " + JSON.stringify(r.result.exceptionDetails));
  return r.result && r.result.result ? r.result.result.value : undefined;
};
const mouse = (type, x, y) =>
  send("Input.dispatchMouseEvent", {
    type,
    x,
    y,
    // button 用 "none" 而不是 "undefined"：后者不是合法枚举值，Chrome 会静默丢弃事件
    button: type === "mousePressed" ? "left" : "none",
    buttons: type === "mousePressed" ? 1 : 0,
    clickCount: 1,
  });

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log((ok ? "  ✓ " : "  ✗ ") + name + (detail ? " — " + detail : ""));
};
// 过渡动画是一次性的，固定 sleep 采样偶尔会整段错过（render 时机抖动）——
// 轮询整个动画窗口，见到目标动画名即算过
const pollAnim = async (sel, want, fromMs, toMs) => {
  for (let t = fromMs; t <= toMs; t += 50) {
    await sleep(50);
    const a = await evalJs(`(() => { const w = document.querySelector('${sel}');
      return w ? getComputedStyle(w).animationName : 'no-whale'; })()`);
    if (a === want) return a;
  }
  return await evalJs(`(() => { const w = document.querySelector('${sel}');
    return w ? getComputedStyle(w).animationName : 'no-whale'; })()`);
};

try {
  await send("Page.enable");
  await send("Network.enable");
  await send("Network.setBlockedURLs", { urls: ["*fonts.googleapis.com*", "*fonts.gstatic.com*"] });
  send("Page.navigate", { url: `http://127.0.0.1:${PORT_HTTP}/xj/app.html?embed=1` }).catch(() => {});
  let booted = false;
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    if (await evalJs("!!(window.XJ && XJ.state && XJ.state.store.state)")) {
      booted = true;
      break;
    }
  }
  check("页面 boot", booted);
  if (!booted) throw new Error("页面没起来");

  // 造一个 alert 态（有待办、非睡非离线，眼球才跟）
  await evalJs(`XJ.state.actions.approvalRequested({
    id: "ap_probe", sessionId: "s_auth", risk: "danger",
    summary: "探针用待办", command: "echo hi", impact: "无", expiresAt: Date.now() + 600000 })`);
  await sleep(300);
  check("进入 alert 态", (await evalJs("!!document.querySelector('.whale.st-alert')")) === true);

  /* ---- 视线跟随 ---- */
  // 视口实际大小以页面为准（--window-size 在 headless 下不一定生效，实测 1424x805）
  const vp = JSON.parse(await evalJs("JSON.stringify({w: innerWidth, h: innerHeight})"));
  // 默认是角色头像版：先测「整脸轻转」（--face-x/y）
  const faceBox = JSON.parse(
    await evalJs(`(() => { const r = document.querySelector('.whale-av .whale-face').getBoundingClientRect();
      return JSON.stringify({x: r.left + r.width/2, y: r.top + r.height/2}); })()`)
  );
  await mouse("mouseMoved", vp.w - 6, 8);
  await sleep(400);
  const fx1 = await evalJs("getComputedStyle(document.querySelector('.whale-av .whale-face')).getPropertyValue('--face-x')");
  const fy1 = await evalJs("getComputedStyle(document.querySelector('.whale-av .whale-face')).getPropertyValue('--face-y')");
  // 脸在右下角、鼠标在右上：水平只差 30 多 px、竖直差 750，归一化后 dx 接近 0 是数学正确，
  // 所以这里只要求「方向对」（dx≥0、dy 明显向上），不要求大幅水平偏移
  check("头像脸朝右上", parseFloat(fx1) >= 0 && parseFloat(fy1) < -0.3, `x=${fx1} y=${fy1}`);
  const fAmp = await evalJs(`(() => { const v = getComputedStyle(document.querySelector('.whale-av .whale-face'));
    return Math.max(Math.abs(parseFloat(v.getPropertyValue('--face-x'))), Math.abs(parseFloat(v.getPropertyValue('--face-y')))); })()`);
  check("脸部幅度有界（≤0.7px）", fAmp <= 0.7001, "max=" + fAmp.toFixed(3));
  await mouse("mouseMoved", 6, vp.h - 6);
  await sleep(400);
  const fx2 = await evalJs("getComputedStyle(document.querySelector('.whale-av .whale-face')).getPropertyValue('--face-x')");
  check("脸随指针转向左下", parseFloat(fx2) < -0.1, "x=" + fx2);

  // 切回 SVG 几何版测眼球（--eye-x/y）
  await evalJs("XJ.avatarData = ''; XJ.state.store.emit()");
  await sleep(300);
  const eyeOk = await evalJs("!!document.querySelector('.whale .eye-open')");
  check("几何版眼球节点在", eyeOk === true);

  // 眼球跟随：右上 → 左下，方向要对、幅度要 ≤1.2（viewBox 单位）
  await mouse("mouseMoved", vp.w - 6, 8);
  await sleep(400);
  const ex1 = await evalJs("getComputedStyle(document.querySelector('.whale .eye-open')).getPropertyValue('--eye-x')");
  const ey1 = await evalJs("getComputedStyle(document.querySelector('.whale .eye-open')).getPropertyValue('--eye-y')");
  check("眼球朝右上", parseFloat(ex1) >= 0 && parseFloat(ey1) < -0.3, `x=${ex1} y=${ey1}`);
  await mouse("mouseMoved", 6, vp.h - 6);
  await sleep(400);
  const ex2 = await evalJs("getComputedStyle(document.querySelector('.whale .eye-open')).getPropertyValue('--eye-x')");
  const ey2 = await evalJs("getComputedStyle(document.querySelector('.whale .eye-open')).getPropertyValue('--eye-y')");
  // 眼球在 (1382,763)、鼠标在左下 (6,799)：竖直只差 36px，dy≈0 是数学正确，只验水平主导
  check("眼球朝左下", parseFloat(ex2) < -0.3, `x=${ex2} y=${ey2}`);
  const amp = await evalJs(`(() => { const v = getComputedStyle(document.querySelector('.whale .eye-open'));
    return Math.max(Math.abs(parseFloat(v.getPropertyValue('--eye-x'))), Math.abs(parseFloat(v.getPropertyValue('--eye-y')))); })()`);
  check("眼球幅度有界（≤1.2 单位）", amp <= 1.2001, "max=" + amp.toFixed(3));
  // 关键回归：alert 瞪眼的 scale 必须在独立 scale 属性上（1.18），且跟随的 transform 同时有效
  const alertEye = await evalJs(`(() => { const v = getComputedStyle(document.querySelector('.whale .eye-open'));
    return JSON.stringify({t: v.transform, s: v.scale}); })()`);
  const ae = JSON.parse(alertEye);
  check("alert 瞪眼与跟随叠加", /1\.18/.test(ae.s) && ae.t !== "none", `scale=${ae.s} transform=${ae.t}`);

  /* ---- 光环戴上 ---- */
  const auraAnim = await evalJs("getComputedStyle(document.querySelector('.aura.show')).animationName");
  check("光环戴上动画", auraAnim === "auraIn", auraAnim);

  /* ---- Q 弹 ---- */
  // 用页面内合成 PointerEvent，不走 CDP Input：headless Chrome 的 CDP 鼠标事件
  // 在这个页面上 pointerup 会被吞（对照实验证实，与产品无关——QtWebEngine/真实
  // 浏览器里没有这个问题）。合成事件照样走 orbPointerDown → onUp → handleOrbTap
  // → tap → squashOrb 的完整链路，CSS 竞争（orbArm vs orbTap）也照样测到。
  await evalJs(`(async () => {
    const orb = document.querySelector('.orb');
    const r = orb.getBoundingClientRect();
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    const mk = (type) => new PointerEvent(type, { bubbles: true, cancelable: true, button: 0, buttons: type === 'pointerdown' ? 1 : 0, clientX: x, clientY: y, pointerId: 1, isPrimary: true });
    orb.dispatchEvent(mk('pointerdown'));
    await new Promise((res) => setTimeout(res, 60));
    document.dispatchEvent(mk('pointerup'));
    await new Promise((res) => setTimeout(res, 60));
    return 'ok';
  })()`);
  await sleep(320); // 有待办时 tap 延迟 260ms + orbTap 420ms，此时正在播
  const tapCls = await evalJs("!!document.querySelector('.orb.xj-tap')");
  const tapAnim = await evalJs(`document.querySelector('.orb') ? getComputedStyle(document.querySelector('.orb')).animationName : 'no-orb'`);
  check("点击 Q 弹触发", tapCls || tapAnim === "orbTap", `class=${tapCls} anim=${tapAnim}`);

  /* ---- 苏醒 / 入睡 ---- */
  await evalJs('XJ.state.actions.setConnection("offline")');
  // 轮询整个 320ms 窗口（whaleDoze）；等太久会回到常驻 whaleBreath
  const doze = await pollAnim(".orb .whale", "whaleDoze", 50, 320);
  check("入睡垂头", doze === "whaleDoze", doze);
  await evalJs('XJ.state.actions.setConnection("online")');
  // whaleWake 700ms，窗口取 50..600ms
  const wake = await pollAnim(".orb .whale", "whaleWake", 50, 600);
  check("苏醒弹入", wake === "whaleWake", wake);
  const offlineGone = await evalJs("!document.querySelector('.orb.is-offline')");
  check("重连态 orb class 清理", offlineGone === true);
  await evalJs("XJ.state.actions.setConnection('reconnecting')");
  await sleep(150);
  const reconnOk = await evalJs("!!document.querySelector('.orb.is-reconnecting')");
  check("重连态 orb class 出现", reconnOk === true);
  await evalJs('XJ.state.actions.setConnection("online")');
  const wake2 = await pollAnim(".orb .whale", "whaleWake", 50, 600);
  check("重连恢复也苏醒（闸门不被拦）", wake2 === "whaleWake", wake2);

  /* ---- reduce-motion 降级 ---- */
  // 走真设置而不是手搓 class：render() 按 settings 重置 body class（产品行为），
  // 手搓的 class 会被 mock tick（2.6s）的 render 摘掉，断言有时序竞争
  await evalJs("XJ.state.actions.patchSettings({ motion: 'reduce' })");
  await sleep(150);
  await mouse("mouseMoved", vp.w - 6, 8);
  await sleep(350);
  const rmEye = await evalJs(`(() => { const v = getComputedStyle(document.querySelector('.whale .eye-open'));
    return v.transitionProperty + '|' + v.getPropertyValue('--eye-x'); })()`);
  check("reduce-motion 眼球停跟", rmEye.startsWith("none|"), rmEye);
  // Q 弹降级：手动挂 class（点击链路会换形态，这里只验 CSS 规则本身）
  await evalJs("document.querySelector('.orb').classList.add('xj-tap')");
  await sleep(80);
  const rmTap = await evalJs("getComputedStyle(document.querySelector('.orb')).animationName");
  check("reduce-motion 免 Q 弹", rmTap === "none", rmTap);
  await evalJs("document.querySelector('.orb').classList.remove('xj-tap')");
  await evalJs("XJ.state.actions.patchSettings({ motion: 'normal' })");
  await sleep(150);

  /* ---- 静息：CSS 暂停装饰动画 ---- */
  await evalJs("document.body.classList.add('xj-calm')");
  await sleep(80);
  const calmPause = await evalJs(`(() => { const v = getComputedStyle(document.querySelector('.aura'));
    return v.animationPlayState; })()`);
  check("静息暂停装饰动画", calmPause === "paused", calmPause);
  await evalJs("document.body.classList.remove('xj-calm')");
} catch (e) {
  check("探针执行异常", false, e.message);
} finally {
  close();
  chrome.close();
  server.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n===== ${results.length - failed.length}/${results.length} 通过 =====`);
process.exit(failed.length ? 1 : 0);
