// 截图提问卡 · 目标会话选择器回归（独立窗专用，app/src/shot.js）
// 模拟外壳：把 XJ.embed.host 改成 app、post 换成收集器，然后：
// 开卡 → 默认目标 → 开内联选择器 → 换会话 → 发送 → 校验发给外壳的载荷。
// 用法：node tools/dev/shot-picker-check.mjs
import { writeFile } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { launchChrome, connect, sleep } from "./cdp.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const APP = pathToFileURL(join(ROOT, "app", "index.html")).href;
const PORT = 9473;

const shots = mkdtempSync(join(tmpdir(), "xj-shot-picker-"));
let shotN = 0;

const chrome = launchChrome(PORT, { url: "about:blank", width: 1280, height: 860, prefix: "xj-shot-picker" });
try {
  const { send, close } = await connect(PORT, { timeoutMs: 20000 });
  await send("Runtime.enable");
  await send("Page.enable");
  await send("Network.enable");
  await send("Network.setBlockedURLs", { urls: ["*fonts.googleapis.com*", "*fonts.gstatic.com*"] });

  async function evalJs(expression) {
    const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) throw new Error("JS 异常: " + JSON.stringify(r.result.exceptionDetails).slice(0, 400));
    return r.result?.result?.value;
  }
  async function shot(name) {
    const r = await send("Page.captureScreenshot", { format: "png" });
    const p = join(shots, String(++shotN).padStart(2, "0") + "-" + name + ".png");
    if (r.result?.data) await writeFile(p, Buffer.from(r.result.data, "base64"));
    return p;
  }
  const pass = [];
  const fail = [];
  const check = (name, cond) => (cond ? pass.push(name) : fail.push(name));

  await send("Page.navigate", { url: APP });
  let boot = null;
  for (let i = 0; i < 50; i++) {
    await sleep(200);
    boot = await evalJs(`window.XJ && XJ.state.store.state ? JSON.stringify({ errs: window.__xjErrors || [], n: XJ.state.store.state.sessions.length }) : null`);
    if (boot) break;
  }
  if (!boot) throw new Error("页面 10 秒没就绪");
  console.log("boot:", boot);

  /* 模拟独立窗外壳：原型页没有 embed.js，XJ.embed 整个不存在，造一个 */
  await evalJs(`
    window.__msgs = [];
    XJ.embed = { host: "app", post: function (m) { window.__msgs.push(m); } };
    'ok'`);

  /* 1. 外壳抓完图推卡片过来（带它自动挑的默认目标 s_test） */
  await evalJs(`
    XJ.shot.open("data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
      { width: 800, height: 600, sessionId: "s_test", sessionTitle: "给登录页补 3 个单测" });
    'ok'`);
  await sleep(300);
  check("截图卡出现", await evalJs(`!!document.querySelector(".form-shot")`));
  check("目标 pill 显示外壳挑的会话", (await evalJs(`document.querySelector(".shot-target").textContent`)).includes("给登录页"));
  check("meta 只剩尺寸（目标进了 pill）", (await evalJs(`document.querySelector(".shot-meta").textContent`)).trim() === "800 × 600");
  const cardShot = await shot("shot-card");
  console.log("截图:", cardShot);

  const h0 = await evalJs(`Math.round(document.querySelector(".form-shot").getBoundingClientRect().height)`);

  /* 2. 开内联选择器 */
  await evalJs(`document.querySelector(".shot-target").click(); 'ok'`);
  await sleep(250);
  check("内联选择器展开", await evalJs(`!!document.querySelector(".shot-pick")`));
  const h1 = await evalJs(`Math.round(document.querySelector(".form-shot").getBoundingClientRect().height)`);
  check("展开后卡片变高（窗口会跟着撑高，不会被裁）", h1 > h0 + 40);
  const pickerShot = await shot("shot-picker-open");
  console.log("截图:", pickerShot);

  const rows = await evalJs(`[...document.querySelectorAll(".xj-pick-row")].map(r => ({ text: r.textContent.replace(/\\s+/g," ").trim(), on: r.classList.contains("on") }))`);
  console.log("选择器行:", JSON.stringify(rows, null, 1));
  check("行数 = 4 个会话（没有新会话——宿主建不了）", rows.length === 4);
  check("默认勾的是外壳挑的 s_test", rows.find((r) => r.on)?.text.includes("给登录页"));
  check("行里有状态 pill", await evalJs(`!!document.querySelector(".shot-pick .pill")`));

  /* 3. 换到「把 README 的截图流程写成脚本」 */
  await evalJs(`[...document.querySelectorAll(".xj-pick-row")].find(r => r.textContent.includes("README")).click(); 'ok'`);
  await sleep(250);
  check("选完选择器收起", await evalJs(`!document.querySelector(".shot-pick")`));
  check("pill 换成 README 会话", (await evalJs(`document.querySelector(".shot-target").textContent`)).includes("README"));
  check("卡片高度回落", await evalJs(`Math.round(document.querySelector(".form-shot").getBoundingClientRect().height)`) === h0);

  /* 4. 填问题 → 发送 → 校验载荷 */
  await evalJs(`
    var ta = document.querySelector(".shot-input");
    ta.value = "这个报错是什么意思";
    ta.dispatchEvent(new Event("input"));
    'ok'`);
  await evalJs(`[...document.querySelectorAll(".shot-actions button")].find(b => b.textContent.includes("发送")).click(); 'ok'`);
  await sleep(400);
  const msgs = await evalJs(`JSON.stringify(window.__msgs)`);
  console.log("发给外壳的消息:", msgs);
  const sent = JSON.parse(msgs).find((m) => m.action === "send");
  check("发送动作带了 text", !!sent && sent.text === "这个报错是什么意思");
  check("发送动作带了挑中的 sessionId（s_doc）", !!sent && sent.sessionId === "s_doc");
  const doneShot = await shot("shot-sending");
  console.log("截图:", doneShot);

  /* 5. 外壳回执 → 卡片收掉 */
  await evalJs(`XJ.shot.done(true, "已发到《把 README 的截图流程写成脚本》"); 'ok'`);
  await sleep(200);
  check("回执后卡片显示成功态", await evalJs(`document.querySelector(".shot-card").classList.contains("is-ok")`));

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
