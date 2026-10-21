#!/usr/bin/env node
/**
 * 一键把「哦鲸鲸」装进 DeepSeek Harness Desktop —— 走官方 `dsh plugin` 命令，不手改 profile。
 *
 *   node tools/install.mjs               全量安装（推荐）
 *   node tools/install.mjs --dry-run     只打印将要执行的命令，不动任何东西
 *
 * 流程（6 步）：
 *   1 环境自检      node / npm / dsh 各就位
 *   2 构建前端      node tools/build-plugin.mjs → web/app.html + web/static/src
 *   3 打包插件      npm pack → dist/dsh-plugin-ojingjing-<版本>.tgz
 *   4 装进 DSH      dsh plugin add <tgz>（pnpm 记账，bundles 由 reconcile 自动登记）
 *   5 检查外壳      dist/Ojingjing-CS/Ojingjing.exe（一个 exe + 三个 DLL，零运行时依赖）
 *   6 自动拉起配置  写 ~/.dsh/ojingjing-shell.json，并回读校验
 *
 * 和 tools/install-plugin.mjs 的关系：那个是「手工复制文件 + 手改 profile/package.json」的老路子，
 * 不需要 dsh、也不需要 pnpm 联网；这个是官方路子，profile 的依赖账本交给 pnpm 维护。
 * 两个都保留：官方命令不可用（比如离线、dsh 不在 PATH）时还能退回老路子。
 *
 * 退出码：0 成功；1 某一步失败；2 参数用错。
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

import {
  PACKAGE_NAME,
  LEGACY_PACKAGES,
  PROFILES_DIR,
  ROOT,
  CS_EXE,
  readShellConfig,
  stopRunningShell,
  writeShellConfig,
} from "./shell-config.mjs";
import { findDsh, isDshRunning, pluginArgv, runDsh } from "./dsh.mjs";
import { capture, lastLine, newestFile, run as runCmd, which } from "./lib/exec.mjs";
import { die, info, ok, say, step, warn } from "./lib/log.mjs";

/* ------------------------------------------------------------------ 参数 */

const USAGE = `用法：node tools/install.mjs [选项]

  --dry-run, -n        只打印将执行的命令，不落盘
  --no-build           跳过前端构建，直接打包现有 web/
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
  else if (a === "--no-shell-config") opts.shellConfig = false;
  else if (a === "--direct") opts.direct = true;
  else if (a === "--relaunch") opts.relaunch = true;
  else if (a === "--profile") opts.profile = next();
  else if (a.startsWith("--profile=")) opts.profile = a.slice("--profile=".length);
  else if (a === "--dsh") opts.dsh = next();
  else if (a.startsWith("--dsh=")) opts.dsh = a.slice("--dsh=".length);
  else die(`不认识的选项：${a}（用 --help 看用法）`);
}

/* ------------------------------------------------------------------ 输出与跑命令 */
/* say/step/info/ok/warn/die 在 lib/log.mjs；capture/run/which/lastLine/newestFile 在 lib/exec.mjs。
   本地只包一层 run：把 --dry-run 默认带上（lib/exec.run 不认本脚本的 opts）。 */
const run = (args, extra = {}) => runCmd(args, { dryRun: opts.dryRun, ...extra });

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

/**
 * 读最近一次 pnpm 操作的日志（plugin-manager 会把每次 add/remove 的输出留在
 * `<profile>/.plugin-manager/logs/operation-<id>/pnpm.log`）。
 * pnpm 失败时真正的报错只在这份日志里 —— 外面看到的往往只有一句 exit code 1。
 */
function lastPnpmLog(profileDir) {
  const logs = path.join(profileDir, ".plugin-manager", "logs");
  const newest = newestFile(logs, (name) => path.join(logs, name, "pnpm.log"));
  if (!newest) return null;
  const text = fs.readFileSync(newest, "utf8").trim();
  return { file: newest, text: text || "（这次操作 pnpm 什么都没输出）" };
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
  // （findDsh 就是这个顺序：先 generations 里最新的 shim，再 PATH。）
  let dshCmd = "";
  let dshFrom = "";
  if (opts.direct) {
    // 直装路径不需要 dsh
  } else if (opts.dsh) {
    dshCmd = path.resolve(opts.dsh);
    dshFrom = "--dsh 指定";
  } else {
    const found = findDsh();
    dshCmd = found?.cmd ?? "";
    dshFrom = found?.from ?? "";
    if (dshCmd && dshFrom === "PATH") {
      warn("PATH 上的 dsh 不是 DSH Desktop 生成的 shim。如果它不是那一份，");
      warn("`dsh plugin --profile desktop` 会被拒绝（纯 CLI 版的静态校验）。");
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
    const dshVersion = opts.dryRun ? null : capture([dshCmd, "--version"], { tag: "xj-dsh" });
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

  // 整条命令链要联网：npm pack 不联网，pnpm 装 tarball 一般也不联网（本包零依赖）。
  // C# 外壳的 DLL 从 NuGet 取，但那是最初构建时的事，安装不碰。这里不需要任何提示。

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
    if (!opts.dryRun) {
      ok("前端已构建");
      // 构建链自检：app.html 不该再引用原型专用文件；static 资源应该被 minify 过
      const appHtml = fs.readFileSync(path.join(ROOT, "web", "app.html"), "utf8");
      if (/\/xj\/static\/src\/(mock|devbar)\.js/.test(appHtml)) {
        warn("web/app.html 里还引用着 mock.js/devbar.js —— build-plugin.mjs 的剥离逻辑该修了");
      } else {
        ok("embed 剥离生效（mock.js / devbar.js 不进插件包）");
      }
      const cssHead = fs.readFileSync(path.join(ROOT, "web", "static", "src", "styles.css"), "utf8").slice(0, 200);
      if (cssHead.trimStart().startsWith("/*")) {
        warn("static 资源未 minify（没找到 esbuild，构建已自动回退原样拷贝）——可选优化，装了esbuild再跑一次构建即可");
      } else {
        ok("static 资源已 minify");
      }
    }
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

  /* ---------------------------------------------------- 5 外壳运行时 */
  step(5, TOTAL, "检查独立窗外壳");
  if (fs.existsSync(CS_EXE)) {
    // C# + WebView2 外壳：一个 exe（页面已内嵌）+ 三个 DLL，没有运行时依赖要装。
    const kb = (fs.statSync(CS_EXE).size / 1024).toFixed(0);
    ok(`外壳已就绪：${path.relative(ROOT, CS_EXE)}（${kb} KB）`);
  } else {
    warn("没找到 dist/Ojingjing-CS/Ojingjing.exe —— DSH 里的小组件照常能跑，但不会自动弹独立窗");
    warn("要独立窗就跑一次：node tools/build-shell-cs.mjs");
  }

  /* ---------------------------------------------------- 6 自动拉起配置 */
  step(6, TOTAL, "写自动拉起配置（DSH 起来时自动弹独立窗）");
  if (!opts.shellConfig) {
    warn("--no-shell-config：没写。要恢复就重跑一次不带这个参数。");
  } else if (opts.dryRun) {
    info(`$ 写 ${path.join(process.env.USERPROFILE ?? "", ".dsh", "ojingjing-shell.json")}`);
    info(`  外壳：${path.relative(ROOT, CS_EXE)}（exe 直接拉起）`);
  } else {
    writeShellConfig();
    const back = readShellConfig();
    if (!back || back.autoLaunch !== true || !back.exe) {
      die("自动拉起配置写完回读不对，检查 ~/.dsh/ojingjing-shell.json");
    }
    ok(`~/.dsh/ojingjing-shell.json（autoLaunch=${back.autoLaunch}）`);
    ok(`外壳程序：${back.exe}`);
    if (!fs.existsSync(back.exe)) warn(`配置里的 exe 不存在：${back.exe}（先跑 node tools/build-shell-cs.mjs）`);
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
  if (fs.existsSync(CS_EXE)) {
    say(`  3. 想单独开着置顶窗：双击 ${path.relative(ROOT, CS_EXE)}（页面已内嵌，DSH 没开也能用）。`);
  } else {
    say("  3. 还没有独立窗：node tools/build-shell-cs.mjs 打一个（约 1.17MB）。");
  }
  say("  4. 想重新打外壳：node tools/build-shell-cs.mjs。");
  say("");
  say("回滚：node tools/uninstall.mjs");
} catch (error) {
  die(error instanceof Error ? error.message : String(error));
}
