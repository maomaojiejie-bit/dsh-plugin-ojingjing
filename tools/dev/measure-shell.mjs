// 直接跑外壳的 MeasureScript，看它在动画中各时刻量到什么
// 用法：node tools/dev/measure-shell.mjs <cdpPort>
import { connect } from "./cdp.mjs";

const port = Number(process.argv[2] || 43199);
const { send, close } = await connect(port, { timeoutMs: 15000 });

async function evaluate(expression) {
  const msg = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (msg.result?.exceptionDetails) throw new Error(JSON.stringify(msg.result.exceptionDetails).slice(0, 300));
  return msg.result?.result?.value;
}

const MEASURE = `(function(){
  var st = document.getElementById('xj-stage');
  if (!st) return [];
  var d = window.devicePixelRatio || 1, out = [], i;
  var forms = st.querySelectorAll('.form');
  for (i = 0; i < forms.length; i++) {
    var el = forms[i];
    if (el.classList && el.classList.contains('xj-leaving')) continue;
    var r = el.getBoundingClientRect();
    if (r.width < 8 || r.height < 8) continue;
    var rad = parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0;
    var pad = 0, aura = el.querySelector ? el.querySelector('.aura.show') : null;
    if (aura) {
      var ins = Math.abs(parseFloat(getComputedStyle(aura).top) || 0);
      pad = (ins > 0 ? ins : 3) + 2;
    }
    out.push({ x: Math.round((r.left - pad) * d), y: Math.round((r.top - pad) * d),
               w: Math.round((r.width + pad * 2) * d), h: Math.round((r.height + pad * 2) * d),
               r: Math.round(rad * d), cls: el.className.slice(0,30) });
  }
  var badges = st.querySelectorAll('.badges .badge');
  for (i = 0; i < badges.length; i++) {
    var b = badges[i], cs = getComputedStyle(b);
    if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) continue;
    var br = b.getBoundingClientRect();
    if (br.width < 4 || br.height < 4) continue;
    var brad = parseFloat(cs.borderTopLeftRadius);
    out.push({ x: Math.round(br.left * d), y: Math.round(br.top * d),
               w: Math.round(br.width * d), h: Math.round(br.height * d),
               r: Math.round((isNaN(brad) ? br.width / 2 : brad) * d), cls: 'badge' });
  }
  return out;
})()`;

// 先收回球态
await evaluate(`XJ.embed.pointerInside = function(){ return false }; XJ.app.orbHoverEnd(); XJ.app.collapse(); 'ok'`);
await new Promise((r) => setTimeout(r, 900));

// 展开，并紧跟着跑外壳脚本（模仿 shell 的时序）
await evaluate(`XJ.embed.pointerInside = function(){ return true }; XJ.app.orbHoverStart(); 'ok'`);
for (let i = 0; i < 14; i++) {
  const r = await evaluate(MEASURE);
  console.log(`#${String(i).padStart(2)}`, JSON.stringify(r));
  await new Promise((r2) => setTimeout(r2, 30));
}
close();
