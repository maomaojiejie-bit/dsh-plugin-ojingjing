/**
 * PyInstaller 产物瘦身：删掉运行时永远用不到的文件。
 *
 *   node tools/trim-dist.mjs dist/Ojingjing
 *
 * PyInstaller 的 PySide6 hook 是「整目录拷」，一口气搬来 400MB，其中一大半这棵树
 * 一辈子不会读。spec 里表达不了这种裁剪（hook 无视 datas/excludes），所以放构建后处理。
 * 每条规则都写清楚「为什么可以删」，删错了 exe 是起不来的，所以下面只放可证明的：
 *
 *   1. qtwebengine_locales/*.pak —— Chromium 的界面语言包。哦鲸鲸只有中文，
 *      留 zh-CN / zh-TW / en-US / en-GB，找不到语言包会静默回落英语，不会崩。
 *   2. resources/*.debug.pak —— Chromium 资源包的调试版（几百 KB 到 72MB 的 devtools
 *      debug pak），只有 --enable-logging + devtools 调试才读，正式包不需要。
 *   3. resources/v8_context_snapshot.debug.bin —— V8 快照的调试版，同上。
 *   4. resources/qtwebengine_devtools_resources.pak —— 开发者工具的前端 UI。
 *      发行版不开放 devtools；要在 exe 里调页面就构建 OjingjingDebug.spec。
 *   5. translations/*.qm —— Qt 自己的界面翻译（QMessageBox 之类）。哦鲸鲸的界面是
 *      HTML，Qt 只画一个原生设置对话框，字号/文案全写死中文。
 *
 * 不删的两样（都很诱人，但风险不对等）：
 *   - opengl32sw.dll（19.7MB）：软件光栅兜底。机器没有可用 D3D11 时 Qt 靠它活着。
 *   - icudtl.dat（10MB）：ICU 数据，Chromium 处理中文/编码离不开。
 */
import fs from "node:fs";
import path from "node:path";

const distDir = process.argv[2];
if (!distDir) {
  console.error("用法：node tools/trim-dist.mjs <dist目录>");
  process.exit(1);
}
if (!fs.existsSync(distDir)) {
  console.error(`目录不存在：${distDir}`);
  process.exit(1);
}

/** 保留的 Chromium 语言包（其余全删） */
const KEEP_LOCALES = new Set(["zh-CN.pak", "zh-TW.pak", "en-US.pak", "en-GB.pak"]);

/** 规则表：match 命中即删，keep 存在时先看 keep */
const RULES = [
  {
    id: "locales",
    why: "Chromium 语言包",
    dir: "qtwebengine_locales",
    keep: (name) => KEEP_LOCALES.has(name),
    match: (name) => name.endsWith(".pak"),
  },
  {
    id: "debug-pak",
    why: "Chromium 调试资源包",
    dir: "resources",
    match: (name) => name.endsWith(".debug.pak"),
  },
  {
    id: "debug-bin",
    why: "V8 快照调试版",
    dir: "resources",
    match: (name) => name.endsWith(".debug.bin"),
  },
  {
    id: "devtools",
    why: "开发者工具前端（发行版不用）",
    dir: "resources",
    match: (name) => name === "qtwebengine_devtools_resources.pak",
  },
  {
    id: "qt-i18n",
    why: "Qt 界面翻译（界面是 HTML）",
    dir: "translations",
    match: (name) => name.endsWith(".qm"),
  },
];

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else yield full;
  }
}

const report = new Map(); // id -> { count, bytes }
let totalBytes = 0;
let totalFiles = 0;
let keptBytes = 0;

for (const file of walk(distDir)) {
  const dirName = path.basename(path.dirname(file));
  const name = path.basename(file);
  const rule = RULES.find((r) => r.dir === dirName && r.match(name));
  if (!rule) continue;

  const size = fs.statSync(file).size;
  if (rule.keep && rule.keep(name)) {
    keptBytes += size;
    continue;
  }

  try {
    fs.rmSync(file, { force: true });
  } catch (err) {
    console.error(`删不掉（跳过）：${file} — ${err.message}`);
    continue;
  }
  const slot = report.get(rule.id) ?? { why: rule.why, count: 0, bytes: 0 };
  slot.count += 1;
  slot.bytes += size;
  report.set(rule.id, slot);
  totalFiles += 1;
  totalBytes += size;
}

if (!totalFiles) {
  console.log("没命中任何瘦身规则（目录结构变了？），什么都没动");
} else {
  for (const [id, slot] of report) {
    console.log(`${id.padEnd(10)} 删 ${String(slot.count).padStart(2)} 个，省 ${(slot.bytes / 1024 / 1024).toFixed(1)} MB —— ${slot.why}`);
  }
  console.log(`合计省 ${(totalBytes / 1024 / 1024).toFixed(1)} MB（${totalFiles} 个文件），语言包保留 ${(keptBytes / 1024 / 1024).toFixed(1)} MB`);
}
