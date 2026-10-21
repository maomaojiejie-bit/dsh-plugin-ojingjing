/**
 * tools/dev/ 探针共用的 CDP（Chrome DevTools Protocol）客户端 + headless Chrome 起停。
 *
 * cdp-eval / fps-probe / scroll-probe / wheel-check / probe-embed 五个探针原来各写一份
 * 「起 Chrome → 等 /json/list 出 page target → WebSocket + pending Map + send」，
 * 这里收敛成一处。
 *
 * 三种用法：
 *   const { send, close } = await connect(9223);           // 连一个已经在跑的页面（外壳/CDP 端口）
 *   const chrome = launchChrome(9339, { url });            // 自己起一个 headless Chrome
 *   const { send, close } = await connect(chrome.port);    // 然后连它
 *   chrome.close();                                        // 用完连进程带临时 profile 一起收
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 起一个带 remote-debugging-port 的 headless Chrome。
 * 返回 { proc, port, close }：close() 杀进程并删掉临时 user-data-dir。
 */
export function launchChrome(port, { width = 1440, height = 900, extraFlags = [], url = "about:blank", prefix = "xj-dev" } = {}) {
  const profile = mkdtempSync(join(tmpdir(), `${prefix}-`));
  const proc = spawn(
    CHROME,
    [
      "--headless=new",
      "--disable-gpu",
      "--hide-scrollbars",
      "--no-first-run",
      "--force-device-scale-factor=1",
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      `--window-size=${width},${height}`,
      ...extraFlags,
      url,
    ],
    { stdio: "ignore" }
  );
  const close = () => {
    try {
      proc.kill();
    } catch {
      /* 已经退了 */
    }
    try {
      rmSync(profile, { recursive: true, force: true });
    } catch {
      /* 删不掉拉倒，反正在临时目录 */
    }
  };
  return { proc, port, close, profile };
}

/** 轮询 /json/list 直到出现 page target；超时返回 null。 */
export async function waitTarget(port, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch {
      /* Chrome 还没起来，继续等 */
    }
    await sleep(200);
  }
  return null;
}

/**
 * 连上 port 上的 page target。返回：
 *   send(method, params)  → Promise<整个响应 msg>（调用方取 msg.result）
 *   events                服务端推来的事件数组（Log.entryAdded 之类，诊断用）
 *   close()               关 WebSocket
 * 连不上直接 throw（探针本来就要求目标在）。
 */
export async function connect(port, { timeoutMs = 15000 } = {}) {
  const page = await waitTarget(port, timeoutMs);
  if (!page) throw new Error(`CDP 没有 page target（port ${port}，等了个 ${timeoutMs}ms）`);
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  const pending = new Map();
  const events = [];
  let seq = 0;

  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    } else if (msg.method) {
      events.push(msg);
    }
  });

  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const id = (seq += 1);
      pending.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params }));
    });

  if (ws.readyState !== WebSocket.OPEN) {
    await new Promise((r) => ws.addEventListener("open", r, { once: true }));
  }
  return { ws, send, events, close: () => ws.close() };
}
