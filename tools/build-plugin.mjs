/**
 * 把哦鲸鲸原型打包成 DSH 插件可用的静态资源。
 *
 * 输入：../app/index.html、../app/src/**（原型本体，唯一源）
 * 输出：../web/app.html、../web/static/src/**（插件包根目录即仓库根）
 *
 * 只做两件事：把相对路径换成 /xj/static/...，并把 embed.css / embed.js 挂进页面。
 * 原型本身零改动，`file://` 打开仍然可用。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const APP = path.join(ROOT, "app");
const SRC = path.join(APP, "src");
const WEB = path.join(ROOT, "web");
const STATIC = path.join(WEB, "static");

fs.rmSync(STATIC, { recursive: true, force: true });
fs.mkdirSync(path.join(STATIC, "src"), { recursive: true });

let copied = 0;
for (const name of fs.readdirSync(SRC)) {
  if (!/\.(js|css|svg|png|webp|woff2)$/.test(name)) continue;
  fs.copyFileSync(path.join(SRC, name), path.join(STATIC, "src", name));
  copied += 1;
}

let html = fs.readFileSync(path.join(APP, "index.html"), "utf8");
html = html.replace(/(href|src)="src\//g, '$1="/xj/static/src/');
html = html.replace(
  '<link rel="stylesheet" href="/xj/static/src/styles.css" />',
  '<link rel="stylesheet" href="/xj/static/src/styles.css" />\n    <link rel="stylesheet" href="/xj/embed.css" />'
);
html = html.replace(
  '<script src="/xj/static/src/app.js"></script>',
  '<script src="/xj/embed.js"></script>\n    <script src="/xj/static/src/app.js"></script>'
);
html = html.replace(/<title>[^<]*<\/title>/, "<title>哦鲸鲸 · 悬浮窗</title>");
html = html.replace(
  '<div class="desktop-hint">',
  '<div class="desktop-hint" data-remove-in-embed="1">'
);

fs.writeFileSync(path.join(WEB, "app.html"), html, "utf8");

console.log(`web/app.html   ← app/index.html`);
console.log(`web/static/src ← ${copied} 个文件`);
