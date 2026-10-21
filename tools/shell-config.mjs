/**
 * 独立窗外壳（standalone-cs）的共享后勤，被 tools/install.mjs 与 tools/uninstall.mjs 调用：
 *
 *   - writeShellConfig()   写 ~/.dsh/ojingjing-shell.json（DSH 启动时据此自动拉起独立窗）
 *   - removeShellConfig()  删配置（连改名前的 xiaojing-shell.json 一起清）
 *   - stopRunningShell()   按镜像名停掉正在跑的 Ojingjing.exe
 *
 * tools/install-plugin.mjs（不依赖 dsh 的老路子）里有一份等价实现。这边刻意没有回去合并，
 * 因为那条路目前是好的、又没法在改代码的同时安全地跑一遍验证；新脚本一律走这个模块。
 *
 * 2026-10-21：PySide6 旧壳（standalone-py）整条退役，这个模块只认 C# 外壳的 exe。
 * 旧配置里残留的 shellDir / script / launchers 字段读的时候直接忽略。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 仓库根（也是插件包根）。 */
export const ROOT = path.resolve(HERE, "..");

/** C# + WebView2 外壳：一个 exe + 三个 DLL，没有运行时依赖要装。 */
export const CS_EXE = path.join(ROOT, "dist", "Ojingjing-CS", "Ojingjing.exe");
export const CS_DIR = path.dirname(CS_EXE);

/** 插件包名，以及改名前的旧包名（两个同时被加载会分屏，装/卸都要顺手清）。 */
export const PACKAGE_NAME = "dsh-plugin-ojingjing";
export const LEGACY_PACKAGES = ["dsh-plugin-xiaojing"];

const DSH_HOME = path.join(os.homedir(), ".dsh");
export const PROFILES_DIR = path.join(DSH_HOME, "profiles");

/** 自动拉起配置；删掉它或把 autoLaunch 改成 false 就关掉自动启动。 */
export const SHELL_CONFIG = path.join(DSH_HOME, "ojingjing-shell.json");
export const LEGACY_SHELL_CONFIGS = [path.join(DSH_HOME, "xiaojing-shell.json")];

/** 写自动拉起配置；返回写进去的 payload，方便调用方打印。 */
export function writeShellConfig(overrides = {}) {
  fs.mkdirSync(DSH_HOME, { recursive: true });
  const payload = {
    exe: CS_EXE,
    workDir: CS_DIR,
    autoLaunch: true,
    note: "由 tools/install.mjs 生成；插件在 DSH 启动时按这里拉起独立窗（C# 外壳）。删掉本文件或把 autoLaunch 改成 false 即可关掉自动启动。",
  };
  const merged = { ...payload, ...overrides };
  fs.writeFileSync(SHELL_CONFIG, JSON.stringify(merged, null, 2) + "\n", "utf8");
  return merged;
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

/** C# 外壳（Ojingjing.exe）在跑的 pid 列表；没在跑就是空数组。 */
export function runningCsShellPids() {
  if (process.platform !== "win32") return [];
  const r = spawnSync("tasklist", ["/FI", "IMAGENAME eq Ojingjing.exe", "/FO", "CSV", "/NH"], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (r.error || r.status !== 0 || typeof r.stdout !== "string") return [];
  const pids = [];
  for (const line of r.stdout.split(/\r?\n/)) {
    const m = line.match(/^"([^"]+)","(\d+)"/);
    if (m && /^Ojingjing\.exe$/i.test(m[1])) pids.push(Number.parseInt(m[2], 10));
  }
  return pids;
}

/** 停掉正在跑的独立窗（按镜像名，Ojingjing.exe 是我们独有的）；返回 { stopped, reason }。 */
export function stopRunningShell() {
  const reasons = [];
  let stopped = null;

  for (const pid of runningCsShellPids()) {
    const r = spawnSync("taskkill", ["/f", "/pid", String(pid)], { stdio: "ignore", windowsHide: true });
    if (r.status === 0 || r.error === undefined) {
      stopped = pid;
      reasons.push(`已结束外壳 pid ${pid}`);
    } else {
      reasons.push(`外壳 pid ${pid} 没能结束（可能已经在退出）`);
    }
  }

  return { stopped, reason: reasons.length ? reasons.join("；") : "没在跑" };
}
