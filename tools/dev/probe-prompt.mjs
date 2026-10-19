/**
 * 探一下 /xj/prompt 是否已经在运行中的宿主里注册。
 *   node tools/probe-prompt.mjs            -> 用不存在的会话试探（期望 404/409/422 之类，不是 405）
 *   node tools/probe-prompt.mjs --real     -> 用真实会话 + 真实截图发一条（会真的进会话）
 */
import fs from "node:fs";
import path from "node:path";

const BASE = process.env.XJ_DSH_BASE || "http://127.0.0.1:43120";
// 1×1 透明 PNG
const TINY =
  "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAIAQMAAAD+wSzIAAAABlBMVEX///+/v7+jQ3Y5AAAADklEQVQI12P4AIX8EAgALgAD/aNpbtEAAAAASUVORK5CYII=";
const ROOT = path.resolve(import.meta.dirname, "..", "..");

const state = await (await fetch(BASE + "/xj/state")).json();
console.log("sessions:", (state.sessions || []).map((s) => `${s.id}(${s.title})`).join(", ") || "none");

const real = process.argv.includes("--real");
const session = real ? (state.sessions || [])[0] : { id: "PROBE" };
if (!session) {
  console.log("没有会话可发");
  process.exit(0);
}

let data = TINY;
if (real) {
  const shot = path.join(ROOT, "docs", "screenshots", "desktop-widget-final.png");
  if (fs.existsSync(shot)) {
    data = fs.readFileSync(shot).toString("base64");
    console.log("用真实截图:", fs.statSync(shot).size, "bytes →", Math.round(data.length / 1024), "KB base64");
  } else {
    console.log("没有真实截图，退回 1×1");
  }
}

const body = {
  sessionId: session.id,
  text: real ? "这是一次截图提问的联调测试。" : "probe",
  image: { mediaType: "image/png", data },
};

const t0 = Date.now();
const res = await fetch(BASE + "/xj/prompt", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});
const text = await res.text();
console.log(`POST /xj/prompt -> ${res.status} (${Date.now() - t0}ms) ${text.slice(0, 300)}`);
process.exit(0);
