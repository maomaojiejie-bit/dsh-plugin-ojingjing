/**
 * PyInstaller 产物瘦身：删掉用不到的语言包。
 *
 *   node tools/trim-dist.mjs dist/Ojingjing
 *
 * QtWebEngine 的 qtwebengine_locales 有 60+ 个 .pak（每个 0.5–1.5MB，合计 40MB+），
 * 哦鲸鲸只有中文界面，留 zh-CN / en-US 就够； Chromium 找不到语言包会静默回落英语，
 * 不会崩。spec 里表达不了这个裁剪（hook 整目录拷），所以放构建后处理。
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

/** 保留的语言包（其余全删） */
const KEEP = new Set(["zh-CN.pak", "zh-TW.pak", "en-US.pak", "en-GB.pak"]);

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else yield full;
  }
}

let before = 0;
let after = 0;
let removed = 0;
const hits = [];

for (const file of walk(distDir)) {
  const dir = path.basename(path.dirname(file));
  if (dir !== "qtwebengine_locales" || !file.endsWith(".pak")) continue;
  before += fs.statSync(file).size;
  if (KEEP.has(path.basename(file))) {
    after += fs.statSync(file).size;
    continue;
  }
  hits.push(file);
}

if (!hits.length) {
  console.log("没找到 qtwebengine_locales/*.pak（目录名或结构变了？），什么都没动");
  process.exit(0);
}

for (const file of hits) {
  try {
    fs.rmSync(file, { force: true });
    removed += 1;
  } catch (err) {
    console.error(`删不掉（跳过）：${file} — ${err.message}`);
  }
}

console.log(`qtwebengine_locales：删 ${removed} 个语言包，${((before - after) / 1024 / 1024).toFixed(1)} MB → ${(after / 1024 / 1024).toFixed(1)} MB`);
