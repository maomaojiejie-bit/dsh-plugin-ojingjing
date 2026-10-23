#!/usr/bin/env node
/**
 * 走 GitHub REST Git Database 推提交（git push 的替身）。
 *
 * 为什么存在：当前网络里 github.com 这个主机整个不通（CONNECT 502 / 直连超时），
 * 而 api.github.com 是通的 —— git 的 smart-HTTP 只能走 github.com，所以
 * git push / git fetch 全都瘫痪，但 REST API 能把 commit / tree / blob
 * 一个个建出来、最后把 ref 挪到新 commit 上，等于把提交推了上去。
 *
 * 要点：
 *   - 远端已有的 blob / tree 直接引用 sha，不重传（git 对象按内容寻址）；
 *   - 每个 commit 的 author / committer / message / 日期原样复刻，
 *     所以推上去的 commit sha 和本地一致（可验证）；
 *   - token 解析与 tools/release.mjs 一致：环境变量 → git 凭据管理器，
 *     不会打印、不会落盘。
 *
 * 用法：
 *   node tools/push-commits.mjs             # 推当前分支到 origin 同名分支
 *   node tools/push-commits.mjs --dry-run   # 只演练：数一下要传多少东西
 *   node tools/push-commits.mjs --branch main
 */
import { execFileSync, spawn } from "node:child_process";
import path from "node:path";
import https from "node:https";
import { fileURLToPath } from "node:url";
import { die, info, ok, phase, say, warn } from "./lib/log.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const API = "https://api.github.com";

/* ---------------- 参数 ---------------- */
const args = process.argv.slice(2);
const DRY = args.includes("--dry-run");
const opt = (name, fallback = "") => {
  const i = args.indexOf("--" + name);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : fallback;
};

/* ---------------- git 小工具 ---------------- */
function git(...argv) {
  return execFileSync("git", argv, {
    cwd: ROOT,
    encoding: "buffer",
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
}
function gitText(...argv) {
  return String(git(...argv)).trim();
}
function gitTry(...argv) {
  try {
    return gitText(...argv);
  } catch {
    return "";
  }
}

/* ---------------- HTTP（api.github.com 直连即可，不经代理） ---------------- */
function request(method, url, { token, body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const h = {
      "user-agent": "dsh-plugin-ojingjing-push",
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      authorization: "Bearer " + token,
      ...headers,
    };
    if (body !== undefined && body !== null) h["content-type"] = "application/json";
    const payload = body === undefined || body === null ? null : Buffer.from(JSON.stringify(body), "utf8");
    if (payload) h["content-length"] = String(payload.length);
    const req = https.request({ method, hostname: u.hostname, path: u.pathname + u.search, headers: h }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {
          /* 保持 null，调用方看 text */
        }
        resolve({ status: res.statusCode, json, text });
      });
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function api(method, url, { token, body, tries = 3 } = {}) {
  let last = null;
  for (let i = 1; i <= tries; i++) {
    const r = await request(method, url, { token, body });
    if (r.status < 500) return r;
    last = r;
    if (i < tries) await new Promise((res) => setTimeout(res, 800 * i));
  }
  return last;
}

/* ---------------- token（与 release.mjs 同一套） ---------------- */
function tokenFromCredentialHelper() {
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

function resolveToken() {
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

/* ---------------- git 对象解析 ---------------- */
function parseLsTree(buf) {
  // <mode> <type> <sha>\t<path>\0 ……（-z 输出，路径含怪字符也不会被引号转义）
  const out = [];
  for (const rec of buf.toString("utf8").split("\0")) {
    if (!rec) continue;
    const tab = rec.indexOf("\t");
    if (tab < 0) continue;
    const meta = rec.slice(0, tab);
    const p = rec.slice(tab + 1);
    const sp1 = meta.indexOf(" ");
    const sp2 = meta.indexOf(" ", sp1 + 1);
    out.push({ mode: meta.slice(0, sp1), type: meta.slice(sp1 + 1, sp2), sha: meta.slice(sp2 + 1), path: p });
  }
  return out;
}

function toTreeEntries(children) {
  return children.map((ch) => ({
    path: ch.path,
    mode: ch.mode,
    type: ch.type === "tree" ? "tree" : ch.mode === "160000" ? "commit" : "blob",
    sha: ch.sha,
  }));
}

function gitTsToIso(epoch, offset) {
  // epoch 秒 + "+0800" → ISO 8601 带偏移（GitHub API 只认 ISO）
  const sign = offset[0] === "-" ? -1 : 1;
  const mins = parseInt(offset.slice(1, 3), 10) * 60 + parseInt(offset.slice(3, 5), 10);
  const d = new Date((Number(epoch) + sign * mins * 60) * 1000);
  const pad = (n) => String(n).padStart(2, "0");
  return (
    d.getUTCFullYear() + "-" + pad(d.getUTCMonth() + 1) + "-" + pad(d.getUTCDate()) +
    "T" + pad(d.getUTCHours()) + ":" + pad(d.getUTCMinutes()) + ":" + pad(d.getUTCSeconds()) +
    offset.slice(0, 3) + ":" + offset.slice(3, 5)
  );
}

function parseIdent(s) {
  const m = /^(.*) <([^>]*)> (\d+) ([+-]\d{4})$/.exec(s);
  if (!m) die("解析不了 git ident：" + s);
  return { name: m[1], email: m[2], date: gitTsToIso(m[3], m[4]) };
}

function parseCommit(raw) {
  const text = raw.toString("utf8");
  const sep = text.indexOf("\n\n");
  const header = text.slice(0, sep);
  const message = text.slice(sep + 2);
  const c = { tree: "", parents: [], author: null, committer: null, message };
  for (const line of header.split("\n")) {
    if (line.startsWith("tree ")) c.tree = line.slice(5).trim();
    else if (line.startsWith("parent ")) c.parents.push(line.slice(7).trim());
    else if (line.startsWith("author ")) c.author = parseIdent(line.slice(7));
    else if (line.startsWith("committer ")) c.committer = parseIdent(line.slice(10));
  }
  return c;
}

/* ---------------- 主流程 ---------------- */
async function main() {  const branch = opt("branch") || gitText("rev-parse", "--abbrev-ref", "HEAD");
  const remote = gitTry("remote", "get-url", "origin");
  const m = /github\.com[:/]([^/]+)\/([^/.]+?)(?:\.git)?$/.exec(remote || "");
  if (!m) {
    die(
      "origin 不是 GitHub 仓库：" + (remote || "(读不到)") +
        "\n  git push 走不了 github.com 这个主机（网络层 502），才需要这个脚本；" +
        "先确认 origin 配对了。"
    );
  }
  const owner = m[1];
  const repo = m[2];
  const base = API + "/repos/" + owner + "/" + repo;

  phase("push-commits：" + owner + "/" + repo + " 分支 " + branch + (DRY ? "（演练，不联网写）" : ""));
  info("github.com 不通 → 走 REST Git Database；api.github.com 可达");

  const { token, from } = resolveToken();
  if (!token) die("没有 token：设 GITHUB_TOKEN，或先让 git 凭据管理器记住 github.com 账号");
  info("token 来源：" + from);

  /* 1. 远端现状 */
  const refRes = await api("GET", base + "/git/ref/heads/" + branch, { token });
  const remoteSha = refRes.status === 200 ? refRes.json.object.sha : null;
  if (refRes.status === 404) info("远端没有 " + branch + " 分支，将新建");
  else if (refRes.status !== 200) die("读远端 ref 失败：" + refRes.status + " " + refRes.text.slice(0, 200));

  const remoteShas = new Set();
  if (remoteSha) {
    const treeRes = await api("GET", base + "/git/trees/" + remoteSha + "?recursive=1", { token });
    if (treeRes.status !== 200) die("读远端 tree 失败：" + treeRes.status + " " + treeRes.text.slice(0, 200));
    for (const e of treeRes.json.tree) remoteShas.add(e.sha);
    info("远端对象：" + remoteShas.size + " 个（" + remoteSha.slice(0, 8) + " 的全树）");
    // cat-file -e 成功时零输出，只能看退出码
    let haveRemote = false;
    try {
      execFileSync("git", ["cat-file", "-e", remoteSha + "^{commit}"], { cwd: ROOT, stdio: "ignore" });
      haveRemote = true;
    } catch {
      haveRemote = false;
    }
    if (!haveRemote) {
      die("本地没有远端的 " + remoteSha.slice(0, 8) + "：先想办法把它 fetch 下来（github.com 不通时只能导包）");
    }
    let isAncestor = false;
    try {
      execFileSync("git", ["merge-base", "--is-ancestor", remoteSha, "HEAD"], { cwd: ROOT, stdio: "ignore" });
      isAncestor = true;
    } catch {
      isAncestor = false;
    }
    if (!isAncestor) {
      die(
        "远端 " + branch + "（" + remoteSha.slice(0, 8) + "）不是本地 HEAD 的祖先：\n" +
        "  推上去要么先合并、要么 force。这个脚本不擅自 force —— 确认要用远端历史覆盖，\n" +
        "  先 git reset --hard 到要推的那个提交再来。"
      );
    }
  }

  /* 2. 要推的 commit（旧 → 新） */
  const range = remoteSha ? remoteSha + "..HEAD" : "HEAD";
  const commits = gitText("rev-list", "--reverse", range).split("\n").filter(Boolean);
  if (commits.length === 0) {
    ok("没有可推的提交（远端已是最新）");
    return;
  }
  info("待推提交：" + commits.length + " 个（" + commits[0].slice(0, 8) + " → " + commits[commits.length - 1].slice(0, 8) + "）");

  /* 3. 盘点：每个 commit 需要新建哪些对象 */
  const available = new Set(remoteShas);
  const plan = [];
  for (const sha of commits) {
    const needBlobs = [];
    const needTrees = [];
    const entries = parseLsTree(git("ls-tree", "-r", "-t", "-z", sha));
    for (const e of entries) {
      if (available.has(e.sha)) continue;
      if (e.type === "blob") {
        needBlobs.push(e);
        available.add(e.sha);
      } else if (e.type === "tree") {
        needTrees.push(e);
        available.add(e.sha);
      }
    }
    plan.push({ sha, needBlobs, needTrees });
  }
  const totalBlobs = plan.reduce((n, p) => n + p.needBlobs.length, 0);
  const totalTrees = plan.reduce((n, p) => n + p.needTrees.length, 0);
  info("需要新建：blob " + totalBlobs + " 个、tree " + totalTrees + " 个、commit " + commits.length + " 个");
  if (totalBlobs > 0) {
    const bytes = plan.flatMap((p) => p.needBlobs).reduce((n, e) => n + Number(gitText("cat-file", "-s", e.sha)), 0);
    info("blob 合计 " + (bytes / 1024 / 1024).toFixed(2) + " MB（base64 后约 ×1.37）");
  }
  if (DRY) {
    say("");
    for (const p of plan) {
      const c = parseCommit(git("cat-file", "commit", p.sha));
      const first = c.message.split("\n")[0];
      info(p.sha.slice(0, 8) + "  " + first + "（blob " + p.needBlobs.length + " / tree " + p.needTrees.length + "）");
    }
    ok("演练完，没有动远端");
    return;
  }

  /* 4. 真传：按 commit 顺序，blob → tree（深的先）→ commit */
  let parentSha = remoteSha;
  const uploaded = new Set();
  const doneTrees = new Set();
  const newShas = [];
  for (const p of plan) {
    const c = parseCommit(git("cat-file", "commit", p.sha));
    const title = c.message.split("\n")[0].slice(0, 40);

    // 4a. blob
    for (let i = 0; i < p.needBlobs.length; i++) {
      const e = p.needBlobs[i];
      const bytes = git("cat-file", "blob", e.sha);
      const r = await api("POST", base + "/git/blobs", {
        token,
        body: { content: bytes.toString("base64"), encoding: "base64" },
      });
      if (r.status !== 201) die("建 blob 失败（" + e.path + "）：" + r.status + " " + r.text.slice(0, 300));
      uploaded.add(e.sha);
      if ((i + 1) % 50 === 0 || i + 1 === p.needBlobs.length) {
        info("blob " + (i + 1) + "/" + p.needBlobs.length + "（" + title + "）");
      }
    }

    // 4b. tree：子树深的先建，root 最后。git 对象按内容寻址，建出来的 sha
    // 与本地算的一致；远端已存在的直接引用、不重建。
    const rootSha = gitText("rev-parse", p.sha + "^{tree}");
    let treeSha = rootSha;
    if (!doneTrees.has(rootSha)) {
      const deep = [...p.needTrees].sort((a, b) => b.path.split("/").length - a.path.split("/").length);
      for (const t of deep) {
        if (doneTrees.has(t.sha)) continue;
        const children = parseLsTree(git("ls-tree", "-z", p.sha + ":" + t.path));
        const r = await api("POST", base + "/git/trees", { token, body: { tree: toTreeEntries(children) } });
        if (r.status !== 201) die("建 tree 失败（" + t.path + "）：" + r.status + " " + r.text.slice(0, 300));
        doneTrees.add(t.sha);
      }
      // root 自己不在 needTrees 里（ls-tree -r -t 不列 root），单独建
      const children = parseLsTree(git("ls-tree", "-z", p.sha));
      const r = await api("POST", base + "/git/trees", { token, body: { tree: toTreeEntries(children) } });
      if (r.status !== 201) die("建 root tree 失败：" + r.status + " " + r.text.slice(0, 300));
      treeSha = r.json.sha;
      doneTrees.add(rootSha);
    }

    // 4c. commit
    const body = {
      message: c.message,
      tree: treeSha,
      author: c.author,
      committer: c.committer,
    };
    if (parentSha) body.parents = [parentSha];
    const r = await api("POST", base + "/git/commits", { token, body });
    if (r.status !== 201) die("建 commit 失败（" + p.sha.slice(0, 8) + "）：" + r.status + " " + r.text.slice(0, 300));
    const newSha = r.json.sha;
    newShas.push({ local: p.sha, remote: newSha });
    parentSha = newSha;
    info("commit " + newSha.slice(0, 8) + (newSha === p.sha ? "（sha 与本地一致）" : "（!! 与本地 " + p.sha.slice(0, 8) + " 不一致）") + "  " + title);
  }

  /* 5. 挪 ref */
  const headSha = newShas[newShas.length - 1].remote;
  let refRes2;
  if (remoteSha) {
    refRes2 = await api("PATCH", base + "/git/refs/heads/" + branch, { token, body: { sha: headSha, force: false } });
  } else {
    refRes2 = await api("POST", base + "/git/refs", { token, body: { ref: "refs/heads/" + branch, sha: headSha } });
  }
  if (refRes2.status !== 200 && refRes2.status !== 201) {
    die(
      "挪 ref 失败：" + refRes2.status + " " + refRes2.text.slice(0, 300) +
        "\n  commit 都已建好（" + newShas.map((n) => n.remote.slice(0, 8)).join(" ") +
        "），重跑一次会从当前 ref 续推，不会推倒重来。"
    );
  }

  /* 6. 收尾：本地 remote-tracking 对齐（fetch 走不了，手动更新） */
  const allMatch = newShas.every((n) => n.local === n.remote);
  const tracked = gitTry("rev-parse", "refs/remotes/origin/" + branch);
  if (allMatch && tracked && tracked !== headSha) {
    try {
      execFileSync("git", ["update-ref", "refs/remotes/origin/" + branch, headSha], { cwd: ROOT, stdio: "ignore" });
      ok("远端 ref 已指向 " + headSha.slice(0, 8) + "；本地 origin/" + branch + " 跟踪引用也对齐了");
    } catch {
      ok("远端 ref 已指向 " + headSha.slice(0, 8) + "（本地跟踪引用没更新成功，不影响远端）");
    }
  } else {
    ok("远端 ref 已指向 " + headSha.slice(0, 8));
  }
  if (!allMatch) {
    warn("有 commit 的 sha 与本地不一致（author/日期/message 复刻有偏差），历史对不上但内容一致");
  }
  say("");
  say("blob 实传 " + uploaded.size + " 个，tree/commit 按需新建；推完 " + commits.length + " 个提交。");
}

main().catch((e) => {
  const msg = (e && e.message) || String(e);
  // 本机有软件重签 TLS（MITM 代理/AV）时，Node 自带的 CA 包不认，
  // 报 unable to verify the first certificate。Windows 证书库是认的——
  // 带 --use-system-ca 重_exec 一次自己（只重一次，防死循环）。
  if (/certificate|UNABLE_TO_VERIFY|SELF_SIGNED|DEPTH_ZERO/i.test(msg) && !process.env.XJ_PUSH_TLS_RETRIED) {
    process.env.XJ_PUSH_TLS_RETRIED = "1";
    say("TLS 证书校验失败，改用系统证书库重试（--use-system-ca）…");
    const child = spawn(process.execPath, ["--use-system-ca", process.argv[1], ...process.argv.slice(2)], {
      stdio: "inherit",
      env: process.env,
      windowsHide: true,
    });
    child.on("exit", (code) => process.exit(code == null ? 1 : code));
    child.on("error", (err) => die("重试也没起来：" + err.message));
    return;
  }
  die(msg);
});
