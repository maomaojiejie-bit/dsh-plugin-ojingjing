/**
 * 打一个可分发的包：只拷「要交付的东西」，把 .venv / 日志 / 临时产物都排除掉。
 *
 * 用法：
 *   node tools/pack.mjs                 # 生成 dist/pack/ojingjing-widget/ 并打印清单
 *   node tools/pack.mjs --zip           # 另外压成 dist/ojingjing-widget-<日期>.zip
 *
 * 为什么不用「整目录打包」：standalone-py/.venv 有 600MB+，docs/screenshots 有 15MB，
 * 里面大量是本地调试产物。这里用白名单，避免把不该给的东西带出去。
 */
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const outDir = join(root, "dist", "pack", "ojingjing-widget");

// 根目录下的单文件（插件包清单 + 文档）
const FILES = [
  "package.json",
  "cordis.patch.yml",
  "README.md",
  "PLUGIN.md",
  "LICENSE",
  ".gitignore",
];

// 目录（整份拷，排除规则见 SKIP）
const DIRS = ["app", "assets", "lib", "web", "tools", "standalone-py"];

// 另外单独挑的文件：相对 root → 相对 outDir
const EXTRA = [
  ["dist/dsh-plugin-ojingjing-0.4.0.tgz", "dist/dsh-plugin-ojingjing-0.4.0.tgz"],
];

// 任何层级都跳过的东西
const SKIP = new Set([
  ".venv",
  "__pycache__",
  "node_modules",
  "dist", // 构建产物，只挑 tgz
  ".shots",
  "data", // 运行期状态（settings.json 里可能有 API key、还有 pid/窗口位置）

  "out.txt",
  "err.txt",
  "ojingjing-py.log",
  "pip-build-tracker",
  "session.jsonl",
]);

function skip(name) {
  if (SKIP.has(name)) return true;
  if (name.startsWith("pip-")) return true;
  if (name.endsWith(".log")) return true;
  return false;
}

function copyTree(from, to) {
  for (const name of readdirSync(from)) {
    if (skip(name)) continue;
    const src = join(from, name);
    const dst = join(to, name);
    if (statSync(src).isDirectory()) {
      mkdirSync(dst, { recursive: true });
      copyTree(src, dst);
    } else {
      cpSync(src, dst);
    }
  }
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

for (const f of FILES) {
  if (existsSync(join(root, f))) cpSync(join(root, f), join(outDir, f));
}
for (const d of DIRS) {
  if (!existsSync(join(root, d))) continue;
  mkdirSync(join(outDir, d), { recursive: true });
  copyTree(join(root, d), join(outDir, d));
}
for (const [from, to] of EXTRA) {
  const src = join(root, from);
  if (!existsSync(src)) continue;
  mkdirSync(dirname(join(outDir, to)), { recursive: true });
  cpSync(src, join(outDir, to));
}

// 截图（docs/screenshots 里都是评审图，整份带走）
const shotSrc = join(root, "docs", "screenshots");
const shotDir = join(outDir, "screenshots");
if (existsSync(shotSrc)) {
  mkdirSync(shotDir, { recursive: true });
  for (const name of readdirSync(shotSrc)) {
    if (/\.(png|jpg|webp)$/i.test(name)) cpSync(join(shotSrc, name), join(shotDir, name));
  }
}

// 包说明：告诉收件人从哪开始
writeFileSync(
  join(outDir, "PACK.md"),
  `# 哦鲸鲸 · 交付包

| 想做什么 | 从哪开始 |
|---|---|
| 只想点点看原型（不装任何东西） | 双击 \`app/index.html\`，看 \`README.md\` 的「怎么玩」 |
| 装进 DSH（真数据，独立桌面窗） | \`PLUGIN.md\` → \`node tools/install-plugin.mjs\` → 重启 DSH |
| 分发给别人的 npm 包 | \`dist/dsh-plugin-ojingjing-0.4.0.tgz\`（\`npm i\` 这个文件，再登记 bundles） |
| 要独立置顶的桌面窗 | \`standalone-py/README.md\`（需要 Python + PySide6） |
| 换角色形象 / 图标 | \`README.md\` 的「外观（自定义头像 / 背景）」 |
| 看设计稿逐条对照 | \`README.md\` 的「对应设计稿的实现情况」 |

截图在 \`screenshots/\`。\`.venv\` 没有打进来（太大）；包根的 \`package.json\` + \`cordis.patch.yml\` +
\`lib/\` + \`web/\` 就是可安装的 DSH 插件包，\`web/static\` 由 \`node tools/build-plugin.mjs\` 现场生成。
`,
);

// 清单
let count = 0;
let bytes = 0;
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p);
    else {
      count += 1;
      bytes += st.size;
    }
  }
})(outDir);
console.log(`打包目录：${relative(root, outDir)}  ${count} 个文件，${(bytes / 1048576).toFixed(1)} MB`);

if (process.argv.includes("--zip")) {
  const stamp = new Date().toISOString().slice(0, 10);
  const zipPath = join(root, "dist", `ojingjing-widget-${stamp}.zip`);
  rmSync(zipPath, { force: true });
  // 用系统自带 bsdtar 打 zip：比 Compress-Archive 快，且不依赖 PowerShell 控制台
  execFileSync("tar", ["-a", "-c", "-f", zipPath, "-C", outDir, "."], { stdio: "inherit" });
  console.log(`压缩包：${relative(root, zipPath)}  ${(statSync(zipPath).size / 1048576).toFixed(1)} MB`);
}
