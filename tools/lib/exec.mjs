/**
 * tools/ 全系的「起子进程」共用件。三个脚本原来各写一份：
 *   - install.mjs 的 probe()：探测命令能不能跑通（dsh / python / node）
 *   - uninstall.mjs 的 capture()：收 tasklist 输出判断进程在不在
 * 三者是同一个模式：Windows 上 spawn 捕获管道在受限环境里会 EPERM，
 * 所以统一「输出落临时文件、事后再读回、读完删掉」。
 *
 * 另外收一个 which()（纯 JS 扫 PATH，不起进程）和 newestFile()
 * （取目录里 mtime 最新的文件，install/uninstall/dsh.mjs 各写了一遍）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { ROOT } from "../shell-config.mjs";
import { die, info } from "./log.mjs";

/** 给 shell 用的参数加引号：本机路径里有「新建文件夹」这种中文，也可能有空格。 */
export const q = (s) => `"${s}"`;

let captureSeq = 0;

/**
 * 起一个子进程，把 stdout/stderr 收进临时文件再读回。返回 { ok, out, error, dry }。
 *
 *   args   命令 + 参数数组（内部 q() 后过 shell）
 *   tag    临时文件名前缀，方便区分是哪个脚本留下的（默认 xj）
 *   env    额外环境变量
 *   cwd    工作目录（默认仓库根）
 *   dryRun true 时只打印不执行，返回 { ok: true, out: "", dry: true }
 */
export function capture(args, { tag = "xj", env = {}, cwd = ROOT, dryRun = false } = {}) {
  const line = args.map(q).join(" ");
  if (dryRun) {
    info(`$ ${line}`);
    return { ok: true, out: "", dry: true };
  }
  const tmp = path.join(os.tmpdir(), `${tag}-${process.pid}-${(captureSeq += 1)}.log`);
  let fd = "ignore";
  try {
    fd = fs.openSync(tmp, "w");
  } catch {
    /* 落不了盘就只靠退出码 */
  }
  const r = spawnSync(line, {
    shell: true,
    cwd,
    encoding: "utf8",
    stdio: ["ignore", fd, fd],
    windowsHide: true,
    env: { ...process.env, ...env },
  });
  if (typeof fd === "number") {
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
    /* 没读到就当空 */
  }
  try {
    fs.rmSync(tmp, { force: true });
  } catch {
    /* ignore */
  }
  return { ok: r.status === 0, out, error: r.error };
}

/**
 * 跑一条「用户要看过程」的命令：stdio 直接 inherit，不过管道（管道在受限环境里 EPERM）。
 * 失败默认 die；allowFail 时把退出码交还调用方。
 */
export function run(args, { allowFail = false, env = {}, cwd = ROOT, dryRun = false } = {}) {
  const line = args.map(q).join(" ");
  if (dryRun) {
    info(`$ ${line}`);
    return { status: 0, out: "", dry: true };
  }
  const r = spawnSync(line, {
    shell: true,
    cwd,
    encoding: "utf8",
    stdio: "inherit",
    windowsHide: true,
    env: { ...process.env, ...env },
  });
  if (r.error) {
    die(`命令起不来：${line}\n  ${r.error.message}`);
  }
  if (r.status !== 0 && !allowFail) {
    die(`命令失败（退出码 ${r.status}）：\n  ${line}`);
  }
  return { status: r.status ?? 1, out: "" };
}

/** 取多行输出的最后一行非空内容（探针常把版本打在最后一行）。 */
export function lastLine(text) {
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
export function which(names) {
  const exts = (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  for (const name of names) {
    const lower = name.toLowerCase();
    const styled = exts.some((e) => lower.endsWith(e.toLowerCase()));
    for (const dir of dirs) {
      const base = path.join(dir, name);
      const tries = styled ? [base] : [...exts.map((e) => base + e.toLowerCase()), ...exts.map((e) => base + e)];
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
 * 取目录里 mtime 最新的一个文件；rel(name) 把条目名拼成完整路径。
 * 读不了 / 空目录都返回 null。DSH 的 generations、pnpm 的 operation 日志都靠它。
 */
export function newestFile(dir, rel) {
  try {
    const newest = fs
      .readdirSync(dir)
      .map((name) => rel(name))
      .filter((p) => fs.existsSync(p))
      .map((p) => ({ p, t: fs.statSync(p).mtimeMs }))
      .sort((a, b) => b.t - a.t)[0];
    return newest?.p ?? null;
  } catch {
    return null;
  }
}
