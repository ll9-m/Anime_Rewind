/* 荣誉墙模块重写：卡片化 + 自定义荣誉
 * 由 patch 脚本执行，替换 anime-rewind.html 中 HONORS..openHonorWall 之间的旧实现。
 */
const fs = require("fs");
const path = require("path");

const HTML = path.join(__dirname, "..", "anime-rewind.html");
const lines = fs.readFileSync(HTML, "utf8").split("\n");

const start = lines.findIndex(l => l.startsWith("const HONORS = ["));
if (start < 0) { console.error("未找到 const HONORS = ["); process.exit(1); }
const openWall = lines.findIndex(l => l.startsWith("function openHonorWall"));
if (openWall < 0) { console.error("未找到 openHonorWall"); process.exit(1); }
let end = -1;
for (let j = openWall; j < openWall + 25; j++) {
  if (lines[j].startsWith("function refreshAll")) { end = j; break; }
}
if (end < 0) { console.error("未找到 refreshAll 边界"); process.exit(1); }
console.log("替换区间(1-based):", start + 1, "..", end);

const NEW = fs.readFileSync(path.join(__dirname, "_honor-block.js"), "utf8").replace(/\n$/, "").split("\n");
lines.splice(start, end - start, ...NEW);
fs.writeFileSync(HTML, lines.join("\n"), "utf8");
console.log("荣誉墙已重写，注入 " + NEW.length + " 行");
