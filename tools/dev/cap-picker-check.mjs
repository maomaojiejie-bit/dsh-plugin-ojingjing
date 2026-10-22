// 截图提问 · 目标会话选择器回归（§9.2 发送卡）
// 真实鼠标走完整链路：拖选 → 完成 → 开选择器 → 换目标 → Esc 收浮层 →
// 选「新会话」→ 发送 → 进 composer → 面板里真发出去（验证走 newSession 分支）。
// 用法：node tools/dev/cap-picker-check.mjs
import { writeFile } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { launchChrome, connect, sleep } from "./cdp.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const APP = pathToFileURL(join(ROOT, "app", "index.html")).href;
const PORT = 9471;

const shots = mkdtempSync(join(tmpdir(), "xj-cap-picker-"));
let shotN = 0;

const chrome = launchChrome(PORT, { url: "about:blank", width: 1280, height: 860, prefix: "xj-cap-picker" });
try {
  const { send, close } = await connect(PORT, { timeoutMs: 20000 });
  await send("Runtime.enable");
  await send("Page.enable");
  // 字体样式表是 parser-blocking：网络不通时整个 body 脚本都执行不了。
  // 屏蔽掉让它快速失败（页面自带 Microsoft YaHei 回落，不影响交互验证）。
  await send("Network.enable");
  await send("Network.setBlockedURLs", { urls: ["*fonts.googleapis.com*", "*fonts.gstatic.com*"] });

  async function evalJs(expression) {
    const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) throw new Error("JS 异常: " + JSON.stringify(r.result.exceptionDetails).slice(0, 300));
    return r.result?.result?.value;
  }
  async function shot(name) {
    const r = await send("Page.captureScreenshot", { format: "png" });
    const p = join(shots, String(++shotN).padStart(2, "0") + "-" + name + ".png");
    if (r.result?.data) await writeFile(p, Buffer.from(r.result.data, "base64"));
    return p;
  }
  async function mouse(type, x, y, extra = {}) {
    await send("Input.dispatchMouseEvent", { type, x, y, button: type === "mouseReleased" ? "left" : "left", buttons: type === "mouseReleased" ? 0 : 1, clickCount: 1, ...extra });
  }
  const pass = [];
  const fail = [];
  const check = (name, cond) => (cond ? pass.push(name) : fail.push(name));

  await send("Page.navigate", { url: APP });
  // 轮询等页面就绪（冷启动时 20 个脚本 + file:// 读取没那么快，死等容易抢跑）
  let boot = null;
  for (let i = 0; i < 50; i++) {
    await sleep(200);
    boot = await evalJs(`window.XJ && XJ.state.store.state ? JSON.stringify({ errs: window.__xjErrors || [], sessions: XJ.state.store.state.sessions.map(s => s.id + ":" + s.title) }) : null`);
    if (boot) break;
  }
  if (!boot) {
    const dbg = await evalJs(`JSON.stringify({ href: location.href, ready: document.readyState, scripts: document.scripts.length, xj: !!window.XJ, store: !!(window.XJ && XJ.state && XJ.state.store && XJ.state.store.state) })`);
    throw new Error("页面 10 秒没就绪；当前状态: " + dbg);
  }
  const bootInfo = JSON.parse(boot);
  check("页面无脚本异常", bootInfo.errs.length === 0);
  check("mock 4 个会话就位", bootInfo.sessions.length === 4);
  console.log("boot:", boot);

  /* 1. 拖选一块区域 */
  await evalJs(`XJ.app.startCapture(); 'ok'`);
  await sleep(120);
  await mouse("mousePressed", 420, 320);
  for (let i = 1; i <= 6; i++) await mouse("mouseMoved", 420 + i * 55, 320 + i * 38);
  await mouse("mouseReleased", 775, 548);
  await sleep(150);
  check("工具条出现（editing）", await evalJs(`!!document.querySelector('.capture-tools')`));
  check("选区尺寸牌就位", await evalJs(`(document.querySelector('.sel-size')||{}).textContent || ''`).then((t) => /\d+ × \d+/.test(t)));

  /* 2. 点「完成」→ 发送卡 */
  await evalJs(`([...document.querySelectorAll('.capture-tools button')].find(b => (b.title||'').includes('完成')) || {}).click?.(); 'ok'`);
  await sleep(200);
  check("发送卡出现", await evalJs(`!!document.querySelector('.cap-confirm')`));
  const cardShot = await shot("confirm-card");
  console.log("截图:", cardShot);

  /* 3. 开选择器 */
  await evalJs(`document.querySelector('.cap-target').click(); 'ok'`);
  await sleep(180);
  check("选择器浮层出现", await evalJs(`!!document.querySelector('.cap-picker')`));
  const pickerShot = await shot("picker-open");
  console.log("截图:", pickerShot);

  const rows = await evalJs(`[...document.querySelectorAll('.xj-pick-row')].map(r => ({ text: r.textContent.replace(/\\s+/g,' ').trim(), on: r.classList.contains('on') }))`);
  console.log("选择器行:", JSON.stringify(rows, null, 1));
  check("行数 = 会话 + 新会话", rows.length === 5);
  check("第一行是新会话", rows[0].text.includes("新会话"));
  check("默认勾的是当前目标（s_auth）", rows.find((r) => r.on)?.text.includes("重构 auth"));
  check("行里有状态 pill", await evalJs(`!!document.querySelector('.xj-pick-row .pill')`));
  check("新会话行有副标题", rows[0].text.includes("自动建"));

  /* 4. 换到「给登录页补 3 个单测」 */
  await evalJs(`[...document.querySelectorAll('.xj-pick-row')].find(r => r.textContent.includes('给登录页')).click(); 'ok'`);
  await sleep(250);
  check("选完浮层收起", await evalJs(`!document.querySelector('.cap-picker')`));
  check("composer 目标切到 s_test", await evalJs(`XJ.state.store.state.composer.targetSessionId`) === "s_test");
  check("pill 文案更新", (await evalJs(`document.querySelector('.cap-target').textContent`)).includes("给登录页"));
  const afterPickShot = await shot("after-pick");
  console.log("截图:", afterPickShot);

  /* 5. Esc 先收浮层（不退出确认卡） */
  await evalJs(`document.querySelector('.cap-target').click(); 'ok'`);
  await sleep(200);
  check("浮层重新打开", await evalJs(`!!document.querySelector('.cap-picker')`));
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
  await sleep(250);
  check("Esc 只收浮层", await evalJs(`!document.querySelector('.cap-picker') && !!document.querySelector('.cap-confirm')`));

  /* 6. 选「新会话」→ 发送 → 面板 composer → 真发 */
  await evalJs(`document.querySelector('.cap-target').click(); 'ok'`);
  await sleep(200);
  await evalJs(`[...document.querySelectorAll('.xj-pick-row')].find(r => r.textContent.includes('新会话')).click(); 'ok'`);
  await sleep(250);
  check("新会话：targetSessionId 是哨兵", await evalJs(`XJ.state.store.state.composer.targetSessionId === XJ.state.NEW_SESSION`));
  check("新会话：resolveTargetSession 为 null", await evalJs(`XJ.state.resolveTargetSession(XJ.state.store.state) === null`));
  check("新会话：pill 显示「新会话」", (await evalJs(`document.querySelector('.cap-target').textContent`)).includes("新会话"));
  const freshShot = await shot("fresh-target");
  console.log("截图:", freshShot);

  await evalJs(`document.querySelector('.cap-q').value = '这个报错是什么意思'; document.querySelector('.cap-q').dispatchEvent(new Event('input')); 'ok'`);
  await evalJs(`[...document.querySelectorAll('.cap-actions button')].find(b => b.textContent.includes('发送')).click(); 'ok'`);
  await sleep(300);
  check("截图进了 composer 附件", await evalJs(`XJ.state.store.state.composer.attachments.length`) === 1);
  check("问题文字带进草稿", (await evalJs(`XJ.state.store.state.composer.text`)).includes("报错"));
  check("自动切到面板形态", await evalJs(`XJ.state.store.state.ui.form`) === "panel");

  /* 7. 面板里点发送 → 走 newSession 分支 */
  await sleep(200);
  await evalJs(`(document.querySelector('[data-focus="composer"]').closest('.composer-box').querySelector('.btn-solid') || {}).click?.(); 'ok'`);
  await sleep(1600);
  const after = await evalJs(`JSON.stringify({ n: XJ.state.store.state.sessions.length, first: XJ.state.store.state.sessions[0], target: XJ.state.store.state.composer.targetSessionId })`);
  const afterInfo = JSON.parse(after);
  console.log("发送后:", JSON.stringify({ n: afterInfo.n, firstTitle: afterInfo.first?.title, firstActive: afterInfo.first?.active }));
  check("新会话真的建出来了（5 个）", afterInfo.n === 5);
  check("新会话排在最前且 active", afterInfo.first?.active === true && afterInfo.first?.title.includes("报错"));
  const sentShot = await shot("after-send");
  console.log("截图:", sentShot);

  close();
  chrome.close();

  console.log("\n===== 结果 =====");
  pass.forEach((p) => console.log("  ok   " + p));
  fail.forEach((f) => console.log("  FAIL " + f));
  console.log(fail.length ? `\n${fail.length} 项未过 ❌` : "\n全部通过 ✅");
  console.log("截图目录:", shots);
  process.exit(fail.length ? 1 : 0);
} catch (e) {
  console.error("运行失败:", e);
  chrome.close();
  process.exit(1);
}
