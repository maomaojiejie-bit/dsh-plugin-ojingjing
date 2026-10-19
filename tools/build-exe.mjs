#!/usr/bin/env node
/**
 * 打独立窗的 Windows 分发版（PyInstaller onedir + 语言包裁剪），一条龙。
 *
 *   node tools/build-exe.mjs              # 正式版 → dist/Ojingjing/
 *   node tools/build-exe.mjs --debug      # 调试版（带控制台）→ dist/OjingjingDebug/
 *   node tools/build-exe.mjs --no-trim    # 不裁语言包
 *   node tools/build-exe.mjs --dry-run    # 只打印将执行的命令
 *
 * 解释器怎么选（两种都等价，装包时装的就是 venv 的 site-packages）：
 *   1. standalone-py/.venv 的 python —— 要能 import PySide6 + PyInstaller；
 *   2. 回退：系统 Python + PYTHONPATH 指向同一个 site-packages。
 *      （venv 建坏 / python.exe 起不来时走这条，import 探测会告诉它该走哪条。）
 * PyInstaller 没装时自动 pip install --no-cache-dir 补上，不劳用户手动。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const SHELL_DIR = path.join(ROOT, "standalone-py");
const SITE = path.join(SHELL_DIR, ".venv", "Lib", "site-packages");

const argv = process.argv.slice(2);
const opts = {
  debug: argv.includes("--debug"),
  trim: !argv.includes("--no-trim"),
  dryRun: argv.includes("--dry-run") || argv.includes("-n"),
};

const say = (m = "") => process.stdout.write(m + "\n");
const info = (m) => say(`  ${m}`);
const ok = (m) => say(`  ✓ ${m}`);
const warn = (m) => say(`  ! ${m}`);
const die = (m, code = 1) => {
  process.stdout.write(`\n✗ ${m}\n`);
  process.exit(code);
};

const SPEC = path.join(ROOT, opts.debug ? "OjingjingDebug.spec" : "Ojingjing.spec");
const OUT_NAME = opts.debug ? "OjingjingDebug" : "Ojingjing";
const DIST = path.join(ROOT, "dist", OUT_NAME);
const WORK = path.join(ROOT, "build");

say(`哦鲸鲸 · 打 Windows 分发版（${OUT_NAME}）`);
if (opts.dryRun) say("（dry-run：只打印，不执行）");

if (!fs.existsSync(SPEC)) die(`缺少 ${SPEC}`);
if (!fs.existsSync(path.join(SHELL_DIR, "ojingjing_py.py"))) die(`缺少 standalone-py/ojingjing_py.py`);

/* ---------------------------------------------------------------- 解释器 */

let probeSeq = 0;
/** 探测解释器能否 import PySide6 + PyInstaller。输出走临时文件：管道在受限环境里会 EPERM。 */
function probeImports(py, extraEnv) {
  const tmp = path.join(os.tmpdir(), `xj-exe-probe-${process.pid}-${(probeSeq += 1)}.log`);
  let fd = "ignore";
  try {
    fd = fs.openSync(tmp, "w");
  } catch {
    /* 落不了盘就只靠退出码 */
  }
  const r = spawnSync(py, ["-c", "import PySide6.QtWebEngineWidgets, PyInstaller"], {
    stdio: ["ignore", fd, fd],
    windowsHide: true,
    env: { ...process.env, ...(extraEnv || {}) },
  });
  if (fd !== "ignore") {
    try {
      fs.closeSync(fd);
    } catch {
      /* ignore */
    }
  }
  let out = "";
  try {
    out = fs.readFileSync(tmp, "utf8").trim();
  } catch {
    /* ignore */
  }
  try {
    fs.rmSync(tmp, { force: true });
  } catch {
    /* ignore */
  }
  return { ok: r.status === 0, out };
}

const venvPy = path.join(SHELL_DIR, ".venv", "Scripts", "python.exe");
const systemPys = [
  path.join(process.env.LOCALAPPDATA ?? "", "Programs", "Python", "Python312", "python.exe"),
  "python.exe",
  "py.exe",
].filter(Boolean);

let py = null;
let pyEnv = {};
let pyFrom = "";

if (fs.existsSync(venvPy)) {
  const r = probeImports(venvPy);
  if (r.ok) {
    py = venvPy;
    pyFrom = "venv";
    ok(`解释器：venv python（${venvPy}）`);
  } else {
    warn(`venv python 起不来或缺依赖：${r.out.split(/\r?\n/).pop() || "（无输出）"}`);
  }
}
if (!py) {
  // 回退：系统 Python + PYTHONPATH。PySide6 在、只缺 PyInstaller 时自动补装到同一个 site-packages。
  for (const cand of systemPys) {
    const withPath = { PYTHONPATH: SITE };
    const r1 = probeImports(cand, withPath);
    if (r1.ok) {
      py = cand;
      pyEnv = withPath;
      pyFrom = "系统 Python + PYTHONPATH";
      ok(`解释器：${cand} + PYTHONPATH=${path.relative(ROOT, SITE)}`);
      break;
    }
    const rPyside = spawnSync(cand, ["-c", "import PySide6.QtWebEngineWidgets"], {
      stdio: "ignore",
      windowsHide: true,
      env: { ...process.env, ...withPath },
    });
    if (rPyside.status === 0) {
      info("缺 PyInstaller，自动补装（pip install --no-cache-dir pyinstaller）");
      const inst = spawnSync(cand, ["-m", "pip", "install", "--no-cache-dir", "-q", "pyinstaller"], {
        stdio: "inherit",
        windowsHide: true,
        cwd: ROOT,
      });
      if (inst.status !== 0) die("pyinstaller 补装失败，看上面的 pip 输出");
      const r3 = probeImports(cand, withPath);
      if (r3.ok) {
        py = cand;
        pyEnv = withPath;
        pyFrom = "系统 Python + PYTHONPATH（已补装 pyinstaller）";
        ok(`解释器：${cand} + PYTHONPATH=${path.relative(ROOT, SITE)}`);
        break;
      }
    }
  }
}
if (!py) {
  die(
    [
      "找不到能 import PySide6 + PyInstaller 的解释器。两条路：",
      "  1) 重建 venv：node tools/install.mjs（第 5 步会装 PySide6）",
      "  2) 手动补 PyInstaller：",
      `     "<venv>\\Scripts\\python.exe" -m pip install --no-cache-dir pyinstaller`,
    ].join("\n"),
  );
}

/* ---------------------------------------------------------------- 构建 */

const pyiArgs = [
  "-m",
  "PyInstaller",
  "--noconfirm",
  "--clean",
  "--distpath",
  path.join(ROOT, "dist"),
  "--workpath",
  WORK,
  SPEC,
];
if (opts.dryRun) {
  info(`$ ${py} ${pyiArgs.join(" ")}`);
  if (opts.trim) info(`$ node tools/trim-dist.mjs ${path.relative(ROOT, DIST)}`);
  say("\ndry-run 结束，什么都没改。");
  process.exit(0);
}

say("\n【1/2】PyInstaller 构建（首次约 1–2 分钟）");
const t0 = Date.now();
const build = spawnSync(py, pyiArgs, {
  cwd: ROOT,
  stdio: "inherit",
  windowsHide: true,
  env: { ...process.env, ...pyEnv },
});
if (build.status !== 0) die(`PyInstaller 失败（退出码 ${build.status}）`);
if (!fs.existsSync(path.join(DIST, OUT_NAME + ".exe"))) die(`构建完没看到 ${path.join(path.relative(ROOT, DIST), OUT_NAME + ".exe")}`);
ok(`构建完成（${((Date.now() - t0) / 1000).toFixed(0)}s）`);

say("\n【2/2】裁剪 + 盘点");
if (opts.trim) {
  const trim = spawnSync(process.execPath, [path.join(ROOT, "tools", "trim-dist.mjs"), DIST], {
    cwd: ROOT,
    stdio: "inherit",
    windowsHide: true,
  });
  if (trim.status !== 0) warn("trim-dist 失败了，产物没裁语言包（体积偏大，功能不受影响）");
}

/* ---------------------------------------------------------------- 盘点 */

function dirSize(dir) {
  let sum = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else sum += fs.statSync(p).size;
    }
  };
  walk(dir);
  return sum;
}

const total = dirSize(DIST);
const mb = (total / 1024 / 1024).toFixed(1);
const exe = fs.statSync(path.join(DIST, OUT_NAME + ".exe")).size;
const biggest = [];
const walk = (d, depth) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) {
      const s = dirSize(p);
      if (s > 8 * 1024 * 1024) biggest.push({ p: path.relative(DIST, p), s });
    } else if (fs.statSync(p).size > 8 * 1024 * 1024) {
      biggest.push({ p: path.relative(DIST, p), s: fs.statSync(p).size });
    }
  }
};
walk(DIST, 0);
biggest.sort((a, b) => b.s - a.s);

say("");
say(`产物：${path.relative(ROOT, DIST)}  合计 ${mb} MB`);
info(`exe 本体 ${(exe / 1024 / 1024).toFixed(2)} MB（其余是 QtWebEngine 内核，删不得）`);
for (const b of biggest.slice(0, 6)) info(`  ${(b.s / 1024 / 1024).toFixed(1)} MB  ${b.p}`);
say("");
say("分发：把整个目录拷走即可（绿色软件，无需安装）。");
