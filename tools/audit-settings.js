// 枚举设置页所有 data-set 绑定，与 DEFAULT_SETTINGS 做双向差集
const fs = require("fs");
const html = fs.readFileSync("D:/env/projects/Anime_Rewind/anime-rewind.html", "utf8");

// 1. DEFAULT_SETTINGS 的键
const defBlock = /const DEFAULT_SETTINGS = \{([\s\S]*?)\n\};/.exec(html);
if (!defBlock) { console.log("!! 未找到 DEFAULT_SETTINGS"); process.exit(1); }
const defKeys = new Set();
const defRe = /^\s{2}([a-zA-Z_][a-zA-Z0-9_]*)\s*:/gm;
let m;
while ((m = defRe.exec(defBlock[1]))) defKeys.add(m[1]);

// 2. 设置页 HTML 里所有 data-set="..."
const used = new Map(); // key -> 出现次数
const useRe = /data-set="([^"]+)"/g;
while ((m = useRe.exec(html))) {
  const k = m[1];
  if (!used.has(k)) used.set(k, []);
  used.get(k).push((html.slice(0, m.index).match(/\n/g) || []).length + 1);
}

console.log("DEFAULT_SETTINGS 键 (" + defKeys.size + "): " + [...defKeys].sort().join(", "));
console.log("\n设置页 data-set 键 (" + used.size + "):");
for (const [k, lines] of used) {
  const known = defKeys.has(k);
  console.log("  " + (known ? "OK  " : "缺失 ") + k.padEnd(22) + " 行 " + lines.join(","));
}

const orphans = [...used.keys()].filter(k => !defKeys.has(k));
console.log("\n=== data-set 存在但 DEFAULT_SETTINGS 没有（点击后会写入 undefined 键）===");
if (!orphans.length) console.log("  无");
else orphans.forEach(k => console.log("  " + k));

// 3. 反向：DEFAULT_SETTINGS 有但设置页没有 UI（不可达设置）
const orphans2 = [...defKeys].filter(k => !used.has(k));
console.log("\n=== DEFAULT_SETTINGS 有但设置页无控件（只能靠导入/默认）===");
if (!orphans2.length) console.log("  无");
else orphans2.forEach(k => console.log("  " + k));

// 4. 硬编码状态 ID 出现处（改自定义状态会失效）
console.log("\n=== 硬编码状态 ID 的位置 ===");
const lines = html.split("\n");
lines.forEach((l, i) => {
  if (/"st_(want|watching|done|hold|drop)"/.test(l) && !/SYSTEM_STATUSES|id:\s*"st_/.test(l)) {
    console.log("  " + (i + 1) + ": " + l.trim().slice(0, 120));
  }
});
