#!/usr/bin/env node
/**
 * 一键把「哦鲸鲸」装进 DeepSeek Harness Desktop —— 走官方 `dsh plugin` 命令，不手改 profile。
 *
 *   node tools/install.mjs               全量安装（推荐）
 *   node tools/install.mjs --dry-run     只打印将要执行的命令，不动任何东西
 *
 * 流程（6 步）：
 *   1 环境自检      node / npm / dsh / python 各就位
 *   2 构建前端      node tools/build-plugin.mjs → web/app.html + web/static/src
 *   3 打包插件      npm pack → dist/dsh-plugin-ojingjing-<版本>.tgz
 *   4 装进 DSH      dsh plugin add <tgz>（pnpm 记账，bundles 由 reconcile 自动登记）
 *   5 补齐 Python   standalone-py/.venv 没有就建，PySide6 没装就装（这是独立窗的运行时）
 *   6 自动拉起配置  写 ~/.dsh/ojingjing-shell.json，并回读校验
 *
 * 和 tools/install-plugin.mjs 的关系：那个是「手工复制文件 + 手改 profile/package.json」的老路子，
 * 不需要 dsh、也不需要 pnpm 联网；这个是官方路子，profile 的依赖账本交给 pnpm 维护。
 * 两个都保留：官方命令不可用（比如离线、dsh 不在 PATH）时还能退回老路子。
 *
 * 退出码：0 成功；1 某一步失败；2 参数用错。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

import {
  PACKAGE_NAME,
  LEGACY_PACKAGES,
  PROFILES_DIR,
  ROOT,
  SHELL_DIR,
  SHELL_SCRIPT,
  readShellConfig,
  shellLaunchers,
  stopRunningShell,
  writeShellConfig,
} from "./shell-config.mjs";
import { pluginArgv, runDsh } from "./dsh.mjs";

/* ------------------------------------------------------------------ 参数 */

const USAGE = `用法：node tools/install.mjs [选项]

  --dry-run, -n        只打印将执行的命令，不落盘
  --no-build           跳过前端构建，直接打包现有 web/
  --skip-deps          不碰 standalone-py/.venv（只装插件本体）
  --no-venv            同上，但语义更明确：完全不处理 Python 侧
  --force-deps         即使 PySide6 已就绪也重跑一次 pip install
  --mirror <url|cn>    pip 镜像；cn = 阿里云。等价于 PIP_INDEX_URL
  --no-shell-config    不写自动拉起配置（DSH 启动时不会自动弹独立窗）
  --direct             不用 dsh，直接拷进 profile 并登记 bundles（等不跑 dsh 时的退路）
  --relaunch           装完自动把 DSH Desktop 拉起来（适合关掉 DSH 才装完的场景）
  --profile <name>     目标 profile，默认 desktop
  --dsh <path>         指定 dsh 可执行文件；默认先找 DSH Desktop 的 host-commands shim，再退回 PATH
  -h, --help           看这段`;

const argv = process.argv.slice(2);
const opts = {
  dryRun: false,
  build: true,
  deps: true,
  forceDeps: false,
  mirror: "",
  shellConfig: true,
  direct: false,
  relaunch: false,
  profile: "desktop",
  dsh: "",
};

for (let i = 0; i < argv.length; i += 1) {
  const a = argv[i];
  const next = () => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("-")) die(`选项 ${a} 需要一个值`);
    i += 1;
    return v;
  };
  if (a === "-h" || a === "--help") {
    say(USAGE);
    process.exit(0);
  } else if (a === "--dry-run" || a === "-n") opts.dryRun = true;
  else if (a === "--no-build") opts.build = false;
  else if (a === "--skip-deps" || a === "--no-venv") opts.deps = false;
  else if (a === "--force-deps") opts.forceDeps = true;
  else if (a === "--no-shell-config") opts.shellConfig = false;
  else if (a === "--direct") opts.direct = true;
  else if (a === "--relaunch") opts.relaunch = true;
  else if (a === "--mirror") opts.mirror = next();
  else if (a.startsWith("--mirror=")) opts.mirror = a.slice("--mirror=".length);
  else if (a === "--profile") opts.profile = next();
  else if (a.startsWith("--profile=")) opts.profile = a.slice("--profile=".length);
  else if (a === "--dsh") opts.dsh = next();
  else if (a.startsWith("--dsh=")) opts.dsh = a.slice("--dsh=".length);
  else die(`不认识的选项：${a}（用 --help 看用法）`);

  if (opts.mirror.toLowerCase() === "cn") opts.mirror = "https://mirrors.aliyun.com/pypi/simple/";
}

/* ------------------------------------------------------------------ 输出 */

function say(msg = "") {
  process.stdout.write(msg + "\n");
}
function step(n, total, title) {
  say(`\n【${n}/${total}】${title}`);
}
function info(msg) {
  say(`  ${msg}`);
}
function ok(msg) {
  say(`  ✓ ${msg}`);
}
function warn(msg) {
  say(`  ! ${msg}`);
}
function die(msg, code = 1) {
  process.stdout.write(`\n✗ ${msg}\n`);
  process.exit(code);
}

/* ------------------------------------------------------------ 跑命令 */

const q = (s) => `"${s}"`;

/**
 * 跑一条命令。Windows 下 npm/dsh/pnpm 都是 .cmd，Node 24 起不允许 shell:false 直接 spawn .cmd，
 * 所以统一过 shell，并且把每个参数加引号（本机路径里有「新建文件夹」这种中文，也可能有空格）。
 * stdio 走 inherit，不接管管道：接管管道在受限环境里会 EPERM。
 */
function run(args, { allowFail = false, env = {} } = {}) {
  const line = args.map(q).join(" ");
  if (opts.dryRun) {
    info(`$ ${line}`);
    return { status: 0, out: "" };
  }
  const r = spawnSync(line, {
    shell: true,
    cwd: ROOT,
    encoding: "utf8",
    stdio: "inherit",
    windowsHide: true,
    env: { ...process.env, ...env },
  });
  if (r.error) die(`命令起不来：${line}\n  ${r.error.message}`);
  if (r.status !== 0 && !allowFail) {
    die(`命令失败（退出码 ${r.status}）：\n  ${line}`);
  }
  return { status: r.status ?? 1, out: "" };
}

/**
 * 只想知道某条命令能不能跑通（探测解释器、探测 dsh）。输出落到临时文件而不是管道：
 * 管道在沙箱/受限终端里可能 EPERM，临时文件两边都能用。
 */
let probeSeq = 0;
function probe(args) {
  const line = args.map(q).join(" ");
  if (opts.dryRun) {
    info(`$ ${line}`);
    return { ok: true, out: "", dry: true };
  }
  const tmp = path.join(os.tmpdir(), `xj-probe-${process.pid}-${(probeSeq += 1)}.log`);
  let fd = "ignore";
  try {
    fd = fs.openSync(tmp, "w");
  } catch {
    /* 落不了盘就只靠退出码 */
  }
  const r = spawnSync(line, {
    shell: true,
    cwd: ROOT,
    stdio: ["ignore", fd, fd],
    windowsHide: true,
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
  return { ok: r.status === 0, out, error: r.error };
}

/** 取多行输出的最后一行非空内容（探针常把版本打在最后一行）。 */
function lastLine(text) {
  return String(text ?? "")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
    .pop() ?? "";
}

/**
 * 按 PATH + PATHEXT 找可执行文件，纯 JS 扫目录，不起子进程。
 * 比 where.exe 可靠：受限环境里 spawn 捕获输出会 EPERM，而这里根本不需要 spawn。
 */
function which(names) {
  const exts = (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  for (const name of names) {
    const lower = name.toLowerCase();
    const styled = exts.some((e) => lower.endsWith(e.toLowerCase()));
    for (const dir of dirs) {
      const base = path.join(dir, name);
      const tries = styled ? [base] : [base, ...exts.map((e) => base + e.toLowerCase()), ...exts.map((e) => base + e)];
      for (const candidate of tries) {
        try {
          if (fs.statSync(candidate).isFile()) return candidate;
        } catch {
          /* 没这个文件，继续 */
        }
      }
    }
  }
  return null;
}

/**
 * DSH Desktop 是不是正开着。开着的话 profile 被它独占锁住，dsh plugin add 会失败，
 * 所以在花时间构建/打包之前就先告诉用户。
 */
function isDshRunning() {
  const r = probe(["tasklist", "/FI", "IMAGENAME eq DSH Desktop.exe", "/NH"]);
  if (!r.ok) return null; // 探测不出来就返回未知，不要瞎断言
  return /DSH Desktop\.exe/i.test(r.out);
}

/**
 * 读最近一次 pnpm 操作的日志（plugin-manager 会把每次 add/remove 的输出留在
 * `<profile>/.plugin-manager/logs/operation-<id>/pnpm.log`）。
 * pnpm 失败时真正的报错只在这份日志里 —— 外面看到的往往只有一句 exit code 1。
 */
function lastPnpmLog(profileDir) {
  const logs = path.join(profileDir, ".plugin-manager", "logs");
  try {
    const newest = fs
      .readdirSync(logs)
      .map((name) => path.join(logs, name, "pnpm.log"))
      .filter((p) => fs.existsSync(p))
      .map((p) => ({ p, t: fs.statSync(p).mtimeMs }))
      .sort((a, b) => b.t - a.t)[0];
    if (!newest) return null;
    const text = fs.readFileSync(newest.p, "utf8").trim();
    return { file: newest.p, text: text || "（这次操作 pnpm 什么都没输出）" };
  } catch {
    return null;
  }
}

/**
 * DSH Desktop 自己生成的 dsh shim（host-commands/generations/<hash>/bin/dsh.cmd）。
 * 它带 `runCli({ manageDesktopProfile: true })`，是唯一被允许操作 desktop profile 的入口。
 * 每次 DSH 启动会生成新的一代，所以取最新那个。
 */
function desktopDshShim() {
  const gens = path.join(process.env.APPDATA ?? "", "DSH Desktop", "host-commands", "desktop", "generations");
  if (!fs.existsSync(gens)) return null;
  try {
    const newest = fs
      .readdirSync(gens)
      .map((name) => path.join(gens, name, "bin", "dsh.cmd"))
      .filter((p) => fs.existsSync(p))
      .map((p) => ({ p, t: fs.statSync(p).mtimeMs }))
      .sort((a, b) => b.t - a.t)[0];
    return newest?.p ?? null;
  } catch {
    return null;
  }
}

/** 找 DSH Desktop.exe，--relaunch 用。 */
function findDshExe() {
  const local = process.env.LOCALAPPDATA ?? "";
  const pf = process.env.ProgramFiles ?? process.env.PROGRAMFILES ?? "";
  const pf86 = process.env["ProgramFiles(x86)"] ?? "";
  const candidates = [
    path.join(local, "Programs", "DSH Desktop", "DSH Desktop.exe"),
    path.join(pf, "DSH Desktop", "DSH Desktop.exe"),
    path.join(pf86, "DSH Desktop", "DSH Desktop.exe"),
  ];
  return candidates.find((p) => p && fs.existsSync(p)) ?? null;
}

/* ------------------------------------------------------------------ 主流程 */

const TOTAL = 6;
say("哦鲸鲸 · 安装到 DeepSeek Harness Desktop");
if (opts.dryRun) say("（dry-run：只打印，不执行）");

try {
  /* ---------------------------------------------------- 1 环境自检 */
  step(1, TOTAL, "环境自检");

  const pkgPath = path.join(ROOT, "package.json");
  if (!fs.existsSync(pkgPath)) die(`不是插件包的根目录：${pkgPath}`);
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  if (pkg.name !== PACKAGE_NAME) {
    die(`package.json 的 name 是 ${pkg.name}，本脚本只认 ${PACKAGE_NAME}`);
  }
  ok(`${PACKAGE_NAME}@${pkg.version}（${ROOT}）`);

  const nodeMajor = Number.parseInt(process.versions.node.split(".")[0], 10);
  if (nodeMajor < 22) warn(`当前 Node ${process.versions.node}，插件声明需要 ^22.19 或 >=24`);
  else ok(`Node ${process.versions.node}`);

  const npmCmd =
    [path.join(path.dirname(process.execPath), "npm.cmd"), which(["npm"])].find((p) => p && fs.existsSync(p)) ??
    null;
  if (!npmCmd) die("找不到 npm。装 Node.js 22+ 后重跑（npm 要和 node 一起装）。");
  ok(`npm ${npmCmd}`);

  // dsh 的选法很关键：只有 DSH Desktop 自己生成的 host-commands shim 才允许写 desktop profile。
  // 纯 CLI 版 dsh 有静态校验，会一律拒绝 desktop —— 所以优先找 shim，PATH 上的只作兜底。
  let dshCmd = "";
  let dshFrom = "";
  if (opts.direct) {
    // 直装路径不需要 dsh
  } else if (opts.dsh) {
    dshCmd = path.resolve(opts.dsh);
    dshFrom = "--dsh 指定";
  } else {
    dshCmd = desktopDshShim() ?? "";
    dshFrom = "DSH Desktop host-commands";
    if (!dshCmd) {
      dshCmd = which(["dsh"]) ?? "";
      dshFrom = "PATH";
      if (dshCmd) {
        warn(
          "PATH 上的 dsh 不是 DSH Desktop 生成的 shim。如果它不是那一份，",
        );
        warn("`dsh plugin --profile desktop` 会被拒绝（纯 CLI 版的静态校验）。");
      }
    }
  }
  if (opts.direct) {
    info("--direct：不走 dsh，第 4 步改成直接拷进 profile 并登记 bundles");
  } else if (!dshCmd) {
    die(
      [
        "找不到可用的 dsh。这块必须用 DSH Desktop 自带的那份（它会带 --manage-desktop-profile 权限）：",
        `  ${path.join(process.env.APPDATA ?? "", "DSH Desktop", "host-commands", "desktop", "generations", "<hash>", "bin", "dsh.cmd")}`,
        "三个办法：",
        "  1) 打开一次 DSH Desktop，它会重新生成 host-commands，再重跑本脚本",
        "  2) 手动指定：node tools/install.mjs --dsh \"<上面那个路径>\"",
        "  3) 完全不用 dsh：node tools/install.mjs --direct",
      ].join("\n"),
    );
  }
  if (!opts.direct) {
    if (!fs.existsSync(dshCmd)) die(`dsh 不在：${dshCmd}`);
    ok(`dsh ${dshCmd}（来自 ${dshFrom}）`);
    if (opts.dryRun) info("（dry-run 不真的调 dsh，下面只打印命令）");
    const dshVersion = opts.dryRun ? null : probe([dshCmd, "--version"]);
    if (dshVersion && !dshVersion.ok) {
      die(`dsh 跑不起来，先修好它：\n  ${dshCmd} --version\n${dshVersion.out}`);
    }
    if (dshVersion) ok(`dsh --version → ${lastLine(dshVersion.out)}`);
  }

  const profileDir = path.join(PROFILES_DIR, opts.profile);
  const profileManifest = path.join(profileDir, "package.json");
  if (!fs.existsSync(profileManifest)) {
    die(
      [
        `找不到 profile「${opts.profile}」：${profileManifest}`,
        "先完整启动一次 DSH Desktop 让它初始化 profile，再回来装。",
      ].join("\n"),
    );
  }
  ok(`profile ${opts.profile} → ${profileDir}`);

  // 两点必须说清楚，否则用户会在错误的地方排查：
  //   1) 只有 DSH Desktop 自带的 dsh shim 才允许操作 desktop profile；
  //      自己 npm i -g 的 dsh / npx dsh 会直接拒绝（静态校验，跟 DSH 开没开无关）。
  //   2) 装完必须重启 DSH，插件是在进程启动时加载的。
  if (!opts.dryRun && opts.profile === "desktop") {
    const running = isDshRunning();
    if (running === true) {
      warn(
        [
          "DSH Desktop 正在运行。装是能装的（dsh 会等 package.json 的锁，最多 2 分钟），",
          "但装完必须重启 DSH 才生效；而且重启前窗口里的页面可能读到半截资源。",
          "想稳妥就先完全退出 DSH 再装，并加 --relaunch 让脚本装完把它拉回来。",
        ].join("\n"),
      );
    } else if (running === false) {
      ok("DSH Desktop 没在跑（装完手动打开它）");
    }
  }

  const readProfile = () => JSON.parse(fs.readFileSync(profileManifest, "utf8"));
  const before = readProfile();
  const alreadyInstalled = Boolean(
    before.dependencies?.[PACKAGE_NAME] ?? before.devDependencies?.[PACKAGE_NAME],
  );
  if (alreadyInstalled) info("profile 里已经有这个包，本次按「升级」处理");
  for (const legacy of LEGACY_PACKAGES) {
    if (before.dependencies?.[legacy] ?? before.devDependencies?.[legacy]) {
      warn(`发现改名前的旧包 ${legacy}，装完会顺手摘掉它的 bundles 登记`);
    }
  }

  // 整条命令链要联网：npm pack 不联网，pnpm 装 tarball 一般也不联网（本包零依赖），
  // 但 venv 里的 PySide6 首次装要下载。这里只提醒，不阻断。
  if (opts.deps && !opts.dryRun) {
    const venvPyw = path.join(SHELL_DIR, ".venv", "Scripts", "pythonw.exe");
    if (!fs.existsSync(venvPyw)) info("standalone-py/.venv 还没就绪，第 5 步会建 venv 并下载 PySide6（约 300MB）");
  }

  /* ---------------------------------------------------- 2 构建前端 */
  step(2, TOTAL, "构建前端（app/src → web/）");
  const buildScript = path.join(ROOT, "tools", "build-plugin.mjs");
  if (!opts.build) {
    warn("--no-build：跳过构建，直接打包现有 web/");
    if (!fs.existsSync(path.join(ROOT, "web", "app.html"))) {
      die("web/app.html 不存在，又不让构建，没东西可打包。去掉 --no-build 重跑。");
    }
  } else {
    if (!fs.existsSync(buildScript)) die(`缺少 ${buildScript}`);
    run([process.execPath, buildScript]);
    if (!opts.dryRun) ok("前端已构建");
  }

  /* ---------------------------------------------------- 3 打包插件 */
  step(3, TOTAL, "打包插件（npm pack）");
  const distDir = path.join(ROOT, "dist");
  fs.mkdirSync(distDir, { recursive: true });
  const tgzName = `${pkg.name}-${pkg.version}.tgz`;
  const tgzPath = path.join(distDir, tgzName);
  if (fs.existsSync(tgzPath) && !opts.dryRun) fs.rmSync(tgzPath, { force: true });
  // 缓存放仓库里的 .npm-cache（已在 .gitignore）：不污染全局 npm 缓存，也不受全局配置影响。
  const npmCache = path.join(ROOT, ".npm-cache");
  fs.mkdirSync(npmCache, { recursive: true });
  run([npmCmd, "pack", "--pack-destination", distDir], { env: { npm_config_cache: npmCache } });
  if (!opts.dryRun) {
    if (!fs.existsSync(tgzPath)) die(`npm pack 没产出 ${tgzPath}，看看上面的输出`);
    const kb = (fs.statSync(tgzPath).size / 1024).toFixed(0);
    ok(`${path.relative(ROOT, tgzPath)}  ${kb} KB`);
  }

  /* ---------------------------------------------------- 4 装进 DSH */
  step(4, TOTAL, opts.direct ? "装进 DSH（直拷 profile）" : "装进 DSH（dsh plugin add）");
  // 装之前先把在跑的独立窗停掉：pnpm 会整体替换 node_modules 里的插件目录，
  // 窗口正从 /xj/* 取页面，边改边读容易看到半截。
  const stopped = opts.dryRun ? { stopped: null, reason: "dry-run 不动" } : stopRunningShell();
  if (stopped.stopped) info(`先停掉了正在跑的独立窗（pid ${stopped.stopped}）`);
  else info(`独立窗：${stopped.reason}`);

  if (opts.direct) {
    // 退路：不走 dsh，直接拷进 profile 并登记 bundles（tools/install-plugin.mjs 的活）。
    const directScript = path.join(ROOT, "tools", "install-plugin.mjs");
    if (!fs.existsSync(directScript)) die(`缺少 ${directScript}`);
    run([process.execPath, directScript]);
    if (!opts.dryRun) ok("直装完成（拷目录 + 登记 bundles）");
  } else {
    // pnpm 对「同一个 spec 的 file: tarball」是幂等的：它只比对 package.json 里的 specifier
    // 和版本号，两者没变就直说 Already up to date，根本不看 tgz 内容。于是「改完前端 → 重新打包
    // → 再 add」会静默装回旧代码（2026-10 实测）。先 remove 再 add 才能强制重新取包。
    const already = readProfile();
    const hasDep = Boolean(already.dependencies?.[PACKAGE_NAME] ?? already.devDependencies?.[PACKAGE_NAME]);
    if (hasDep) {
      info(`${PACKAGE_NAME} 已在 profile 里，先摘掉再装（否则 pnpm 会认为 Already up to date，不刷新内容）`);
      const rmResult = runDsh(dshCmd, pluginArgv(["remove", PACKAGE_NAME], opts.profile), {
        dryRun: opts.dryRun,
        cwd: ROOT,
        log: info,
      });
      if (rmResult.status !== 0) warn("dsh plugin remove 没成功，继续尝试直接 add（下面可能仍是旧内容）");
    }

    const addResult = runDsh(dshCmd, pluginArgv(["add", tgzPath], opts.profile), {
      dryRun: opts.dryRun,
      cwd: ROOT,
      log: info,
    });
    if (addResult.status !== 0) {
      const log = lastPnpmLog(path.join(PROFILES_DIR, opts.profile));
      die(
        [
          `dsh plugin add 失败（退出码 ${addResult.status}）。按报错对号入座：`,
          "",
          "  A. 出现 profile \"desktop\" is managed exclusively by the Electron application",
          "     → 你调的不是 DSH Desktop 自带的 dsh shim。纯 CLI 版 dsh（npm i -g 或 npx）",
          "       有一条静态校验，永远不许碰 desktop profile，跟 DSH 开没开无关。",
          "       让它自己找：去掉 --dsh 重跑；或显式指定",
          '         --dsh "%APPDATA%\\DSH Desktop\\host-commands\\desktop\\generations\\<hash>\\bin\\dsh.cmd"',
          "",
          "  B. 出现 package.json.lock 的 EPERM/EACCES，或 pnpm 的 ENOENT/network 报错",
          "     → 锁被占（DSH 正在装别的东西，脚本已等过 2 分钟）/ 权限 / 网络。",
          "       先单独跑一次看原始报错：dsh plugin --profile desktop list",
          "",
          "  C. 路径里有乱码（中文目录被当 GBK 读，反斜杠被吞）",
          "     → 说明这台机器上 dsh shim 的参数被 cmd 转码毁了。本脚本会优先直连 DSH Desktop.exe",
          "       绕开 cmd；如果仍失败，把仓库挪到纯 ASCII 路径下再装（例如 C:\\ojingjing-widget）。",
          "",
          "  D. 其它情况，或短时间内绕不过去 —— 退回直装（跳过 dsh，直接拷进 profile）：",
          "       node tools/install.mjs --direct",
          "       node tools/install-plugin.mjs        # 老脚本，等价",
          "",
          ...(log ? [`最后一次 pnpm 日志（${log.file}）：`, "", ...log.text.split(/\r?\n/).slice(-14).map((l) => "  " + l)] : []),
        ].join("\n"),
      );
    }
    if (!opts.dryRun) ok(`dsh plugin add 完成`);
  }
  if (opts.dryRun) info("（dry-run：上面只打印了命令，没有真的装）");
  if (!opts.dryRun) {
    const after = readProfile();

    // direct 模式不写 dependencies（只是拷目录），所以这条检查只在 dsh 路径上做。
    if (!opts.direct) {
      const dep = after.dependencies?.[PACKAGE_NAME] ?? after.devDependencies?.[PACKAGE_NAME];
      if (!dep) die(`pnpm 装完了，但 profile 的 dependencies 里没有 ${PACKAGE_NAME}。检查上面 pnpm 的输出。`);
      ok(`profile dependencies: ${PACKAGE_NAME} = ${dep}`);
    }

    // bundles：dsh 路径由 plugin-manager 的 reconcile 自动登记，direct 路径由 install-plugin.mjs 写。
    // 两条路都在这里复查一遍，没登记就兜一手。
    const bundles = after.dsh?.profile?.bundles ?? [];
    if (!bundles.includes(PACKAGE_NAME)) {
      warn(`bundles 里还没有 ${PACKAGE_NAME}，手动补登记`);
      const next = bundles.filter((b) => !LEGACY_PACKAGES.includes(b));
      const anchor = next.indexOf("dsh-whale-widget");
      next.splice(anchor >= 0 ? anchor + 1 : next.length, 0, PACKAGE_NAME);
      after.dsh = after.dsh ?? {};
      after.dsh.profile = after.dsh.profile ?? {};
      after.dsh.profile.bundles = next;
      fs.writeFileSync(profileManifest, JSON.stringify(after, null, 2) + "\n", "utf8");
      ok("已写回 profile 的 bundles");
    } else {
      ok(`bundles 已登记（第 ${bundles.indexOf(PACKAGE_NAME) + 1}/${bundles.length} 位）`);
    }

    const installedManifest = path.join(profileDir, "node_modules", PACKAGE_NAME, "package.json");
    if (fs.existsSync(installedManifest)) {
      const ip = JSON.parse(fs.readFileSync(installedManifest, "utf8"));
      ok(`落地版本 ${ip.name}@${ip.version}`);
      if (!fs.existsSync(path.join(profileDir, "node_modules", PACKAGE_NAME, "cordis.patch.yml"))) {
        die("插件装在 profile 里但缺少 cordis.patch.yml —— 包不完整，DSH 起来会加载失败。");
      }
    } else {
      die(`说装好了，但 ${installedManifest} 不存在`);
    }
  }

  /* ---------------------------------------------------- 5 Python 依赖 */
  step(5, TOTAL, "补齐独立窗的 Python 依赖（standalone-py/.venv）");
  if (!opts.deps) {
    warn("--skip-deps：不动 venv。独立窗要自己装 PySide6 才能开。");
  } else {
    const venvDir = path.join(SHELL_DIR, ".venv");
    const venvPy = path.join(venvDir, "Scripts", "python.exe");
    const reqPath = path.join(SHELL_DIR, "requirements.txt");

    if (!fs.existsSync(venvPy)) {
      // 没 venv：找一个基础解释器来建
      const bases = [[which(["py"]), "-3"], [which(["python"])]]
        .filter(([c]) => Boolean(c))
        .map(([c, ...rest]) => [c, ...rest]);
      let base = null;
      for (const [cmd, ...rest] of bases) {
        const args = [cmd, ...rest, "-c", "import sys;print(sys.version)"];
        if (probe(args).ok) {
          base = [cmd, ...rest];
          break;
        }
      }
      if (!base) die("找不到可用的 Python 3。装 Python 3.10+ 后重跑，或用 --skip-deps 跳过。");

      info(`用 ${base.join(" ")} 建 venv：${path.relative(ROOT, venvDir)}`);
      run([...base, "-m", "venv", venvDir]);
      if (!opts.dryRun && !fs.existsSync(venvPy)) die(`venv 建完却没看到 ${venvPy}`);
    } else {
      ok(`venv 已存在：${path.relative(ROOT, venvDir)}`);
    }

    if (!fs.existsSync(reqPath)) die(`缺少 ${reqPath}`);

    const pipArgs = [venvPy, "-m", "pip", "install", "--disable-pip-version-check", "-r", reqPath];
    if (opts.mirror) pipArgs.push("-i", opts.mirror);

    if (opts.dryRun) {
      info("（dry-run 不探测 PySide6；真跑时下面这条失败就会走 pip install）");
      probe([venvPy, "-c", "import PySide6;print(PySide6.__version__)"]);
      run(pipArgs);
    } else {
      const pyside = probe([venvPy, "-c", "import PySide6;print(PySide6.__version__)"]);
      if (pyside.ok && !opts.forceDeps) {
        ok(`PySide6 已就绪（${lastLine(pyside.out)}），跳过 pip install`);
      } else {
        if (pyside.ok) info(`--force-deps：PySide6 ${lastLine(pyside.out)} 已装，仍按 requirements 重跑`);
        else info("PySide6 还没装，开始 pip install（首次约 300MB，慢）");
        run(pipArgs);

        const after2 = probe([venvPy, "-c", "import PySide6;print(PySide6.__version__)"]);
        if (!after2.ok) {
          die(
            [
              "pip install 跑完了，但 import PySide6 还是失败：",
              after2.out || "(没有输出)",
              "常见原因：venv 建坏了（删掉 standalone-py/.venv 重跑本脚本）、磁盘满、或镜像没有这个包。",
            ].join("\n"),
          );
        }
        ok(`PySide6 ${lastLine(after2.out)}`);
      }
    }

    // pythonw 是宿主拉起独立窗用的解释器，缺了自动拉起会静默跳过
    const venvPyw = path.join(venvDir, "Scripts", "pythonw.exe");
    if (!opts.dryRun) {
      if (fs.existsSync(venvPyw)) ok(`pythonw 就位：${venvPyw}`);
      else warn(`没有 ${venvPyw}，DSH 自动拉起独立窗会跳过（多半是 venv 建法不对）`);
    }
    if (!fs.existsSync(path.join(SHELL_DIR, SHELL_SCRIPT))) warn(`缺少 ${SHELL_SCRIPT}，独立窗起不来`);
  }

  /* ---------------------------------------------------- 6 自动拉起配置 */
  step(6, TOTAL, "写自动拉起配置（DSH 起来时自动弹独立窗）");
  if (!opts.shellConfig) {
    warn("--no-shell-config：没写。要恢复就重跑一次不带这个参数。");
  } else if (opts.dryRun) {
    const launchers = shellLaunchers();
    info(`$ 写 ${path.join(process.env.USERPROFILE ?? "", ".dsh", "ojingjing-shell.json")}`);
    info(`  解释器候选：${launchers.length ? launchers.join(" | ") : "（一个都没找到，自动拉起会被跳过）"}`);
  } else {
    const payload = writeShellConfig();
    const back = readShellConfig();
    if (!back || back.autoLaunch !== true || !Array.isArray(back.launchers)) {
      die("自动拉起配置写完回读不对，检查 ~/.dsh/ojingjing-shell.json");
    }
    ok(`~/.dsh/ojingjing-shell.json（autoLaunch=${back.autoLaunch}）`);
    if (back.launchers.length === 0) {
      warn("没找到任何 pythonw.exe —— 自动拉起会被插件跳过。装好 Python/PySide6 后重跑本脚本。");
    } else {
      ok(`解释器候选 ${back.launchers.length} 个，首选 ${back.launchers[0]}`);
    }
    if (!fs.existsSync(payload.shellDir)) warn(`shellDir 不存在：${payload.shellDir}`);
  }

  /* ---------------------------------------------------- 收尾 */
  say("\n──────────────────────────────────────────────");
  if (opts.dryRun) {
    say("dry-run 结束，什么都没改。");
    process.exit(0);
  }
  say(`装好了：${PACKAGE_NAME}@${pkg.version}`);
  say("");
  say("接下来：");
  if (opts.relaunch) {
    // 已经在跑就不要再开一个：单实例会瞬间退出，还会抢一下焦点。
    if (isDshRunning() === true) {
      say("  1. 已经帮你拉起过 DSH，但它正在运行 —— 请手动重启它才生效。");
    } else {
      const exe = findDshExe();
      if (exe) {
        spawn(exe, [], { detached: true, stdio: "ignore", windowsHide: false }).unref();
        say(`  1. 已经帮你把 DSH 拉起来了：${exe}`);
        say("     插件在进程启动时加载，等它起来后右下角应该出现哦鲸鲸。");
      } else {
        say("  1. 没找到 DSH Desktop.exe（--relaunch 没起作用），请自己打开 DSH。");
      }
    }
  } else {
    say("  1. 完全退出 DeepSeek Harness Desktop，再重新打开 —— 插件在进程启动时加载。");
  }
  say("  2. 打开后右下角应该出现哦鲸鲸；没出现就是没加载，看 DSH 的插件日志。");
  say("  3. 想单独开着置顶窗：双击 standalone-py 下的「启动哦鲸鲸.cmd」。");
  say("");
  say("回滚：node tools/uninstall.mjs");
} catch (error) {
  die(error instanceof Error ? error.message : String(error));
}
