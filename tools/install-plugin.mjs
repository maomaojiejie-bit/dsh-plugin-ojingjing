/**
 * 安装 / 卸载「哦鲸鲸」DSH 插件（desktop profile）。
 *
 *   node tools/install-plugin.mjs              安装（复制 + 登记 bundles）
 *   node tools/install-plugin.mjs --uninstall  卸载（删目录 + 去登记）
 *
 * 不碰 profile 的其它依赖；改动 package.json 前会留一份 .bak-<时间戳> 备份。
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const NAME = "dsh-plugin-ojingjing";

const PROFILE = path.join(os.homedir(), ".dsh", "profiles", "desktop");
const MANIFEST = path.join(PROFILE, "package.json");
const TARGET = path.join(PROFILE, "node_modules", NAME);
// 宿主插件按这份配置去拉起独立窗（DSH 启动 → 哦鲸鲸自动出现）
const SHELL_CONFIG = path.join(os.homedir(), ".dsh", "ojingjing-shell.json");

// 改名前的旧包名：install 时顺手清掉旧目录/旧登记/旧 shell 配置，避免两个插件同时被加载
const LEGACY = ["dsh-plugin-xiaojing"];
const LEGACY_SHELL = path.join(os.homedir(), ".dsh", "xiaojing-shell.json");

const uninstall = process.argv.includes("--uninstall");

if (!fs.existsSync(MANIFEST)) {
  console.error(`找不到 desktop profile：${MANIFEST}`);
  process.exit(1);
}

function writeShellConfig() {
  // 只有 C# 外壳一种（PySide6 那套 2026-10-21 已整条退役）
  const csExe = path.join(ROOT, "dist", "Ojingjing-CS", "Ojingjing.exe");
  const payload = {
    exe: csExe,
    workDir: path.dirname(csExe),
    autoLaunch: true,
    note: "由 tools/install-plugin.mjs 生成；插件在 DSH 启动时按这里拉起独立窗（C# 外壳）。删掉本文件或把 autoLaunch 改 false 即可关掉自动启动。",
  };
  fs.writeFileSync(SHELL_CONFIG, JSON.stringify(payload, null, 2) + "\n", "utf8");
  return payload;
}

/* ------------------------------ manifest ------------------------------ */
const raw = fs.readFileSync(MANIFEST, "utf8");
const manifest = JSON.parse(raw);
const bundles = (manifest.dsh && manifest.dsh.profile && manifest.dsh.profile.bundles) || [];
const has = bundles.includes(NAME);

if (uninstall) {
  const keep = bundles.filter((b) => b !== NAME && !LEGACY.includes(b));
  if (keep.length !== bundles.length) {
    manifest.dsh.profile.bundles = keep;
    fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  }
  for (const name of [NAME, ...LEGACY]) {
    fs.rmSync(path.join(PROFILE, "node_modules", name), { recursive: true, force: true });
  }
  fs.rmSync(SHELL_CONFIG, { force: true });
  fs.rmSync(LEGACY_SHELL, { force: true });
  console.log(`已卸载 ${NAME}（含旧包名 ${LEGACY.join("、")}）；bundles 已移除，自动拉起配置也删了。重启 DSH 后生效。`);
  process.exit(0);
}

/* ------------------------------ 安装 ------------------------------ */
// 包根就是仓库根：只复制 package.json 的 files 白名单，app/ docs/ tools/ 等不进 profile
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const FILES = ["package.json", ...(pkg.files || [])];

if (!fs.existsSync(path.join(ROOT, "web", "app.html"))) {
  console.error("缺少 web/app.html，先跑 node tools/build-plugin.mjs");
  process.exit(1);
}

const stamp = new Date()
  .toISOString()
  .replace(/[-:T]/g, "")
  .slice(0, 14);
fs.writeFileSync(path.join(PROFILE, `package.json.bak-${stamp}`), raw, "utf8");

// 旧包名的残留（改了包名后第一次安装会用到）
for (const name of LEGACY) {
  const stale = path.join(PROFILE, "node_modules", name);
  if (fs.existsSync(stale)) {
    fs.rmSync(stale, { recursive: true, force: true });
    console.log(`已清理改名前的旧插件目录：${stale}`);
  }
}
if (fs.existsSync(LEGACY_SHELL)) fs.rmSync(LEGACY_SHELL, { force: true });

fs.rmSync(TARGET, { recursive: true, force: true });
fs.mkdirSync(TARGET, { recursive: true });
for (const entry of FILES) {
  const from = path.join(ROOT, entry);
  if (!fs.existsSync(from)) {
    console.error(`files 白名单里的 ${entry} 不存在，安装中止`);
    process.exit(1);
  }
  fs.cpSync(from, path.join(TARGET, entry), { recursive: true });
}
console.log(`已复制 ${FILES.length} 项：${FILES.join("、")}`);

const cleaned = bundles.filter((b) => !LEGACY.includes(b));
if (!cleaned.includes(NAME)) {
  const i = cleaned.indexOf("dsh-whale-widget");
  cleaned.splice(i >= 0 ? i + 1 : cleaned.length, 0, NAME);
}
manifest.dsh.profile.bundles = cleaned;
fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + "\n", "utf8");

console.log(`已安装到 ${TARGET}`);
console.log(`已登记 bundles（备份 package.json.bak-${stamp}）`);

const shellCfg = writeShellConfig();
console.log(`自动拉起配置：${SHELL_CONFIG}`);
// 只有 C# 外壳一种（PySide6 那套 2026-10-21 已整条退役），不再有目录 + 解释器候选的分支
if (shellCfg.exe) console.log(`  外壳程序 ${shellCfg.exe}（C# 外壳）`);
console.log("重启 DeepSeek Harness Desktop 后生效：DSH 起来时若哦鲸鲸没在跑，插件会自动拉起它。");
