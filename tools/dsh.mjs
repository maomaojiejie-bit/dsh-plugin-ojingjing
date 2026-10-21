/**
 * 调 `dsh` 的那点事。
 *
 * 为什么不能直接 spawn dsh.cmd：DSH Desktop 生成的 shim 是个批处理，里面先 `chcp 65001`
 * 再把参数用 `%*` 展开交给 Electron。这条链上只要有一步按 ANSI/OEM 代码页转码，
 * 含中文的参数就会变成乱码——实测把
 *   C:\Users\xxx\Desktop\新建文件夹\ojingjing-widget\dist\dsh-plugin-ojingjing-0.4.0.tgz
 * 传给 pnpm 时变成 UTF-8-当-GBK 读的乱码，结尾那个反斜杠还会被吞进双字节字符里
 * （`...文件夹\ojingjing...` → `...澶筡ojingjing...`），pnpm 直接 exit 1。
 *
 * 所以这里把 shim 拆开：拿到它要跑的 exe + desktop-cli.js + 环境变量，
 * 用 spawn(shell:false) 直接起那个 exe——参数走 CreateProcessW（UTF-16），
 * 不经过 cmd，也就没有代码页这回事。
 *
 * 解析不出来（shim 结构变了、exe 被挪走）就返回 null，调用方退回走 .cmd。
 */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { capture, newestFile } from "./lib/exec.mjs";

/**
 * DSH Desktop 是不是正开着。开着的话 profile 被它独占锁住（dsh plugin add 会失败），
 * 插件的 lib/index.js 也被它装在内存里（node_modules 目录删不掉）。
 * install.mjs / uninstall.mjs 在动手前都会问一句；探测不出来返回 null，不断言。
 */
export function isDshRunning() {
  const r = capture(["tasklist", "/FI", "IMAGENAME eq DSH Desktop.exe", "/NH"], { tag: "xj-dsh" });
  if (!r.ok) return null;
  return /DSH Desktop\.exe/i.test(r.out);
}

/**
 * 找一个能管 desktop profile 的 dsh：
 * 优先 DSH Desktop 生成的 host-commands shim（只有它被授权），其次 PATH 上的 dsh。
 * 返回 { cmd, from }，找不到返回 null。
 */
export function findDsh() {
  const gens = path.join(
    process.env.APPDATA ?? "",
    "DSH Desktop",
    "host-commands",
    "desktop",
    "generations",
  );
  // 每次 DSH 启动会生成新的一代 shim，取最新那个
  const newest = newestFile(gens, (name) => path.join(gens, name, "bin", "dsh.cmd"));
  if (newest) return { cmd: newest, from: "DSH Desktop host-commands" };

  const exts = (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  for (const dir of (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    for (const ext of ["", ...exts.map((e) => e.toLowerCase()), ...exts]) {
      const p = path.join(dir, "dsh" + ext);
      try {
        if (fs.statSync(p).isFile()) return { cmd: p, from: "PATH" };
      } catch {
        /* 继续 */
      }
    }
  }
  return null;
}

/**
 * 把 dsh.cmd 拆成「要起的 exe + desktop-cli.js + 它设的环境变量」。
 * shim 长这样（尾部）：
 *   set "ELECTRON_RUN_AS_NODE=1"
 *   set "DSH_HOME=C:\Users\xxx\.dsh"
 *   "C:\...\DSH Desktop.exe" --expose-internals "C:\...\resources\app\lib\desktop-cli.js" %*
 */
export function parseShim(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }

  const env = {};
  for (const m of text.matchAll(/^\s*set\s+"?([A-Za-z_][A-Za-z0-9_]*)=([^"\r\n]*)"?/gim)) {
    env[m[1]] = m[2].trim();
  }

  const line = text.match(/^\s*"([^"\r\n]+\.exe)"\s+--expose-internals\s+"([^"\r\n]+)"/im);
  if (!line) return null;
  const [, exe, cli] = line;
  if (!fs.existsSync(exe) || !fs.existsSync(cli)) return null;
  return { exe, cli, env };
}

/**
 * 拼出「直接起 exe 时」的完整参数：--expose-internals <cli> <dsh 的 argv…>。
 * desktop-cli.js 会在 argv[0] === "plugin" 且没给 --profile 时自动补 `--profile desktop`，
 * 别的 profile 由 pluginArgv() 自己补进去。
 */
export function exeArgs(inv, dshArgv) {
  return ["--expose-internals", inv.cli, ...dshArgv];
}

/**
 * 组装 dsh 的 argv（不含 --expose-internals 那两段）。
 * `pluginArgs` 是 `plugin` 后面的部分，例如 ["add", "C:\\x.tgz"]。
 */
export function pluginArgv(pluginArgs, profile = "desktop") {
  const out = ["plugin"];
  if (profile !== "desktop") out.push("--profile", profile);
  out.push(...pluginArgs);
  return out;
}

/**
 * 真正跑一条 dsh 命令。返回 { status }。
 * dryRun 时只打印；exe 解析不出来时退回走 .cmd（含中文路径在这种环境下可能失败）。
 */
export function runDsh(
  shimCmd,
  dshArgv,
  { dryRun = false, cwd = process.cwd(), log = console.log } = {},
) {
  const q = (s) => `"${s}"`;
  const inv = parseShim(shimCmd);
  const line = inv
    ? [inv.exe, ...exeArgs(inv, dshArgv)].map(q).join(" ")
    : [shimCmd, ...dshArgv].map(q).join(" ");

  if (dryRun) {
    log(`$ ${line}`);
    return { status: 0, dry: true, direct: Boolean(inv) };
  }

  let r;
  if (inv) {
    r = spawnSync(inv.exe, exeArgs(inv, dshArgv), {
      cwd,
      stdio: "inherit",
      windowsHide: true,
      env: { ...process.env, ...inv.env },
    });
  } else {
    r = spawnSync(line, {
      shell: true,
      cwd,
      stdio: "inherit",
      windowsHide: true,
    });
  }

  if (r.error) throw new Error(`dsh 起不来：${r.error.message}`);
  return { status: r.status ?? 1, direct: Boolean(inv), line };
}
