/**
 * 验证「DSH 起来 → 自动拉起哦鲸鲸独立窗」这条联动。
 *
 *   node tools/test-shell-launch.mjs           # 真拉起一个实例，8s 后报告进程数
 *   node tools/test-shell-launch.mjs --no-kill # 不动已经在跑的实例
 *
 * 它直接调插件里的 launchShellIfNeeded（和宿主启动时走同一个函数），
 * 所以验证的是真代码，不是另写一份逻辑。
 */
import path from "node:path";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const CONFIG = path.join(os.homedir(), ".dsh", "ojingjing-shell.json");

const appInstances = () =>
  execFileSync("powershell", [
    "-NoProfile",
    "-Command",
    "@(Get-CimInstance Win32_Process -Filter \"Name='pythonw.exe'\" | Where-Object { $_.CommandLine -like '*ojingjing_py.py*' }).Count",
  ], { encoding: "utf8" }).trim();

if (!process.argv.includes("--no-kill")) {
  execFileSync("powershell", [
    "-NoProfile",
    "-Command",
    "Get-CimInstance Win32_Process -Filter \"Name='pythonw.exe'\" | Where-Object { $_.CommandLine -like '*ojingjing_py.py*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }",
  ], { stdio: "ignore" });
  await new Promise((r) => setTimeout(r, 1200));
}

console.log("配置存在:", existsSync(CONFIG), CONFIG);
console.log("拉起前实例数:", appInstances());

const { launchShellIfNeeded } = await import("../lib/index.js");
launchShellIfNeeded({ logger: { info: (msg) => console.log("  host:", msg) } });

await new Promise((r) => setTimeout(r, 9000));
console.log("拉起后实例数:", appInstances());

// 幂等：再调一次不应再多开
launchShellIfNeeded({ logger: { info: (msg) => console.log("  host:", msg) } });
await new Promise((r) => setTimeout(r, 1500));
console.log("二次调用后实例数:", appInstances());
