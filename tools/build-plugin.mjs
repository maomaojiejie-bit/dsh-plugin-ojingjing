/**
 * 把哦鲸鲸原型打包成 DSH 插件可用的静态资源。
 *
 * 输入：../app/index.html、../app/src/**（原型本体，唯一源）
 * 输出：../web/app.html、../web/static/src/**（插件包根目录即仓库根）
 *
 * 做五件事：
 *   1. 相对路径换成 /xj/static/...，挂上 embed.css / embed.js；
 *   2. embed 剥离：原型专用文件（mock.js / devbar.js）不进插件包
 *      （app.js 里 devbar 调用点有 XJ.embed 守卫；XJ.mock 命名空间由 embed.js 兜底）；
 *   3. minify：JS/CSS 过 esbuild（可选依赖，找不到 / XJ_NO_MINIFY=1 就原样拷贝）；
 *   4. 演示桌面元素标记 data-remove-in-embed；
 *   5. 把 package.json 的 version 注入成 window.__XJ_BUILD__（设置里检查更新要用）。
 *
 * 独立窗（standalone-cs）不打这里的主意：它由 tools/build-shell-cs.mjs 把整个 web/ 压进 exe。
 *
 * 原型本身零改动，`file://` 打开仍然可用（原型永远用 app/src 的未压缩原件）。
 *
 * esbuild 查找顺序：$XJ_ESBUILD → 受管 node workspace（本机）→ 仓库 node_modules。
 * 本机装法：cd %USERPROFILE%\.workbuddy\binaries\node\workspace && npm install esbuild
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const APP = path.join(ROOT, "app");
const SRC = path.join(APP, "src");
const WEB = path.join(ROOT, "web");
const STATIC = path.join(WEB, "static");

/** 原型专用：插件 / 独立窗不打包（embed 态有守卫，见 embed.js 的 XJ.mock 兜底注释） */
const PROTOTYPE_ONLY = new Set(["mock.js", "devbar.js"]);

/** 不 minify 的：位图 / 已经是单串 data URI 的（minify 没有收益还徒增风险） */
const NO_MINIFY = new Set(["avatar.js", "avatar.webp", "icon.png", "icons.svg"]);

const ESBUILD_CANDIDATES = [
  process.env.XJ_ESBUILD,
  path.join(os.homedir(), ".workbuddy", "binaries", "node", "workspace", "node_modules", "esbuild", "bin", "esbuild"),
  path.join(ROOT, "node_modules", "esbuild", "bin", "esbuild"),
].filter(Boolean);

/* 原生 esbuild.exe 优先：`node <cli 垫片>` 要起子进程，受限环境（沙箱、某些 CI）里
   spawn 会被拒绝，结果整批文件悄悄退回未压缩拷贝——插件包白胖一圈还不报错。
   直接 exec .exe 就没有这层依赖。 */
const ESBUILD_PLATFORM_PKGS = ["win32-x64", "win32-arm64", "win32-ia32", "linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64"];
const NATIVE_CANDIDATES = ESBUILD_PLATFORM_PKGS.flatMap((plat) =>
  [
    path.join(os.homedir(), ".workbuddy", "binaries", "node", "workspace", "node_modules", "@esbuild", plat),
    path.join(ROOT, "node_modules", "@esbuild", plat),
  ].map((dir) => path.join(dir, process.platform === "win32" ? "esbuild.exe" : "esbuild"))
);

function findEsbuild() {
  if (process.env.XJ_NO_MINIFY) return null;
  for (const p of NATIVE_CANDIDATES) {
    try {
      if (fs.existsSync(p)) return { bin: p, native: true };
    } catch {}
  }
  for (const p of ESBUILD_CANDIDATES) {
    try {
      if (fs.existsSync(p)) return { bin: p, native: false };
    } catch {}
  }
  return null;
}

fs.rmSync(STATIC, { recursive: true, force: true });
fs.mkdirSync(path.join(STATIC, "src"), { recursive: true });

const esbuild = findEsbuild();
let copied = 0;
let minified = 0;
let saved = 0;
let skipped = 0;
const minifyFailures = [];

for (const name of fs.readdirSync(SRC)) {
  if (!/\.(js|css|svg|png|webp|woff2)$/.test(name)) continue;
  if (PROTOTYPE_ONLY.has(name)) {
    skipped += 1;
    continue;
  }
  const from = path.join(SRC, name);
  const to = path.join(STATIC, "src", name);
  if (esbuild && /\.(js|css)$/.test(name) && !NO_MINIFY.has(name)) {
    try {
      const args = [from, "--minify", `--outfile=${to}`, "--log-level=warning"];
      /* stdio 用 inherit，不要 "pipe"：受限环境（DSH 沙箱）下 Node 起子进程时
         管道会开命名管道，权限不够直接 EPERM，于是整批文件悄悄退回未压缩拷贝。
         inherit 不建管道，沙箱里也能跑；esbuild 出错时它自己会往 stderr 打。 */
      if (esbuild.native) execFileSync(esbuild.bin, args, { stdio: "inherit" });
      else execFileSync(process.execPath, [esbuild.bin, ...args], { stdio: "inherit" });
      minified += 1;
      saved += Math.max(0, fs.statSync(from).size - fs.statSync(to).size);
      copied += 1;
      continue;
    } catch (err) {
      minifyFailures.push(`${name}（${err.message.split("\n")[0]}）`);
    }
  }
  fs.copyFileSync(from, to);
  copied += 1;
}

let html = fs.readFileSync(path.join(APP, "index.html"), "utf8");
html = html.replace(/(href|src)="src\//g, '$1="/xj/static/src/');
// embed 剥离：mock.js / devbar.js 的 <script> 整行删掉（含前导空白，别留空行）
html = html.replace(/[ \t]*<script src="\/xj\/static\/src\/(?:mock|devbar)\.js"><\/script>\n?/g, "");
html = html.replace(
  '<link rel="stylesheet" href="/xj/static/src/styles.css" />',
  '<link rel="stylesheet" href="/xj/static/src/styles.css" />\n    <link rel="stylesheet" href="/xj/embed.css" />'
);
html = html.replace(
  '<script src="/xj/static/src/app.js"></script>',
  '<script src="/xj/embed.js"></script>\n    <script src="/xj/static/src/app.js"></script>'
);
html = html.replace(/<title>[^<]*<\/title>/, "<title>哦鲸鲸 · 悬浮窗</title>");
html = html.replace(
  '<div class="desktop-hint">',
  '<div class="desktop-hint" data-remove-in-embed="1">'
);
/* 版本号打进去：设置里的「检查更新」拿它跟 GitHub 的 release 比。
   页面自己也有一份兜底（0.4.0），但那份写在代码里，bump 版本时准忘——
   这里每次构建都从 package.json 现读，页面永远说真话。 */
const PKG_VERSION = String(JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version || "");
html = html.replace(
  '<script src="/xj/embed.js"></script>',
  `<script>window.__XJ_BUILD__ = ${JSON.stringify({ version: PKG_VERSION, built_at: new Date().toISOString() })};</script>\n    <script src="/xj/embed.js"></script>`
);

fs.writeFileSync(path.join(WEB, "app.html"), html, "utf8");

console.log(`web/app.html   ← app/index.html`);
console.log(`web/static/src ← ${copied} 个文件（剥离原型专用 ${skipped} 个：${[...PROTOTYPE_ONLY].join(" / ")}）`);
if (esbuild) {
  console.log(`minify         ← esbuild(${esbuild.native ? "native" : "cli"}) 压缩 ${minified} 个，省 ${(saved / 1024).toFixed(1)} KB`);
  // 失败不再逐个刷屏，但也不能装作没事：退回未压缩是「能跑但白胖」，得让人看得见
  if (minifyFailures.length) {
    console.warn(`[build-plugin] ${minifyFailures.length} 个文件压缩失败，已按原样拷贝：`);
    for (const line of minifyFailures) console.warn(`  · ${line}`);
  }
} else {
  console.log(`minify         ← 跳过（没找到 esbuild；装：cd %USERPROFILE%\\.workbuddy\\binaries\\node\\workspace && npm install esbuild）`);
}
