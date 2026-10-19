/**
 * 悬浮窗外壳（standalone-py）的共享后勤，被 tools/install.mjs 与 tools/uninstall.mjs 调用：
 *
 *   - shellLaunchers()   挑能跑 PySide6 的 pythonw 解释器，写成宿主插件读得懂的候选列表
 *   - writeShellConfig() 写 ~/.dsh/ojingjing-shell.json（DSH 启动时据此自动拉起独立窗）
 *   - removeShellConfig() 删配置（连改名前的 xiaojing-shell.json 一起清）
 *   - stopRunningShell() 按 data/ojingjing.pid 停掉正在跑的独立窗
 *
 * tools/install-plugin.mjs（不依赖 dsh 的老路子）里有一份等价实现。这边刻意没有回去合并，
 * 因为那条路目前是好的、又没法在改代码的同时安全地跑一遍验证；新脚本一律走这个模块。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 仓库根（也是插件包根）。 */
export const ROOT = path.resolve(HERE, "..");

/** 独立窗（PySide6）目录与入口脚本名。 */
export const SHELL_DIR = path.join(ROOT, "standalone-py");
export const SHELL_SCRIPT = "ojingjing_py.py";

/** 独立窗自己写的 pid 文件，卸载时靠它精确杀掉这一个实例。 */
export const PID_FILE = path.join(SHELL_DIR, "data", "ojingjing.pid");

/** 插件包名，以及改名前的旧包名（两个同时被加载会分屏，装/卸都要顺手清）。 */
export const PACKAGE_NAME = "dsh-plugin-ojingjing";
export const LEGACY_PACKAGES = ["dsh-plugin-xiaojing"];

const DSH_HOME = path.join(os.homedir(), ".dsh");
export const PROFILES_DIR = path.join(DSH_HOME, "profiles");

/** 自动拉起配置；删掉它或把 autoLaunch 改成 false 就关掉自动启动。 */
export const SHELL_CONFIG = path.join(DSH_HOME, "ojingjing-shell.json");
export const LEGACY_SHELL_CONFIGS = [path.join(DSH_HOME, "xiaojing-shell.json")];

/**
 * 挑能跑 PySide6 的解释器，按优先级排成候选列表（宿主取第一个真实存在的）：
 *   1. 项目里的 venv——PySide6 装在这里，tools/install.mjs 会顺手补齐
 *   2. %LOCALAPPDATA%\Programs\Python\Python3*\pythonw.exe（系统级装了 PySide6 的情况）
 *   3. C:\Windows\pyw.exe（Python Launcher，最后兜底）
 */
export function shellLaunchers() {
  const list = [];

  const venvPyw = path.join(SHELL_DIR, ".venv", "Scripts", "pythonw.exe");
  if (fs.existsSync(venvPyw)) list.push(venvPyw);

  const pythonRoot = path.join(os.homedir(), "AppData", "Local", "Programs", "Python");
  if (fs.existsSync(pythonRoot)) {
    const versionOf = (name) => Number.parseInt(name.replace(/^Python/i, ""), 10) || 0;
    const names = fs
      .readdirSync(pythonRoot)
      .filter((n) => /^Python3/i.test(n))
      .sort((a, b) => versionOf(b) - versionOf(a)); // 新的优先
    for (const name of names) {
      const exe = path.join(pythonRoot, name, "pythonw.exe");
      if (fs.existsSync(exe)) list.push(exe);
    }
  }

  const pyw = path.join(process.env.SystemRoot || "C:\\Windows", "pyw.exe");
  if (fs.existsSync(pyw)) list.push(pyw);

  return list;
}

/** 写自动拉起配置；返回写进去的 payload，方便调用方打印。 */
export function writeShellConfig(overrides = {}) {
  fs.mkdirSync(DSH_HOME, { recursive: true });
  const payload = {
    shellDir: SHELL_DIR,
    script: SHELL_SCRIPT,
    launchers: shellLaunchers(),
    autoLaunch: true,
    note: "由 tools/install.mjs 生成；插件在 DSH 启动时按这里拉起独立窗。删掉本文件或把 autoLaunch 改成 false 即可关掉自动启动。",
    ...overrides,
  };
  fs.writeFileSync(SHELL_CONFIG, JSON.stringify(payload, null, 2) + "\n", "utf8");
  return payload;
}

/** 读现有配置；没有或坏掉都返回 null。 */
export function readShellConfig() {
  try {
    return JSON.parse(fs.readFileSync(SHELL_CONFIG, "utf8"));
  } catch {
    return null;
  }
}

/** 删自动拉起配置（含改名前的旧文件）；返回真正删掉的那些路径。 */
export function removeShellConfig() {
  const removed = [];
  for (const file of [SHELL_CONFIG, ...LEGACY_SHELL_CONFIGS]) {
    if (fs.existsSync(file)) {
      fs.rmSync(file, { force: true });
      removed.push(file);
    }
  }
  return removed;
}

/** 正在跑的独立窗 pid；没在跑就返回 null（顺手清掉陈旧的 pid 文件）。 */
export function runningShellPid() {
  let raw;
  try {
    raw = fs.readFileSync(PID_FILE, "utf8").trim();
  } catch {
    return null;
  }
  const pid = Number.parseInt(raw, 10);
  if (!Number.isInteger(pid) || pid <= 0) {
    fs.rmSync(PID_FILE, { force: true });
    return null;
  }
  try {
    process.kill(pid, 0);
    return pid;
  } catch {
    fs.rmSync(PID_FILE, { force: true });
    return null;
  }
}

/**
 * pid 文件的 pid 是不是真属于独立窗。
 * 陈旧的 pid 会被系统回收给别的进程，直接 taskkill 可能误杀无关程序，
 * 所以先问一下这个 pid 的镜像名是不是 python/pythonw。
 * 返回 true / false（不是我们的人）/ null（判断不了，安全起见别动）。
 */
function isShellPid(pid) {
  const r = spawnSync("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (r.error || r.status !== 0 || typeof r.stdout !== "string") return null;
  const first = r.stdout
    .split(/\r?\n/)
    .map((s) => s.trim())
    .find(Boolean);
  if (!first) return false;
  // 没有匹配时 tasklist 打的是「信息: 没有运行的任务…」，中文/英文都要认
  if (/^(信息|INFO|錯誤|错误)/i.test(first) || /No tasks/i.test(first)) return false;
  return /pythonw?\.exe/i.test(first);
}

/** 停掉正在跑的独立窗；返回 { stopped: pid|null, reason }。 */
export function stopRunningShell() {
  const pid = runningShellPid();
  if (pid === null) return { stopped: null, reason: "没在跑" };

  if (process.platform === "win32") {
    const ours = isShellPid(pid);
    if (ours === false) {
      fs.rmSync(PID_FILE, { force: true });
      return { stopped: null, reason: `pid ${pid} 已经不是独立窗了（陈旧记录），已清掉 pid 文件` };
    }
    if (ours === null) return { stopped: null, reason: "判断不了 pid 归属，跳过停窗（不影响安装）" };
    const r = spawnSync("taskkill", ["/f", "/pid", String(pid)], { stdio: "ignore", windowsHide: true });
    if (r.status !== 0 && r.error === undefined) {
      return { stopped: null, reason: `taskkill 没能结束 pid ${pid}（可能已经在退出）` };
    }
  } else {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      return { stopped: null, reason: `杀掉 pid ${pid} 失败` };
    }
  }

  fs.rmSync(PID_FILE, { force: true });
  return { stopped: pid, reason: "已结束" };
}
