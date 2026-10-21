#!/usr/bin/env node
/**
 * 构建 C# + WebView2 版独立窗：csc（.NET Framework 4.8 自带）编译 → dist\Ojingjing-CS\
 *
 * 为什么不用 MSBuild / dotnet publish：
 *   - MSBuild 要 Visual Studio 那一套，这台机器没有；
 *   - `dotnet publish` 走自包含会把 .NET 运行时再打包一份（几十 MB），
 *     而 net48 是 Win10/11 自带的，直接 csc 编译出来的 exe 只有十几 KB。
 *
 * 用法：node tools\build-shell-cs.mjs [--debug]
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { die, phase } from "./lib/log.mjs";
import { makeStoreZip } from "./lib/zip.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SRC = join(ROOT, "standalone-cs");
const SDK = join(SRC, "sdk");
const WEB = join(ROOT, "web");
const OUT = join(ROOT, "dist", "Ojingjing-CS");
const debug = process.argv.includes("--debug");

const CSC = "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe";
const ICO = join(SRC, "icon.ico");
const REF = [
  join(SDK, "Microsoft.Web.WebView2.Core.dll"),
  join(SDK, "Microsoft.Web.WebView2.WinForms.dll"),
  "System.dll",
  "System.Core.dll",
  "System.Drawing.dll",
  "System.Windows.Forms.dll",
  "System.Web.Extensions.dll",
  // 页面本体随 exe 打包：启动时从 payload.zip 解到配置目录（System.IO.Compression）
  "System.IO.Compression.dll",
  "System.IO.Compression.FileSystem.dll",
];

phase("检查工具链");
if (!existsSync(CSC)) die(`找不到 csc.exe：${CSC}`);
if (!existsSync(ICO)) die(`缺 ${ICO}：跑 python tools/make-ico.py 生成（assets/icon-source.png → 多尺寸 .ico，烧进 exe 给 Explorer/托盘用）`);
phase("检查 WebView2 SDK");
const sdkFiles = ["Microsoft.Web.WebView2.Core.dll", "Microsoft.Web.WebView2.WinForms.dll", "WebView2Loader.dll"];
for (const f of sdkFiles) {
  if (!existsSync(join(SDK, f))) die(`standalone-cs/sdk 缺 ${f}（从 NuGet 的 Microsoft.Web.WebView2 包里拷 lib/net462 与 runtimes/win-x64/native）`);
}

phase("准备输出目录");
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

phase("打包页面（随 exe 一起带走）");
// 为什么要内嵌页面：老大 2026-10-21「我要打开exe文件的时候也是那个面版 不需要现在这个」——
// 之前 DSH 没开时外壳只能自己画一个离线小卡片；现在把 web/ 整个打进 exe，
// 启动时解到配置目录、用 WebView2 的虚拟主机映射挂到 https://ojingjing.local/xj/app.html，
// 没有 DSH 也是那个完整面板（前端自己会切离线视觉：黑白球 + 灰虚线环 + 「连接已断开」）。
const PAYLOAD = join(SRC, "payload.zip");
const entries = [];
function walk(dir, prefix) {
  for (const name of readdirSync(dir)) {
    if (prefix === "xj/" && (name === "icon.png" || name === "payload.zip")) continue; // 图标是插件侧用的，页面不引用
    const full = join(dir, name);
    const st = statSync(full);
    const key = prefix + name;
    if (st.isDirectory()) walk(full, key + "/");
    else entries.push({ name: key, data: readFileSync(full) });
  }
}
walk(WEB, "xj/");
const pkgEarly = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
// stamp = 版本号 + 构建时间：外壳拿它跟已解包的目录比对，一致就不重复解包
const stamp = `${pkgEarly.version}-${new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14)}`;
entries.push({ name: "stamp.txt", data: Buffer.from(stamp, "utf8") });
writeFileSync(PAYLOAD, makeStoreZip(entries));
console.log(`   ${entries.length} 个文件 → payload.zip ${(statSync(PAYLOAD).size / 1024).toFixed(0)} KB（stamp ${stamp}）`);

phase("编译源码");
const sources = readdirSync(SRC)
  .filter((f) => f.endsWith(".cs"))
  .map((f) => join(SRC, f));
if (!sources.length) die("standalone-cs 里没有 .cs");
const args = [
  "/nologo",
  "/platform:x64",
  debug ? "/target:exe" : "/target:winexe",
  "/optimize+",
  "/win32manifest:" + join(SRC, "app.manifest"),
  "/win32icon:" + ICO,
  "/resource:" + PAYLOAD + ",Ojingjing.payload.zip",
  "/out:" + join(OUT, "Ojingjing.exe"),
  ...REF.filter((r) => r.includes("\\") || r.endsWith(".dll")).map((r) => "/r:" + r),
  ...sources,
];
try {
  const log = execFileSync(CSC, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (log.trim()) console.log(log.trim());
} catch (err) {
  const out = `${err.stdout || ""}${err.stderr || ""}`;
  console.error(out.trim());
  die("csc 编译失败");
}

phase("拷运行期依赖");
for (const f of sdkFiles) copyFileSync(join(SDK, f), join(OUT, f));

phase("写启动说明");
writeFileSync(
  join(OUT, "怎么用.txt"),
  [
    "哦鲸鲸 · C# 外壳（WebView2）",
    "",
    "双击 Ojingjing.exe 就能用：页面本体已经打进 exe，不装插件、不开 DSH 也是完整界面（离线态）。",
    "DSH 开着的话，启动几秒内会自动连上 127.0.0.1:<port> 的插件页面，换成带真实数据的那版；",
    "DSH 关掉之后页面留在原地，球变黑白，点球照样能开面板。",
    "",
    "设置与窗口位置读 %APPDATA%\\ojingjing\\settings.json 与 window.json；",
    "写不进去时（安全软件拦进程写 AppData）自动退到 exe 旁边的 data\\ 目录，日志也在那儿。",
    "内置页面解包在同一目录的 web\\ 下（按版本分子目录，可随时删）。",
    "",
    "需要系统里有 Microsoft Edge WebView2 运行时（Win10/11 一般自带）。",
    "调试用：设环境变量 XJ_DEBUG_PORT=9464 再启动，可用 Chrome DevTools 协议连页面。",
    "",
  ].join("\r\n"),
  "utf8",
);

phase("盘点");
let total = 0;
for (const f of readdirSync(OUT)) {
  const size = statSync(join(OUT, f)).size;
  total += size;
  console.log(`   ${f.padEnd(34)} ${(size / 1024).toFixed(0).padStart(6)} KB`);
}
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
console.log(`\n✓ 完成：${OUT}`);
console.log(`  合计 ${(total / 1024 / 1024).toFixed(2)} MB（插件版本 ${pkg.version}）`);
