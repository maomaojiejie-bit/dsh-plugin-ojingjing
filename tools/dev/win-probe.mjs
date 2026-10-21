#!/usr/bin/env node
/**
 * 窗口探针（win-probe.mjs）
 *
 * 排查「外壳窗口在屏幕上实际多大」用。CDP 只能量 WebView2 视口，量不到 WinForms
 * 窗口本身；tasklist /V 给不出矩形。这里用 csc 编一个小 EnumWindows 探针，
 * 打标题 / 类名 / 窗口矩形 / 客户区 / 窗口区域（Rgn）盒。
 *
 * 2026-10-21 背景：老大报「有个大黑框」。日志显示外壳窗口缩过尺寸、CDP 视口也是
 * 108，但「窗口 WxH」日志缺席——需要直接量屏幕上的真实矩形才能定位。
 *
 * 用法：node tools\dev\win-probe.mjs
 */
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { die, ok, phase } from "../lib/log.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const CSC = "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe";
const SRC = join(ROOT, "tools", "dev", "win-probe.cs");
const OUT_EXE = join(ROOT, ".shots", "win-probe.exe");

phase("编译窗口探针");
mkdirSync(join(ROOT, ".shots"), { recursive: true });
try {
  execFileSync(CSC, ["/nologo", "/target:exe", "/out:" + OUT_EXE, "/r:System.dll", SRC], {
    stdio: "inherit",
  });
} catch {
  die("编译失败");
}

phase("枚举窗口（标题含「哦鲸鲸」或类名 Chrome_WidgetWin）");
try {
  execFileSync(OUT_EXE, [], { stdio: "inherit" });
} catch {
  die("运行失败");
}
ok("完成");
