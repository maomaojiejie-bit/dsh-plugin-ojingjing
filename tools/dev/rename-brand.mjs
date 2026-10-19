// 一次性改名：哦鲸鲸 → 哦鲸鲸 / ojingjing → ojingjing
// 用法：node tools/rename-brand.mjs [--dry]
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const DRY = process.argv.includes("--dry");
const SKIP_DIR = /(^|[\\/])(dist|node_modules|\.shots|\.venv|\.git)([\\/]|$)/;
const SKIP_PATH = /plugin[\\/]web[\\/]static/;
const EXT = new Set([".js", ".mjs", ".css", ".html", ".py", ".md", ".json", ".cmd", ".yml", ".txt"]);

const files = [];
(function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIR.test(full) || SKIP_PATH.test(full)) continue;
      walk(full);
      continue;
    }
    if (EXT.has(path.extname(entry.name).toLowerCase())) files.push(full);
  }
})(ROOT);

const pairs = [
  ["OJINGJING", "OJINGJING"],
  ["Ojingjing", "Ojingjing"],
  ["ojingjing", "ojingjing"],
  ["哦鲸鲸", "哦鲸鲸"],
];

let changed = 0;
const hitCount = new Map();
for (const file of files) {
  const before = fs.readFileSync(file, "utf8");
  let after = before;
  for (const [from, to] of pairs) {
    if (!after.includes(from)) continue;
    const n = after.split(from).length - 1;
    hitCount.set(from, (hitCount.get(from) || 0) + n);
    after = after.split(from).join(to);
  }
  if (after !== before) {
    changed += 1;
    if (!DRY) fs.writeFileSync(file, after, "utf8");
    console.log((DRY ? "[dry] " : "") + path.relative(ROOT, file));
  }
}
console.log("---");
console.log("files:", files.length, "changed:", changed);
for (const [k, v] of hitCount) console.log(`  ${k} → ${v} 处`);
