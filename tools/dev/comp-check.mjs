#!/usr/bin/env node
/**
 * 陪伴账本回归（comp-check.mjs）
 *
 * 背景（2026-10-21，老大踩到）：Companionship.CheckMilestone 把 milestones 强转
 * List<object>，而 JavaScriptSerializer 把 JSON 数组反序列化回来是 ArrayList ——
 * companionship.json 落盘后重启外壳，第一个 active tick 就 InvalidCastException，
 * 弹 .NET 未处理异常对话框。修法是 AsList() 认 IEnumerable。
 *
 * 这个坑的形状太容易复发了（py 时代写的 json、页面回传的数组），所以固化成探针：
 * 拿毒数据（数组 / 空数组 / null / 字符串数值 / 无文件）直接打 Companionship，
 * 编译 + 跑，有用例挂掉就非零退出。
 *
 * 用法：node tools\dev\comp-check.mjs
 */
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { die, ok, phase } from "../lib/log.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const CSC = "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe";
const SRC = join(ROOT, "standalone-cs");
const TEST_CS = join(ROOT, "tools", "dev", "comp-test.cs");
const OUT_EXE = join(ROOT, ".shots", "comp-test.exe");

phase("编译账本回归");
mkdirSync(join(ROOT, ".shots"), { recursive: true });
try {
  execFileSync(
    CSC,
    [
      "/nologo",
      "/target:exe",
      "/out:" + OUT_EXE,
      "/r:System.dll",
      "/r:System.Core.dll",
      "/r:System.Windows.Forms.dll",
      "/r:System.Web.Extensions.dll",
      TEST_CS,
      join(SRC, "Companionship.cs"),
      join(SRC, "Settings.cs"),
      join(SRC, "Native.cs"),
    ],
    { stdio: "inherit" }
  );
} catch {
  die("编译失败");
}

phase("跑账本用例");
try {
  execFileSync(OUT_EXE, [], { stdio: "inherit" });
} catch (err) {
  die("有用例失败（exit " + (err && err.status) + "）");
}
ok("账本回归全过");
