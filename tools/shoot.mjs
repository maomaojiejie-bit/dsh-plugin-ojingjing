/* =============================================================================
   tools/shoot.mjs · 无头 Chromium + CDP 驱动，用来给原型拍"交互后"的截图
   用法：node tools/shoot.mjs panel approve capture-edit capture-confirm send
   依赖：本机 Chrome（Windows 默认安装路径）；Node 24 自带 WebSocket / fetch
   ========================================================================== */
import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SHOTS = join(ROOT, "docs", "screenshots");
const PORT = 9337;
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const W = 1440;
const H = 900;

mkdirSync(SHOTS, { recursive: true });

/* ------------------------------ 场景表 ------------------------------ */
/** 每个场景：hash（页面初始 demo 状态）+ run(page) 里的交互步骤 */
const scenarios = {
  panel: { hash: "#demo=panel" },
  bubble: { hash: "#demo=bubble" },
  quickbar: { hash: "#demo=quickbar" },
  settings: { hash: "#demo=settings" },
  approvals: { hash: "#demo=approvals" },
  onboarding: { hash: "#demo=onboarding" },
  unread: { hash: "#demo=unread" },
  offline: { hash: "#demo=offline" },
  empty: { hash: "#demo=empty" },
  danger: { hash: "#demo=danger" },
  density: { hash: "#demo=density" },

  // 审批：点「通过」后 900ms，看卡片结算 + toast + 会话继续
  approve: {
    hash: "#demo=panel",
    async run(page) {
      await page.eval(`(() => {
        const btn = [...document.querySelectorAll('.approval-card .btn-solid')][0];
        btn && btn.click();
        return !!btn;
      })()`);
      await page.wait(900);
    },
  },

  // 审批：拒绝 → 二次确认
  "reject-confirm": {
    hash: "#demo=panel",
    async run(page) {
      await page.eval(`(() => {
        const b = [...document.querySelectorAll('.approval-card .btn-ghost')][0];
        b && b.click();
        return !!b;
      })()`);
      await page.wait(300);
    },
  },

  // 竞态：主窗口先处理，浮窗后到
  race: {
    hash: "#demo=panel",
    async run(page) {
      await page.eval(`(() => {
        const c = XJ.mock.harness;
        const id = Object.keys(XJ.state.store.state.approvals)[0];
        c.resolveElsewhere(id);
        return id;
      })()`);
      await page.wait(500);
    },
  },

  // 快捷输入：发给空闲会话 → 流式回复中
  send: {
    hash: "#demo=quickbar",
    async run(page) {
      await page.eval(`(() => {
        const idle = XJ.state.store.state.sessions.find((x) => x.state === 'idle');
        idle && XJ.state.actions.composerTarget(idle.id);
        return idle && idle.id;
      })()`);
      await page.wait(200);
      await page.eval(`(() => {
        const ta = document.querySelector('.qb-input');
        ta.focus();
        ta.value = '帮我看看 token 刷新为什么会重复刷新？';
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        document.querySelector('.qb-send').click();
        return true;
      })()`);
      await page.wait(900);
    },
  },

  // 快捷输入：流式结束（3 行预览 + 已完成 + 查看完整回复）
  "send-done": {
    hash: "#demo=quickbar",
    async run(page) {
      await page.eval(`(() => {
        const idle = XJ.state.store.state.sessions.find((x) => x.state === 'idle');
        idle && XJ.state.actions.composerTarget(idle.id);
        return true;
      })()`);
      await page.wait(200);
      await page.eval(`(() => {
        const ta = document.querySelector('.qb-input');
        ta.value = '帮我看看 token 刷新为什么会重复刷新？';
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        document.querySelector('.qb-send').click();
        return true;
      })()`);
      await page.wait(5000);
    },
  },

  // 发送失败：内容保留 + 按钮变「重试」
  "send-fail": {
    hash: "#demo=quickbar",
    async run(page) {
      await page.eval(`(() => {
        XJ.state.store.state.runtime.simSendFail = true;
        const idle = XJ.state.store.state.sessions.find((x) => x.state === 'idle');
        idle && XJ.state.actions.composerTarget(idle.id);
        return true;
      })()`);
      await page.wait(200);
      await page.eval(`(() => {
        const ta = document.querySelector('.qb-input');
        ta.value = '这条会失败';
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        document.querySelector('.qb-send').click();
        return true;
      })()`);
      await page.wait(900);
    },
  },

  // 截图：框选完进入编辑态（标注工具条 + 尺寸角标）
  "capture-edit": {
    hash: "#demo=panel",
    async run(page) {
      await page.eval(`(() => {
        XJ.capture.start();
        const layer = document.querySelector('.capture-layer');
        const fire = (t, x, y) => layer.dispatchEvent(new MouseEvent(t, { clientX: x, clientY: y, bubbles: true, cancelable: true }));
        fire('mousemove', 420, 250);
        fire('mousedown', 420, 250);
        fire('mousemove', 980, 600);
        fire('mouseup', 980, 600);
        return !!layer;
      })()`);
      await page.wait(500);
    },
  },

  // 截图：确认发送卡（缩略图 + 目标会话 + 问题输入 + 唯一主行动「发送」）
  "capture-confirm": {
    hash: "#demo=panel",
    async run(page) {
      await page.eval(`(async () => {
        XJ.capture.start();
        const layer = document.querySelector('.capture-layer');
        const fire = (t, x, y) => layer.dispatchEvent(new MouseEvent(t, { clientX: x, clientY: y, bubbles: true, cancelable: true }));
        fire('mousemove', 420, 250);
        fire('mousedown', 420, 250);
        fire('mousemove', 980, 600);
        fire('mouseup', 980, 600);
        await new Promise(r => setTimeout(r, 200));
        const done = document.querySelector('.capture-tools button[aria-label="完成"]');
        done && done.click();
        return !!done;
      })()`);
      await page.wait(700);
    },
  },

  // 拖入文件：悬停鲸鱼 200ms 进入接收态（气泡态才有鲸鱼）
  drop: {
    hash: "#demo=bubble",
    async run(page) {
      await page.eval(`(() => {
        const dt = new DataTransfer();
        dt.items.add(new File(['{"a":1}'], 'config.json', { type: 'application/json' }));
        dt.items.add(new File(['log line'], 'build.log', { type: 'text/plain' }));
        const stage = document.getElementById('xj-stage');
        const orb = stage.querySelector('.orb');
        for (const t of ['dragenter', 'dragover']) {
          orb.dispatchEvent(new DragEvent(t, { dataTransfer: dt, bubbles: true, cancelable: true }));
        }
        return !!orb;
      })()`);
      await page.wait(600);
    },
  },

  // 拖入后松手：出现确认条（文件名 + 目标会话 + 发送/移除）
  "drop-confirm": {
    hash: "#demo=bubble",
    async run(page) {
      await page.eval(`(() => {
        const dt = new DataTransfer();
        dt.items.add(new File(['{"a":1}'], 'config.json', { type: 'application/json' }));
        dt.items.add(new File(['log line'], 'build.log', { type: 'text/plain' }));
        const stage = document.getElementById('xj-stage');
        const orb = stage.querySelector('.orb');
        orb.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, bubbles: true, cancelable: true }));
        orb.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }));
        return new Promise((r) => setTimeout(() => {
          stage.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
          r(true);
        }, 260));
      })()`);
      await page.wait(900);
    },
  },

  // 冒烟：把主要交互点一遍，最后打印 window.__xjErrors
  smoke: {
    hash: "#demo=panel",
    async run(page) {
      const step = async (code, wait) => {
        await page.eval(`(() => { ${code} ; return true; })()`);
        await page.wait(wait || 350);
      };
      // 1. 通过第一条审批
      await step(`const b = document.querySelector('.approval-card .btn-solid'); b && b.click();`, 900);
      // 2. 打开设置，切三个开关，再回来
      await step(`document.querySelector('.panel-head .icon-btn[aria-label="设置"]') || document.querySelectorAll('.panel-head .icon-btn')[0]; const s = document.querySelector('[aria-label="设置"]'); s && s.click();`, 500);
      await step(`document.querySelectorAll('.sheet .switch').forEach((el, i) => { if (i < 3) el.click(); });`, 400);
      await step(`const c = document.querySelector('.panel-head .icon-btn[aria-label="关闭"]') || document.querySelector('.sheet .icon-btn'); c && c.click();`, 500);
      // 3. 打开输入条，打字并发送（发给空闲会话，避免排队）
      await step(`XJ.state.actions.composerTarget('s_lic'); XJ.app.openQuickbar();`, 400);
      await step(`const ta = document.querySelector('.qb-input'); ta.value = '帮我看看这个删除会影响哪些文件？'; ta.dispatchEvent(new Event('input', { bubbles: true }));`, 300);
      await step(`document.querySelector('.qb-send').click();`, 2200);
      // 4. 打开审批中心，按 Y 放行
      await step(`XJ.app.openApprovalCenter();`, 600);
      // 5. 收起
      await step(`XJ.app.collapse();`, 400);
      const errs = await page.eval(`JSON.stringify(window.__xjErrors || [])`);
      console.log("  smoke errors →", errs);
      await page.eval(`XJ.app.openPanel();`);
      await page.wait(400);
    },
  },

  // 首次启动：引导第一步（无 demo hash，localStorage 干净）
  firstrun: {
    hash: "",
    async run(page) {
      await page.wait(900);
    },
  },

  // 自检：打印会话标题映射
  probe: {
    hash: "#demo=panel",
    async run(page) {
      const out = await page.eval(`(() => {
        XJ.state.actions.patchSettings({ presentation: 'always' });
        const s = XJ.state.store.state;
        return s.sessions.map((x) => x.id + ':' + XJ.state.displayTitle(s, x)).join(' | ');
      })()`);
      console.log("  probe →", out);
    },
  },

  // 提问（question.requested）：浮窗只提示 + 带你去回答
  question: {
    hash: "#demo=panel",
    async run(page) {
      await page.eval(`(() => {
        const hz = XJ.mock.harness;
        hz.expireApproval('ap_seed');
        setTimeout(() => hz.pushQuestion('这个删除会影响哪些文件？会顺带清掉构建缓存吗？'), 200);
        return 'ok';
      })()`);
      await page.wait(1200);
    },
  },

  // 演示模式：命令正文折叠
  presenting: {
    hash: "#demo=panel",
    async run(page) {
      await page.eval(`XJ.state.actions.patchSettings({ presentation: 'always' })`);
      await page.wait(500);
    },
  },

  // 停止会话二次确认
  "stop-confirm": {
    hash: "#demo=panel",
    async run(page) {
      await page.eval(`(() => {
        const b = [...document.querySelectorAll('.sess-card')].map(c => c.querySelector('.btn-mini')).find(Boolean);
        b && b.click();
        return !!b;
      })()`);
      await page.wait(300);
    },
  },
};

/* ------------------------------ CDP 基础 ------------------------------ */
function launch() {
  const profile = mkdtempSync(join(tmpdir(), "xj-cdp-"));
  const proc = spawn(
    CHROME,
    [
      "--headless=new",
      "--disable-gpu",
      "--hide-scrollbars",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-features=Translate",
      "--force-prefers-reduced-motion",
      "--force-device-scale-factor=1",
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${profile}`,
      `--window-size=${W},${H}`,
      "about:blank",
    ],
    { stdio: "ignore" }
  );
  return proc;
}

async function waitTargets(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await res.json();
      const page = list.find((t) => t.type === "page");
      if (page && page.webSocketDebuggerUrl) return page;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("CDP target 超时");
}

function connect(url) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(url);
    const pending = new Map();
    let seq = 0;
    ws.addEventListener("open", () => {
      const send = (method, params = {}) =>
        new Promise((resolveP, rejectP) => {
          const id = ++seq;
          pending.set(id, { resolveP, rejectP });
          ws.send(JSON.stringify({ id, method, params }));
        });
      ws.addEventListener("message", (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.id && pending.has(msg.id)) {
          const { resolveP } = pending.get(msg.id);
          pending.delete(msg.id);
          resolveP(msg);
        }
      });
      res({ ws, send });
    });
    ws.addEventListener("error", rej);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const wanted = process.argv.slice(2);
  const list = wanted.length ? wanted : Object.keys(scenarios);
  const proc = launch();
  const target = await waitTargets();
  const { send } = await connect(target.webSocketDebuggerUrl);

  await send("Page.enable");
  await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });

  for (const name of list) {
    const sc = scenarios[name];
    if (!sc) {
      console.log("skip", name);
      continue;
    }
    // 每次都用不同的 query，强制真正重载（同 hash 的 navigate 不会 reload）
    const url =
      "file:///" +
      join(ROOT, "app", "index.html").replace(/\\/g, "/") +
      "?t=" +
      Date.now() +
      (sc.hash || "");
    await send("Page.navigate", { url });
    // 等应用初始化完成
    let ready = false;
    for (let i = 0; i < 40 && !ready; i++) {
      await sleep(120);
      const r = await send("Runtime.evaluate", {
        expression: "!!(window.XJ && XJ.app && XJ.state && XJ.state.store.state.connection)",
        returnByValue: true,
      });
      ready = !!(r.result && r.result.result && r.result.result.value);
    }
    if (!ready) {
      console.log("!! init 失败", name);
      continue;
    }
    // 场景之间互不影响：清掉 localStorage（设置/引导标记），然后重载等新文档就绪
    const dirty = await send("Runtime.evaluate", { expression: "localStorage.length > 0", returnByValue: true });
    if (dirty.result && dirty.result.result && dirty.result.result.value) {
      await send("Runtime.evaluate", { expression: "window.__xjReload = 1; localStorage.clear(); location.reload()" });
      let fresh = false;
      for (let i = 0; i < 60 && !fresh; i++) {
        await sleep(120);
        const r = await send("Runtime.evaluate", {
          expression: "!window.__xjReload && !!(window.XJ && XJ.state && XJ.state.store.state.connection)",
          returnByValue: true,
        });
        fresh = !!(r.result && r.result.result && r.result.result.value);
      }
    }
    await sleep(450); // demo hash 生效 + 入场动画
    const page = {
      eval: async (expr) => {
        const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
        if (r.result && r.result.exceptionDetails) console.log("  eval error", r.result.exceptionDetails.text);
        return r.result && r.result.result ? r.result.result.value : undefined;
      },
      wait: sleep,
    };
    let ok = true;
    if (sc.run) {
      try {
        await sc.run(page);
      } catch (e) {
        ok = false;
        console.log("!! 场景失败", name, e.message);
      }
    }
    await sleep(120);
    const shot = await send("Page.captureScreenshot", { format: "png", fromSurface: true });
    const out = join(SHOTS, name + ".png");
    writeFileSync(out, Buffer.from(shot.result.data, "base64"));
    console.log((ok ? "ok   " : "fail ") + name + " → docs/screenshots/" + name + ".png");
  }

  await send("Browser.close").catch(() => {});
  proc.kill();
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
