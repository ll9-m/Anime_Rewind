/* 把误删的图表模块与首页渲染插回 openHonorWall 之后、refreshAll 之前。
 * 插入点用「function openHonorWall」结尾 + 「function refreshAll」起始 双重锚定，
 * 不再用行号 —— 上一次事故正是行号漂移导致的。
 */
const fs = require("fs");
const path = require("path");

const HTML = path.join(__dirname, "..", "anime-rewind.html");
const lines = fs.readFileSync(HTML, "utf8").split("\n");

// 幂等保护：已存在就不重复插入
if (lines.some(l => l.startsWith("const chartRegistry = []"))) {
  console.log("图表模块已存在，跳过");
  process.exit(0);
}

const anchor = lines.findIndex(l => l.startsWith("function refreshAll"));
if (anchor < 0) { console.error("未找到 function refreshAll 锚点"); process.exit(1); }

const charts = fs.readFileSync(path.join(__dirname, "_charts-block.js"), "utf8").replace(/\n$/, "").split("\n");
const home = fs.readFileSync(path.join(__dirname, "_home-block.js"), "utf8").replace(/\n$/, "").split("\n");

lines.splice(anchor, 0, ...charts, "", ...home, "");
fs.writeFileSync(HTML, lines.join("\n"), "utf8");
console.log("已插回图表模块(" + charts.length + "行) 与首页(" + home.length + "行)");
