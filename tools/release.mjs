#!/usr/bin/env node
/* =============================================================================
   release.mjs · 一键发版：推代码 → 打 tag → 建 GitHub Release → 传 tarball
   =============================================================================
   为什么要有这个脚本：
     GitHub 的 Release 不能只靠 git push，还得往 API 传一个二进制附件；
     而「版本号散落在 package.json / 页面兜底 / 文档」里是最容易发错的地方，
     所以版本号只认 package.json，其它地方在构建时注入（见 tools/build-plugin.mjs）。

   用法（在仓库根目录）：
     node tools\release.mjs               # 真发：push + tag + release + 上传附件
     node tools\release.mjs --dry-run     # 只打印将要做什么，不联网不改仓库
     node tools\release.mjs --notes releases\v0.4.0.md
     node tools\release.mjs --skip-push   # 只建 release（tag 已经推过了）
     node tools\release.mjs --draft       # 发成草稿，自己在网页上点发布

   凭据来源（按顺序，第一个非空就用）：
     1. 环境变量 GITHUB_TOKEN / GH_TOKEN / GITHUB_PAT
     2. git credential fill（Windows 上就是「凭据管理器」里那份，也就是 git push 用的同一份）
   脚本不会把 token 打印出来，也不会写进任何文件。

   退出码：0 成功 / 1 失败 / 2 用法错误
   ========================================================================== */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import https from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { die, phase, say, warn } from "./lib/log.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const API = "https://api.github.com";
const UPLOADS = "https://uploads.github.com";

/* ---------------- 小工具 ---------------- */
const args = process.argv.slice(2);
const flag = (name) => args.includes("--" + name);
const opt = (name, fallback = "") => {
  const i = args.indexOf("--" + name);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : fallback;
};
const DRY = flag("dry-run");
const DRAFT = flag("draft");
const SKIP_PUSH = flag("skip-push");

/* 输出层（say/phase/warn/die）统一走 lib/log.mjs，和各 install/uninstall 一致 */

function git(...argv) {
  const out = execFileSync("git", argv, {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  return String(out).trim();
}
function gitInherit(...argv) {
  execFileSync("git", argv, { cwd: ROOT, stdio: "inherit", windowsHide: true });
}
function gitTry(...argv) {
  try {
    return git(...argv);
  } catch {
    return "";
  }
}

/* ---------------- HTTP ---------------- */
function request(method, url, { token, body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const isUpload = u.hostname === "uploads.github.com";
    const h = {
      "user-agent": "dsh-plugin-ojingjing-release",
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      authorization: "Bearer " + token,
      ...headers,
    };
    if (!isUpload && method !== "GET") h["content-type"] = "application/json";
    let payload = null;
    if (body !== undefined && body !== null) {
      payload = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body), "utf8");
      h["content-length"] = String(payload.length);
    }
    const req = https.request({ method, hostname: u.hostname, path: u.pathname + u.search, headers: h }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {
          /* 上传附件返回的就是 JSON，解析失败留给调用方看 text */
        }
        resolve({ status: res.statusCode, headers: res.headers, json, text });
      });
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/* ---------------- 取 token ---------------- */
function tokenFromCredentialHelper() {
  // git credential fill：stdin 给协议和主机，stdout 回 username/password
  const script =
    "$env:GCM_INTERACTIVE='never'; $in = \"protocol=https`nhost=github.com`n`n\"; $in | git credential fill";
  const out = execFileSync("pwsh", ["-NoProfile", "-Command", script], {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    timeout: 20000,
  });
  const m = /^password=(.+)$/m.exec(String(out));
  return m ? m[1].trim() : "";
}

async function resolveToken() {
  for (const name of ["GITHUB_TOKEN", "GH_TOKEN", "GITHUB_PAT"]) {
    const v = (process.env[name] || "").trim();
    if (v) return { token: v, from: "环境变量 " + name };
  }
  try {
    const v = tokenFromCredentialHelper();
    if (v) return { token: v, from: "git 凭据管理器（github.com）" };
  } catch (e) {
    warn("读 git 凭据失败：" + (e && e.message ? e.message.split("\n")[0] : e));
  }
  return { token: "", from: "" };
}

/* ---------------- 主流程 ---------------- */
async function main() {
  /* 1. 版本号：只认 package.json */
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const version = (opt("version") || pkg.version || "").replace(/^v/, "");
  if (!version) die("package.json 里没有 version");
  const tag = "v" + version;

  /* 2. 仓库与分支 */
  const remote = gitTry("remote", "get-url", "origin");
  const m = /github\.com[:/]([^/]+)\/([^/.]+?)(?:\.git)?$/.exec(remote);
  if (!m) {
    die(
      "origin 不是 GitHub 仓库：" + (remote || "(读不到)") +
        "\n  可能原因：① 没在仓库根目录跑；② 没配 origin；③ 这里的 node 起不了 git 子进程（沙箱限制）。" +
        "\n  先手动确认：git remote -v"
    );
  }
  const owner = m[1];
  const repo = m[2];
  const branch = gitTry("rev-parse", "--abbrev-ref", "HEAD") || "main";

  say("仓库    " + owner + "/" + repo);
  say("版本    " + version + "（tag " + tag + "）");
  say("分支    " + branch);
  say("模式    " + (DRY ? "只演练（不联网、不改仓库）" : DRAFT ? "发成草稿" : "正式发布"));

  /* 3. 附件 */
  const tgzName = "dsh-plugin-ojingjing-" + version + ".tgz";
  const tgzPath = path.join(ROOT, "dist", tgzName);
  const sumPath = path.join(ROOT, "dist", "SHA256SUMS.txt");
  if (!fs.existsSync(tgzPath)) {
    die("找不到 " + path.relative(ROOT, tgzPath) + "\n  先跑：node tools\\build-plugin.mjs 然后 npm.cmd pack --cache .npm-cache --pack-destination dist");
  }
  const tgzBytes = fs.readFileSync(tgzPath);
  const sha = createHash("sha256").update(tgzBytes).digest("hex");
  fs.writeFileSync(sumPath, sha + "  " + tgzName + "\n", "utf8");
  say("附件    dist/" + tgzName + "（" + tgzBytes.length + " B, sha256 " + sha.slice(0, 12) + "…）");

  /* 4. 发布说明 */
  const notesPath = path.join(ROOT, "releases", tag + ".md");
  let notes = "";
  if (fs.existsSync(notesPath)) notes = fs.readFileSync(notesPath, "utf8").trim();
  else {
    warn("没有 releases/" + tag + ".md，用最近 20 条提交当说明");
    notes = gitTry("log", "--oneline", "-20");
  }
  say("说明    " + (fs.existsSync(notesPath) ? "releases/" + tag + ".md" : "git log") + "（" + notes.length + " 字）");

  /* 5. 工作区状态（脏了就提醒，不阻止：有时就是要把未提交的构建产物一起发） */
  const dirty = gitTry("status", "--porcelain");
  if (dirty) warn("工作区有未提交改动，本次发布会把它们一起推到仓库：\n" + dirty.split("\n").slice(0, 8).join("\n"));

  if (DRY) {
    say("\n（演练结束）真发就再跑一次不带 --dry-run。");
    return;
  }

  /* 6. 推代码 */
  if (!SKIP_PUSH) {
    phase("推送 " + branch + " 到 origin");
    gitInherit("push", "origin", branch);
  } else say("\n（跳过推送）");

  /* 7. 打 tag 并推上去（已存在就复用） */
  phase("处理 tag " + tag);
  const hasLocal = !!gitTry("rev-parse", "--verify", "--quiet", "refs/tags/" + tag);
  if (!hasLocal) {
    git("tag", "-a", tag, "-m", "ojingjing " + tag);
    say("  已创建本地 tag");
  } else say("  本地已有同名 tag，复用");
  if (!SKIP_PUSH) {
    gitInherit("push", "origin", "refs/tags/" + tag);
  }

  /* 8. token */
  const { token, from } = await resolveToken();
  if (!token) {
    die(
      "没有可用的 GitHub 凭据。三种给法：\n" +
        "  · 设置环境变量 GITHUB_TOKEN（classic PAT，勾 repo 权限）\n" +
        "  · 或先手动 git push 一次，让凭据管理器记住账号\n" +
        "  · 或在能打开浏览器的终端里运行，让 GCM 弹窗登录"
    );
  }
  say("\n凭据    " + from);

  const me = await request("GET", API + "/repos/" + owner + "/" + repo, { token });
  if (me.status === 401) die("token 无效或权限不足（401）");
  if (me.status === 403) die("被限流或权限不足（403），过一会儿再试");
  if (me.status !== 200) die("读仓库信息失败：" + me.status + " " + (me.json && me.json.message ? me.json.message : ""));

  /* 9. 建/更新 Release */
  phase("创建 Release " + tag);
  const existing = await request("GET", API + "/repos/" + owner + "/" + repo + "/releases/tags/" + tag, { token });
  let rel = null;
  if (existing.status === 200 && existing.json && existing.json.id) {
    rel = existing.json;
    say("  该 tag 已有 Release（#" + rel.id + "），更新说明");
    const patched = await request("PATCH", API + "/repos/" + owner + "/" + repo + "/releases/" + rel.id, {
      token,
      body: { name: "v" + version, body: notes, draft: DRAFT ? true : false, prerelease: false },
    });
    if (patched.status !== 200) die("更新 Release 失败：" + patched.status + " " + patched.text.slice(0, 300));
    rel = patched.json;
  } else {
    const created = await request("POST", API + "/repos/" + owner + "/" + repo + "/releases", {
      token,
      body: {
        tag_name: tag,
        name: "v" + version,
        body: notes,
        draft: DRAFT ? true : false,
        prerelease: false,
      },
    });
    if (created.status !== 201) die("创建 Release 失败：" + created.status + " " + created.text.slice(0, 400));
    rel = created.json;
    say("  已创建 #" + rel.id);
  }

  /* 10. 传附件：同名先删再传，免得 422 already_exists */
  for (const [file, data, type] of [
    [tgzName, tgzBytes, "application/gzip"],
    ["SHA256SUMS.txt", fs.readFileSync(sumPath), "text/plain"],
  ]) {
    phase("上传 " + file);
    const assets = await request("GET", API + "/repos/" + owner + "/" + repo + "/releases/" + rel.id + "/assets", { token });
    if (assets.status === 200 && Array.isArray(assets.json)) {
      for (const a of assets.json) {
        if (a.name === file) {
          const del = await request("DELETE", API + "/repos/" + owner + "/" + repo + "/releases/assets/" + a.id, { token });
          say("  同名附件已存在（#" + a.id + "），先删掉：" + del.status);
        }
      }
    }
    const up = await request(
      "POST",
      UPLOADS + "/repos/" + owner + "/" + repo + "/releases/" + rel.id + "/assets?name=" + encodeURIComponent(file),
      { token, body: data, headers: { "content-type": type } }
    );
    if (up.status !== 201) die("上传失败：" + up.status + " " + up.text.slice(0, 400));
    say("  → " + (up.json && up.json.browser_download_url ? up.json.browser_download_url : "已上传"));
  }

  say("\n✓ 发布完成：" + (rel.html_url || API + "/repos/" + owner + "/" + repo + "/releases/tags/" + tag));
  if (DRAFT) say("  （是草稿，去网页上点一下 Publish 才对外可见）");
}

main().catch((e) => die(e && e.stack ? e.stack : String(e)));
