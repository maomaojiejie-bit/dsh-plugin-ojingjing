/**
 * 生成 app.ico（窗口 + 托盘图标）
 *
 * 两种来源：
 *   1) 默认：把哦鲸鲸自己的鲸鱼渲染成「深海圆牌」图标；
 *   2) 自定义：把源图放到 assets/icon-source.png（或 --source <路径>），
 *      脚本会缩放成 256×256 再打包（保留透明通道）。
 *
 * 用法：
 *   node tools/make-icon.mjs                      # 用内置鲸鱼
 *   node tools/make-icon.mjs --source icon.png    # 用你自己的图
 *   node tools/make-icon.mjs --form happy         # 换表情（sleep/focus/alert/happy/offline）
 *
 * 产物：web/icon.png（托盘/窗口图标，外壳直接读它）
 */
import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

const argv = process.argv.slice(2);
const argOf = (name, dflt) => {
  const i = argv.indexOf("--" + name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};

const expression = argOf("form", "focus");
const SIZE = 256;
const work = mkdtempSync(join(tmpdir(), "xj-icon-"));

const sourceArg = argOf("source", "");
// 默认用角色原图（assets/icon-source.png）——它和 avatar 同源，但未被裁切，图标自己会缩放；
// 没有原图就渲染内置鲸鱼。（不用 app/src/avatar.webp：System.Drawing 读不了 WebP。）
const iconSourcePng = join(root, "assets", "icon-source.png");
const sourcePng = sourceArg ? resolve(root, sourceArg) : iconSourcePng;
const png = join(work, "icon.png");

/* ------------------------------ 1. 取位图 ------------------------------ */

function renderWhale() {
  const chromeBinaries = [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  ];
  const chrome = chromeBinaries.find((p) => existsSync(p));
  if (!chrome) throw new Error("找不到 Chrome / Edge，无法渲染内置鲸鱼图标");

  const srcDir = join(root, "app", "src").replace(/\\/g, "/");
  const page = join(work, "icon.html");
  writeFileSync(
    page,
    `<!doctype html>
<html><head><meta charset="utf-8">
<style>
  html,body{margin:0;width:${SIZE}px;height:${SIZE}px;background:transparent;overflow:hidden}
  body{display:flex;align-items:center;justify-content:center}
  #icon{width:${SIZE - 8}px;height:${SIZE - 8}px;border-radius:50%;overflow:hidden;
        background:linear-gradient(145deg,#2E3A5F 0%,#1F2A44 100%);
        display:flex;align-items:center;justify-content:center;
        box-shadow:inset 0 1px 0 rgba(255,255,255,.18)}
  #icon .whale .brows,#icon .whale .bang,#icon .whale .zzz,
  #icon .whale .stars,#icon .whale .orbit{display:none!important}
  #icon .whale .eye-offline,#icon .whale .eye-happy{display:none!important}
  #icon .whale .eye-open{display:block!important;opacity:1!important}
</style></head>
<body><div id="icon"></div>
<script src="file:///${srcDir}/dom.js"></script>
<script src="file:///${srcDir}/whale.js"></script>
<script>
  document.getElementById('icon').appendChild(
    XJ.whale.make(${JSON.stringify(expression)}, Math.round(${SIZE} * 0.6))
  );
</script></body></html>`,
    "utf8"
  );

  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(
      chrome,
      [
        "--headless=new",
        "--disable-gpu",
        "--hide-scrollbars",
        "--allow-file-access-from-files",
        "--default-background-color=00000000",
        `--user-data-dir=${join(work, "prof")}`,
        `--window-size=${SIZE},${SIZE}`,
        "--force-device-scale-factor=1",
        "--virtual-time-budget=3000",
        `--screenshot=${png}`,
        `file:///${page.replace(/\\/g, "/")}`,
      ],
      { stdio: "ignore", windowsHide: true }
    );
    child.on("exit", (code) => (code === 0 ? resolveRun() : rejectRun(new Error("Chrome 退出码 " + code))));
  });
}

function scaleCustomImage() {
  const scaled = join(work, "icon-256.png");
  const ps = [
    "Add-Type -AssemblyName System.Drawing",
    `$src=[System.Drawing.Image]::FromFile('${sourcePng}')`,
    "$bmp=New-Object System.Drawing.Bitmap 256,256",
    "$g=[System.Drawing.Graphics]::FromImage($bmp)",
    "$g.InterpolationMode=[System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic",
    "$g.PixelOffsetMode=[System.Drawing.Drawing2D.PixelOffsetMode]::High",
    "$g.Clear([System.Drawing.Color]::Transparent)",
    "$g.DrawImage($src,(New-Object System.Drawing.Rectangle 0,0,256,256),(New-Object System.Drawing.Rectangle 0,0,$src.Width,$src.Height),[System.Drawing.GraphicsUnit]::Pixel)",
    `$bmp.Save('${scaled}',[System.Drawing.Imaging.ImageFormat]::Png)`,
    "$g.Dispose();$bmp.Dispose();$src.Dispose()",
  ].join("; ");
  execFileSync("powershell", ["-NoProfile", "-Command", ps], { stdio: "inherit" });
  return scaled;
}

const useSource = existsSync(sourcePng);
let pngBytes;
if (useSource) {
  console.log("使用自定义图标：", sourcePng);
  pngBytes = readFileSync(scaleCustomImage());
} else {
  console.log("未找到 icon-source.png，使用内置鲸鱼图标");
  await renderWhale();
  pngBytes = readFileSync(png);
}
console.log("位图", pngBytes.length, "bytes");

/* ------------------------------ 2. 写图标 ------------------------------ */

const webPng = join(root, "web", "icon.png");
writeFileSync(webPng, pngBytes);
console.log("→", webPng);

// 独立窗的托盘/窗口图标：Python 版直接从 web/icon.png 读，不再需要 .ico
console.log("完成。重启哦鲸鲸即可看到新图标。");
process.exit(0);
