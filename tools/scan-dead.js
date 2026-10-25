/* 一次性死代码扫描：顶层声明引用计数（应用 + 测试双向）
 * 用法: node tools/scan-dead.js
 * 不是 CI 门禁 —— 只是重构辅助，输出人判读。 */
const fs = require("fs");
const path = require("path");
const s = fs.readFileSync(path.join(__dirname, "..", "anime-rewind.html"), "utf8");
/* 与 check.js 同一套块解析：主应用 = 行数最多的内联块
   （最长的块是 HONOR_ART 内联图数据，只有十几行） */
const blocks = [];
const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
let m;
while ((m = re.exec(s))) blocks.push(m[1]);
const js = blocks.sort((a, b) => b.split("\n").length - a.split("\n").length)[0];

const defs = [];
js.split("\n").forEach((l) => {
  let m = l.match(/^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/);
  if (m) defs.push({ name: m[1], kind: "fn", text: l.trim().slice(0, 80) });
  m = l.match(/^(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/);
  if (m) defs.push({ name: m[1], kind: "var", text: l.trim().slice(0, 80) });
});

let toolsAcc = "";
for (const f of fs.readdirSync(path.join(__dirname))) {
  if (f.endsWith(".js")) toolsAcc += fs.readFileSync(path.join(__dirname, f), "utf8");
}
console.log("js 长度:", js.length, "  tools 累计长度:", toolsAcc.length, "  顶层声明:", defs.length);

const dead = [], oneRef = [];
for (const d of defs) {
  const re = new RegExp("\\b" + d.name.replace(/\$/g, "\\$") + "\\b", "g");
  const count = (js.match(re) || []).length;
  const toolCount = (toolsAcc.match(re) || []).length;
  if (count <= 1 && toolCount === 0) dead.push(d);
  else if (count === 2 && toolCount === 0) oneRef.push({ ...d, count });
}
console.log("零引用:", dead.length);
dead.forEach((d) => console.log("  [" + d.kind + "] " + d.text));
console.log("仅两处出现（定义 + 1 处引用，人工判断是否成对）:", oneRef.length);
oneRef.forEach((d) => console.log("  [" + d.kind + "] " + d.text));
