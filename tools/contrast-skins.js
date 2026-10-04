/* 两套新套系的对比度实测
 *
 * 为什么必须单独测：
 * · 像素风把正文/面板/强调色整套换成 PICO-8 调色板，
 *   而 PICO-8 是为 8-bit 设备设计的"能显示"配色，不是为 WCAG 设计的。
 *   典型的 #fff1e8 配 #ff004d 就只有 3.55:1。
 * · 科技风的输入框底色是混合色，压在什么背景上取决于主题。
 *
 * 之前的 contrast.js 只覆盖 data-theme 三套，完全没管 data-skin ——
 * 这正是"加了新维度却没加测试"的典型盲区。
 */
const fs = require("fs");
const path = require("path");

const html = fs.readFileSync(path.join(__dirname, "..", "anime-rewind.html"), "utf8");

function hex2rgb(h){
  h = String(h).replace("#", "");
  if (h.length === 3) h = h.split("").map(c => c + c).join("");
  return [parseInt(h.slice(0,2),16), parseInt(h.slice(2,4),16), parseInt(h.slice(4,6),16)];
}
const lin = v => { v /= 255; return v <= 0.04045 ? v/12.92 : Math.pow((v+0.055)/1.055, 2.4); };
const lum = rgb => 0.2126*lin(rgb[0]) + 0.7152*lin(rgb[1]) + 0.0722*lin(rgb[2]);
function ratio(a, b){
  const l1 = lum(a), l2 = lum(b);
  return (Math.max(l1,l2) + 0.05) / (Math.min(l1,l2) + 0.05);
}
const mix = (fg, bg, p) => fg.map((c,i) => Math.round(c*p + bg[i]*(1-p)));
const toHex = rgb => "#" + rgb.map(c => Math.max(0,Math.min(255,c)).toString(16).padStart(2,"0")).join("");

/* 抽出 [data-skin="name"]{ ... } 里的变量，剥注释、解 var() 引用 */
function extractSkin(name){
  const re = new RegExp('\\[data-skin="' + name + '"\\]\\{([\\s\\S]*?)\\n\\}');
  const m = html.match(re);
  if (!m) return null;
  const vars = {};
  m[1].replace(/\/\*[\s\S]*?\*\//g, "")            // 剥注释，否则注释里的颜色会被当真
       .replace(/(--[\w-]+)\s*:\s*([^;]+);/g, (_, k, v) => { vars[k] = v.trim(); return ""; });
  const resolve = (key, depth) => {
    if (depth > 6 || !(key in vars)) return "";
    const vm = vars[key].match(/var\((--[\w-]+)\)/);
    return vm ? resolve(vm[1], depth+1) : vars[key];
  };
  Object.keys(vars).forEach(k => { vars[k] = resolve(k, 0); });
  return vars;
}

/* color-mix(in srgb, A p%, B) → 实色 */
function flatten(v){
  if(!v) return null;
  v = String(v).trim();
  const cm = v.match(/color-mix\(\s*in srgb\s*,\s*([^,]+?)\s*,\s*([\d.]+)%\s*,\s*(.+?)\s*\)/);
  if(cm){
    const a = hex2rgb(cm[1]), b = hex2rgb(cm[3]), p = parseFloat(cm[2])/100;
    if(a.length === 3 && b.length === 3 && isFinite(p)) return toHex(mix(a, b, p));
  }
  if(/^#[0-9a-f]{6}$/i.test(v)) return v.toLowerCase();
  if(/^#[0-9a-f]{3}$/i.test(v)) return ("#" + v.slice(1).split("").map(c=>c+c).join("")).toLowerCase();
  return null;
}

let worst = { r: 99 };
const fails = [];
function pair(label, fgRaw, bgRaw, min){
  const fg = flatten(fgRaw), bg = flatten(bgRaw);
  if(!fg || !bg){
    fails.push(label + " 颜色解析失败 fg=" + fgRaw + " bg=" + bgRaw);
    return;
  }
  const r = ratio(hex2rgb(fg), hex2rgb(bg));
  if (r < worst.r) worst = { r, where: label };
  if (r < min) fails.push(label + " = " + r.toFixed(2) + "（需 ≥" + min + "）");
  else console.log("  ✓ " + label + " = " + r.toFixed(2));
}

// ============ 像素风 ============
console.log("=== 像素风（PICO-8 调色板）===");
const px = extractSkin("pixel");
if(!px){ console.log("!! 未找到 [data-skin=\"pixel\"] 块"); process.exit(1); }
console.log("  （正文类需 ≥4.5:1，容器/边框类需 ≥3:1）\n");
pair("正文 text / panel",        px["--text"],   px["--panel"],   4.5);
pair("正文 text / panel-2",      px["--text"],   px["--panel-2"], 4.5);
pair("次级 text-2 / panel",      px["--text-2"], px["--panel"],   4.5);
pair("次级 text-2 / panel-2",    px["--text-2"], px["--panel-2"], 4.5);
pair("弱化 muted / panel",       px["--muted"],  px["--panel"],   4.5);
pair("弱化 muted / panel-2",     px["--muted"],  px["--panel-2"], 4.5);
pair("按钮文字 accent-ink / accent", px["--accent-ink"], px["--accent"], 4.5);
pair("边框 border / panel",      px["--border"], px["--panel"],   3);
pair("面板 panel / bg",          px["--panel"],  px["--bg"],      3);
/* 深底（--bg）上的元素：
   注意 #sidebar 的背景是 --panel（米色）而不是 --bg，
   真正透出 body 深蓝的是 #main（顶栏 .page-title / .page-sub）。
   所以这里测的是顶栏用的亮色令牌，不是 --text。 */
pair("深底标题 text-on-bg / bg",   px["--text-on-bg"],   px["--bg"], 4.5);
pair("深底副标 text-2-on-bg / bg", px["--text-2-on-bg"], px["--bg"], 4.5);
pair("深底分隔线 paper / bg",      px["--px-paper"],     px["--bg"], 3);

// ============ 科技风 ============
console.log("\n=== 科技风（输入框底色随主题变化）===");
// 实现：color-mix(in srgb, var(--panel-2) 88%, var(--holo-deep))
// 逐主题算实际混合结果
const HOLO_DEEP = hex2rgb("#050914");
const THEMES = {
  dark:   { panel2: "#1a222c", text: "#e8eef5", text2: "#b3c0cd", muted: "#8b9aab" },
  light:  { panel2: "#f2f5f8", text: "#111820", text2: "#3a4756", muted: "#5d6b7a" },
  glass:  { panel2: "#222c38", text: "#eaf1f8", text2: "#c1cfdd", muted: "#9fb0c1" }
};
for(const [tn, t] of Object.entries(THEMES)){
  // 实际实现是单层 color-mix(in srgb, var(--panel-2) N%, X)：
  //   深/玻璃主题 → 88% panel-2 + 12% holo-deep（深蓝）
  //   浅色主题     → 94% panel-2 +  6% 白色（提亮）
  // 早期版本脚本在这里多套了一层 mix，导致浅色主题算出近黑色 —— 那正是本次要抓的错。
  const isLight = tn === "light";
  const fieldBg = isLight
    ? mix(hex2rgb(t.panel2), hex2rgb("#ffffff"), 0.06)
    : mix(hex2rgb(t.panel2), HOLO_DEEP, 0.12);
  console.log("  [" + tn + "]  输入框底 " + toHex(fieldBg) +
    "（" + (isLight ? "94% panel-2 + 6% 白" : "88% panel-2 + 12% 深蓝") + "）");
  pair("  " + tn + " 正文 / 输入框底", t.text,  toHex(fieldBg), 4.5);
  pair("  " + tn + " 次级 / 输入框底", t.text2, toHex(fieldBg), 4.5);
  pair("  " + tn + " 弱化 / 输入框底", t.muted, toHex(fieldBg), 4.5);
  // 青色高光的可见度（非文本 ≥3:1）
  const holo = tn === "light" ? "#0a6c8a" : "#00e5ff";
  pair("  " + tn + " 青色高光 / 面板", holo, t.panel2, 3);
}

console.log("\n=== 结果 ===");
console.log("全局最差: " + worst.r.toFixed(2) + "  @  " + worst.where);
if(fails.length){
  console.log("\n不达标 " + fails.length + " 项：");
  fails.forEach(f => console.log("  · " + f));
  process.exit(1);
} else {
  console.log("全部达到 WCAG AA。");
}
