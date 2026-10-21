#!/usr/bin/env node
/**
 * 桌面区域截图（screen-shot.mjs）
 *
 * 为什么需要它：CDP 的 `--shot` 只能抓 WebView2 视口，抓不到 WinForms 窗口被
 * SetWindowRgn 裁出来的形状。不透明 + Rgn 路线下（小球椭圆 / 卡片圆角 / 离线胶囊），
 * 页面截图永远是矩形，必须截屏才知道圆角有没有生效、有没有露出深底黑边。
 *
 * 用法：
 *   node tools/dev/screen-shot.mjs <x> <y> <w> <h> <out.png>
 *   node tools/dev/screen-shot.mjs --window "哦鲸鲸" <out.png>   # 按标题找窗口，自动扩 12px
 */
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { die, ok, phase } from "../lib/log.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const CSC = "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe";
const SRC = join(ROOT, "tools", "dev", "screen-shot.cs");
const OUT_EXE = join(ROOT, ".shots", "screen-shot.exe");

/** FindWindow by exact title, then GetWindowRect. */
function windowRect(title) {
  const probe = join(ROOT, ".shots", "win-probe.exe");
  let out = "";
  try {
    out = execFileSync(probe, [], { encoding: "utf8" });
  } catch (e) {
    out = (e.stdout || "") + (e.stderr || "");
  }
  const line = out.split(/\r?\n/).find((l) => l.includes("title=" + title));
  if (!line) die("没找到标题为「" + title + "」的窗口");
  const m = line.match(/winRect=\((-?\d+),(-?\d+)\)-\((-?\d+),(-?\d+)\)/);
  if (!m) die("win-probe 输出里没有 winRect：" + line.trim());
  return { x: +m[1], y: +m[2], w: +m[3] - +m[1], h: +m[4] - +m[2] };
}

phase("编译截屏工具");
mkdirSync(join(ROOT, ".shots"), { recursive: true });
execFileSync(CSC, ["/nologo", "/target:winexe", "/out:" + OUT_EXE, "/r:System.Drawing.dll", "/r:System.Windows.Forms.dll", SRC], {
  stdio: "pipe",
});

let x, y, w, h, dest;
const a = process.argv.slice(2);
if (a[0] === "--window") {
  if (!a[2]) die("用法：node tools/dev/screen-shot.mjs --window <标题> <out.png>");
  const r = windowRect(a[1]);
  const pad = 12;
  x = r.x - pad;
  y = r.y - pad;
  w = r.w + pad * 2;
  h = r.h + pad * 2;
  dest = a[2];
} else {
  if (a.length < 5) die("用法：node tools/dev/screen-shot.mjs <x> <y> <w> <h> <out.png>");
  [x, y, w, h] = a.slice(0, 4).map(Number);
  dest = a[4];
}

const out = execFileSync(OUT_EXE, [String(x), String(y), String(w), String(h), dest, a[0] === "--window" ? a[1] : ""], { encoding: "utf8" }).trim();
if (!out.startsWith("OK")) die("截屏失败：" + out);
ok("截屏 " + dest + "（" + w + "x" + h + " @" + x + "," + y + "）");
