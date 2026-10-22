// 页面内密集采样：复现外壳 MeasureScript 在动画中量到的值
// 用法：node tools/dev/measure-anim.mjs <cdpPort>
import { connect } from "./cdp.mjs";

const port = Number(process.argv[2] || 43199);
const { send, close } = await connect(port, { timeoutMs: 15000 });

async function evaluate(expression) {
  const msg = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (msg.result?.exceptionDetails) throw new Error(JSON.stringify(msg.result.exceptionDetails).slice(0, 300));
  return msg.result?.result?.value;
}

// 装采样器（命名全局函数，可随时重启）+ 钉住指针
await evaluate(`window.__samples = []; window.__sampling = false;
window.__sample = function sample(){
  if (!window.__sampling) return;
  var st = document.getElementById('xj-stage');
  var forms = st ? st.querySelectorAll('.form') : [];
  var rec = { t: performance.now()|0, form: (XJ.state && XJ.state.store.state.ui.form) || '?', f: [] };
  for (var i = 0; i < forms.length; i++) {
    var el = forms[i];
    if (el.classList && el.classList.contains('xj-leaving')) continue;
    var r = el.getBoundingClientRect();
    rec.f.push({
      gbr: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
      off: [el.offsetLeft, el.offsetTop, el.offsetWidth, el.offsetHeight],
      tf: getComputedStyle(el).transform
    });
  }
  window.__samples.push(rec);
  requestAnimationFrame(sample);
};
XJ.embed.pointerInside = function(){ return true };
'ok'`);

// 先收回球态，等窗口收起，再展开采动画
await evaluate(`XJ.embed.pointerInside = function(){ return false }; XJ.app.orbHoverEnd(); XJ.app.collapse(); 'ok'`);
await new Promise((r) => setTimeout(r, 900));

// 起采样 + 触发气泡展开
await evaluate(`XJ.embed.pointerInside = function(){ return true };
window.__samples = []; window.__sampling = true; window.__sample();
XJ.app.orbHoverStart(); 'ok'`);

await new Promise((r) => setTimeout(r, 1500));

const samples = await evaluate(`(function(){ window.__sampling = false; return window.__samples; })()`);
console.log("采样条数:", samples.length);
let last = "";
for (const s of samples) {
  const key = JSON.stringify(s.f) + s.form;
  if (key !== last) {
    console.log(`t=${String(s.t).padStart(6)} form=${s.form} ` +
      s.f.map((f) => `gbr=[${f.gbr}] off=[${f.off}] tf=${f.tf}`).join(" | "));
    last = key;
  }
}
close();
