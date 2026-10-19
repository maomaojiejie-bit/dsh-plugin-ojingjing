#!/usr/bin/env node
/**
 * 把「哦鲸鲸」从 DeepSeek Harness Desktop 卸干净 —— 走官方 `dsh plugin remove`，并收拾插件自己留下的东西。
 *
 *   node tools/uninstall.mjs                卸载插件 + 停独立窗 + 删自动拉起配置
 *   node tools/uninstall.mjs --dry-run      只打印将做什么
 *   node tools/uninstall.mjs --direct       不调 dsh，手工摘（dsh 不可用时的退路）
 *   node tools/uninstall.mjs --purge        连 .venv / data / 日志 / dist 里的 tgz 一起删
 *
 * 默认不删用户数据：standalone-py/data 里的 settings.json 存着头像、位置这些偏好，
 * 想彻底清干净再显式加 --purge。
 *
 * 退出码：0 成功；1 某一步失败；2 参数用错。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { findDsh, pluginArgv, runDsh } from "./dsh.mjs";

import {
  LEGACY_PACKAGES,
  LEGACY_SHELL_CONFIGS,
  PACKAGE_NAME,
  PID_FILE,
  PROFILES_DIR,
  ROOT,
  SHELL_CONFIG,
  SHELL_DIR,
  removeShellConfig,
  stopRunningShell,
} from "./shell-config.mjs";

/* ------------------------------------------------------------------ 参数 */

const USAGE = `用法：node tools/uninstall.mjs [选项]

  --dry-run, -n        只打印，不落盘
  --direct             不用 dsh，直接改 profile/package.json + 删目录
  --keep-shell-config  保留 ~/.dsh/ojingjing-shell.json（下次开 DSH 还会尝试拉起）
  --keep-data          默认行为，写在这里只为对照
  --purge              额外删：.venv、data/（含偏好和 API key）、日志、dist/*.tgz
  --profile <name>     目标 profile，默认 desktop
  --dsh <path>         指定 dsh 可执行文件
  -h, --help           看这段`;

const argv = process.argv.slice(2);
const opts = {
  dryRun: false,
  direct: false,
  keepShellConfig: false,
  purge: false,
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
  else if (a === "--direct") opts.direct = true;
  else if (a === "--keep-shell-config") opts.keepShellConfig = true;
  else if (a === "--keep-data") /* 默认行为 */;
  else if (a === "--purge") opts.purge = true;
  else if (a === "--profile") opts.profile = next();
  else if (a.startsWith("--profile=")) opts.profile = a.slice("--profile=".length);
  else if (a === "--dsh") opts.dsh = next();
  else if (a.startsWith("--dsh=")) opts.dsh = a.slice("--dsh=".length);
  else die(`不认识的选项：${a}（用 --help 看用法）`);
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

/* ------------------------------------------------------------ 小工具 */

const q = (s) => `"${s}"`;

/** 删一个目录；node_modules 里 pnpm 放的是 junction，只摘链接别递归进去。 */
function removeTree(target) {
  let st;
  try {
    st = fs.lstatSync(target);
  } catch {
    return false;
  }
  if (st.isSymbolicLink() || st.isJunction?.()) {
    fs.unlinkSync(target);
  } else {
    fs.rmSync(target, { recursive: true, force: true });
  }
  return true;
}

/**
 * 删目录，但删不掉不算失败。
 * DSH 开着的时候插件文件被它握在手里，Windows 会拒绝删除（EPERM/EBUSY）；
 * 这时退一步把目录改名 —— 改完名 DSH 就加载不到它了，等它退出后下次再真删。
 */
function removeTreeQuiet(dir) {
  try {
    removeTree(dir);
    return { ok: true };
  } catch (error) {
    const tomb = `${dir}.removed-${Date.now()}`;
    try {
      fs.renameSync(dir, tomb);
      return { ok: false, moved: tomb };
    } catch (error2) {
      return { ok: false, error: `${error.message}；改名也没成：${error2.message}` };
    }
  }
}

/** 上次「删不动只好改名」留下的 `<包名>.removed-<时间戳>`，这次顺手清掉。 */
function sweepTombstones(profileDir, names) {
  const nm = path.join(profileDir, "node_modules");
  let entries = [];
  try {
    entries = fs.readdirSync(nm);
  } catch {
    return [];
  }
  const pats = names.map((n) => new RegExp(`^${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.removed-\\d+$`));
  const cleaned = [];
  for (const entry of entries) {
    if (!pats.some((re) => re.test(entry))) continue;
    const full = path.join(nm, entry);
    if (opts.dryRun) {
      info(`$ 删上次的残留 ${path.relative(profileDir, full)}`);
      continue;
    }
    try {
      removeTree(full);
      cleaned.push(entry);
    } catch {
      /* 还被占着，留着下次 */
    }
  }
  return cleaned;
}

/**
 * DSH Desktop 是不是正开着。开着的时候它把插件的 lib/index.js 装进了内存，
 * 文件句柄不放 → node_modules 里那个目录删不掉。提前说清楚，省得用户以为卸载坏了。
 */
function isDshRunning() {
  const r = capture(["tasklist", "/FI", "IMAGENAME eq DSH Desktop.exe", "/NH"]);
  if (!r.ok) return null; // 探测不出来就不断言
  return /DSH Desktop\.exe/i.test(r.out);
}

let captureSeq = 0;

/** 起一个子进程并把输出收进临时文件（不用管道：受限环境里管道会 EPERM）。 */
function capture(args) {
  captureSeq += 1;
  const tmp = path.join(os.tmpdir(), `xj-uninstall-${process.pid}-${captureSeq}.log`);
  let fd;
  try {
    fd = fs.openSync(tmp, "w");
  } catch {
    fd = "ignore";
  }
  const r = spawnSync(args.map(q).join(" "), {
    shell: true,
    encoding: "utf8",
    stdio: ["ignore", fd, fd],
    windowsHide: true,
  });
  if (typeof fd === "number") {
    try {
      fs.closeSync(fd);
    } catch {
      /* 无所谓 */
    }
  }
  let out = "";
  try {
    out = fs.readFileSync(tmp, "utf8");
  } catch {
    /* 没读到就当空 */
  }
  try {
    fs.rmSync(tmp, { force: true });
  } catch {
    /* 无所谓 */
  }
  return { ok: r.status === 0, out };
}

/* ------------------------------------------------------------------ 主流程 */

const TOTAL = 5;
say("哦鲸鲸 · 从 DeepSeek Harness Desktop 卸载");
if (opts.dryRun) say("（dry-run：只打印，不执行）");

try {
  /* ---------------------------------------------------- 1 看现状 */
  step(1, TOTAL, "看现状");

  const profileDir = path.join(PROFILES_DIR, opts.profile);
  const profileManifest = path.join(profileDir, "package.json");
  if (!fs.existsSync(profileManifest)) {
    die(`找不到 profile「${opts.profile}」：${profileManifest}\n确认 DSH 装过、profile 名对。`);
  }
  const readProfile = () => JSON.parse(fs.readFileSync(profileManifest, "utf8"));
  const writeProfile = (json) => {
    if (opts.dryRun) {
      info("（dry-run 不写 profile/package.json）");
      return;
    }
    fs.writeFileSync(profileManifest, JSON.stringify(json, null, 2) + "\n", "utf8");
  };

  const targets = [PACKAGE_NAME, ...LEGACY_PACKAGES];
  const manifest = readProfile();
  const depsOf = (m) => ({ ...(m.dependencies ?? {}), ...(m.devDependencies ?? {}) });
  const deps = depsOf(manifest);
  const bundles = manifest.dsh?.profile?.bundles ?? [];

  const asDep = targets.filter((n) => deps[n] !== undefined);
  const inBundles = targets.filter((n) => bundles.includes(n));
  const onDisk = targets.filter((n) => {
    try {
      fs.lstatSync(path.join(profileDir, "node_modules", n));
      return true;
    } catch {
      return false;
    }
  });

  info(`profile ${opts.profile} → ${profileDir}`);
  info(`dependencies: ${asDep.length ? asDep.join("、") : "（没有）"}`);
  info(`bundles:      ${inBundles.length ? inBundles.join("、") : "（没有）"}`);
  info(`node_modules: ${onDisk.length ? onDisk.join("、") : "（没有）"}`);

  if (asDep.length === 0 && inBundles.length === 0 && onDisk.length === 0) {
    warn("这个 profile 里没找到哦鲸鲸，插件这边已经是干净的");
  } else if (isDshRunning() === true && onDisk.length > 0) {
    warn(
      [
        "DSH Desktop 正开着。它把插件的 lib/index.js 装进了内存，文件句柄不放，",
        "node_modules 里那个目录可能删不掉（删不掉会改名成 *.removed-<时间戳>，不影响卸载生效）。",
        "想卸得彻底：先完全退出 DSH Desktop，再跑一次本脚本。",
      ].join("\n  "),
    );
  }

  // dsh 只在非 --direct 时才需要
  let dshCmd = null;
  if (!opts.direct) {
    dshCmd = opts.dsh ? path.resolve(opts.dsh) : (findDsh()?.cmd ?? null);
    if (dshCmd && !fs.existsSync(dshCmd)) die(`--dsh 指向的文件不存在：${dshCmd}`);
    if (!dshCmd) {
      warn("找不到 dsh 命令，自动改走 --direct（直接改 profile/package.json + 删目录）");
      opts.direct = true;
    } else {
      ok(`dsh ${dshCmd}`);
    }
  } else {
    info("--direct：不调 dsh，直接改 profile/package.json + 删目录");
  }

  /* ---------------------------------------------------- 2 停独立窗 */
  step(2, TOTAL, "停掉正在跑的独立窗");
  if (!fs.existsSync(PID_FILE)) {
    info("没有 pid 文件，独立窗没在跑（或已被手动关掉）");
  } else if (opts.dryRun) {
    info("$ taskkill 掉 pid 文件里那个进程（dry-run 不真的杀）");
  } else {
    const r = stopRunningShell();
    if (r.stopped) ok(`已结束 pid ${r.stopped}`);
    else info(r.reason);
  }

  /* ---------------------------------------------------- 3 摘插件 */
  step(3, TOTAL, "从 DSH 摘掉插件");
  if (!opts.direct) {
    for (const name of asDep) {
      info(`dsh plugin remove ${name}`);
      // pnpm remove 会把依赖和 node_modules 一起清掉；bundles 由 reconcile 跟着摘
      const r = runDsh(dshCmd, pluginArgv(["remove", name], opts.profile), {
        dryRun: opts.dryRun,
        cwd: ROOT,
        log: info,
      });
      if (r.status !== 0) warn(`pnpm remove 失败（退出码 ${r.status}），下面手工清登记和目录`);
    }
    if (asDep.length === 0) {
      info("profile 的 dependencies 里没有它（早先用 install-plugin.mjs 或 --direct 直接拷进去的），跳过 pnpm，只清登记和目录");
    }
  }

  // 不管走哪条路，都兜一次底：bundles 登记 + node_modules 目录。
  // 这两步是幂等的，dsh/pnpm 已经做过就什么也不会发生。
  const now = readProfile();
  const nowBundles = now.dsh?.profile?.bundles ?? [];
  const drop = nowBundles.filter((b) => targets.includes(b));
  if (drop.length) {
    info(`摘掉 bundles 登记：${drop.join("、")}`);
    if (opts.direct) {
      const deps2 = { ...(now.dependencies ?? {}) };
      const dev2 = { ...(now.devDependencies ?? {}) };
      for (const name of targets) {
        delete deps2[name];
        delete dev2[name];
      }
      now.dependencies = deps2;
      if (now.devDependencies) now.devDependencies = dev2;
    }
    now.dsh = now.dsh ?? {};
    now.dsh.profile = now.dsh.profile ?? {};
    now.dsh.profile.bundles = nowBundles.filter((b) => !targets.includes(b));
    writeProfile(now);
    if (!opts.dryRun) ok("bundles 已更新");
  }

  const swept = sweepTombstones(profileDir, targets);
  if (swept.length) ok(`顺手清掉上次留下的残留目录：${swept.join("、")}`);

  for (const name of targets) {
    const dir = path.join(profileDir, "node_modules", name);
    try {
      fs.lstatSync(dir);
    } catch {
      continue;
    }
    if (opts.dryRun) {
      info(`$ 删目录 ${dir}`);
      continue;
    }
    // DSH 正在跑的时候，它把 lib/index.js 装进了内存，文件句柄还开着 → Windows 不让删。
    // 删不掉不要紧、但**不能因此中断整个卸载**（否则就是「登记摘了、目录还在」的半截状态），
    // 所以这里失败就改名：目录一改名，DSH 那边就加载不到它，下次启动也不会再认为插件存在。
    const r = removeTreeQuiet(dir);
    if (r.ok) ok(`已删 ${path.relative(profileDir, dir)}`);
    else if (r.moved) {
      warn(`删不动（DSH 正开着，文件被占），已改名成 ${path.basename(r.moved)}`);
      info("完全退出 DSH 后再跑一次本脚本，这个残留目录会被真正删除");
    } else warn(`目录没删掉：${r.error}`);
  }

  if (opts.direct) {
    // --direct 时不跑 pnpm，dependencies 得自己改
    const m = readProfile();
    const deps3 = { ...(m.dependencies ?? {}) };
    const dev3 = { ...(m.devDependencies ?? {}) };
    let touched = false;
    for (const name of targets) {
      if (deps3[name] !== undefined) {
        delete deps3[name];
        touched = true;
      }
      if (dev3[name] !== undefined) {
        delete dev3[name];
        touched = true;
      }
    }
    if (touched) {
      m.dependencies = deps3;
      if (m.devDependencies) m.devDependencies = dev3;
      writeProfile(m);
      ok("profile dependencies 已更新");
    }
  }

  /* ---------------------------------------------------- 4 自动拉起配置 */
  step(4, TOTAL, "清自动拉起配置");
  if (opts.keepShellConfig) {
    warn(`--keep-shell-config：保留 ${SHELL_CONFIG}（下次开 DSH 还会尝试拉起）`);
  } else {
    const existing = [SHELL_CONFIG, ...LEGACY_SHELL_CONFIGS].filter((p) => fs.existsSync(p));
    if (existing.length === 0) {
      info("没有自动拉起配置，跳过");
    } else if (opts.dryRun) {
      for (const p of existing) info(`$ 删 ${p}`);
    } else {
      const removed = removeShellConfig();
      for (const p of removed) ok(`已删 ${p}`);
    }
  }

  /* ---------------------------------------------------- 5 校验（+ --purge） */
  step(5, TOTAL, "校验");
  if (opts.dryRun) {
    info("（dry-run 跳过校验）");
  } else {
    const m = readProfile();
    const d = depsOf(m);
    const b = m.dsh?.profile?.bundles ?? [];
    const left = targets.filter((n) => d[n] !== undefined || b.includes(n));
    if (left.length) die(`还有残留：${left.join("、")}（看上面哪一步没成）`);
    ok("profile 里已经没有哦鲸鲸的依赖和 bundles 登记");

    // 登记干净了不等于真干净：目录删不掉、lockfile 里还留着引用，都算没卸完。
    const nm = path.join(profileDir, "node_modules");
    const dirsLeft = targets.filter((n) => {
      try {
        fs.lstatSync(path.join(nm, n));
        return true;
      } catch {
        return false;
      }
    });
    if (dirsLeft.length) {
      warn(`node_modules 里还留着：${dirsLeft.join("、")} —— 文件被正在跑的 DSH 占住了`);
      info("完全退出 DSH Desktop 后重跑本脚本，会把它们连同改名残留一起删掉");
    }
    const tombs = targets.flatMap((n) => {
      const re = new RegExp(`^${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.removed-\\d+$`);
      try {
        return fs.readdirSync(nm).filter((e) => re.test(e)).map((e) => path.join(nm, e));
      } catch {
        return [];
      }
    });
    if (tombs.length) {
      warn(`还有 ${tombs.length} 个改名残留（*.removed-*），退出 DSH 后重跑即可清掉`);
    }
    try {
      const lock = fs.readFileSync(path.join(profileDir, "pnpm-lock.yaml"), "utf8");
      const hits = lock.split(/\r?\n/).filter((line) => targets.some((n) => line.includes(n))).length;
      if (hits > 0) warn(`pnpm-lock.yaml 里还提到 ${hits} 处（pnpm 下次安装会自己收敛，不影响卸载生效）`);
    } catch {
      /* 没有 lockfile 更好 */
    }
  }

  if (opts.purge) {
    say("\n清理本地文件（--purge）");
    const victims = [
      path.join(SHELL_DIR, ".venv"),
      path.join(SHELL_DIR, "data"),
      path.join(SHELL_DIR, "__pycache__"),
      path.join(SHELL_DIR, "ojingjing-py.log"),
      path.join(SHELL_DIR, "out.txt"),
      path.join(SHELL_DIR, "err.txt"),
    ];
    const distDir = path.join(ROOT, "dist");
    if (fs.existsSync(distDir)) {
      for (const name of fs.readdirSync(distDir)) {
        if (/\.tgz$/.test(name)) victims.push(path.join(distDir, name));
      }
    }
    for (const p of victims) {
      if (!fs.existsSync(p)) continue;
      if (opts.dryRun) {
        info(`$ 删 ${p}`);
        continue;
      }
      if (path.basename(p) === "data") {
        warn("删 data/（含 settings.json：头像、位置、可能还有 API key）");
      }
      fs.rmSync(p, { recursive: true, force: true });
      ok(`已删 ${path.relative(ROOT, p)}`);
    }
    warn("插件源码和 web/dist 构建产物没删——仓库本身还在，重装随时能来。");
  }

  /* ---------------------------------------------------- 收尾 */
  say("\n──────────────────────────────────────────────");
  say(opts.dryRun ? "dry-run 结束，什么都没改。" : "卸完了。");
  if (!opts.dryRun) {
    say("");
    say("接下来：完全退出 DeepSeek Harness Desktop 再打开 —— 插件是进程启动时加载的，不重启它还在内存里。");
    say("想装回来：node tools/install.mjs");
  }
} catch (error) {
  die(error instanceof Error ? error.message : String(error));
}
