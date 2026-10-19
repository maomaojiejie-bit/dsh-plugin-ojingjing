import fs from "node:fs";
const p = "C:/Users/17897/.dsh/profiles/desktop/node_modules/dsh-whale-widget/lib/index.js";
const L = fs.readFileSync(p, "utf8").split("\n");
const out = [];
L.forEach((l, i) => {
  const m = l.match(/(?:ctx|root|scope)\.on\(\s*['"]([^'"]+)['"]/);
  if (m) out.push(`${i + 1}: ${m[1]}   ||  ${l.trim().slice(0, 120)}`);
});
console.log("事件订阅 " + out.length + "\n" + out.join("\n"));
const inj = [];
L.forEach((l, i) => {
  if (/\.inject\(\[/.test(l)) inj.push(`${i + 1}: ${l.trim().slice(0, 140)}`);
});
console.log("\n.inject 调用\n" + inj.join("\n"));
