#!/usr/bin/env node
/* ============================================================
   封面卡字幕可读性检查
   ------------------------------------------------------------
   背景：3D 翻转卡的正面是「白字压在封面图上」。片库里有大量
   白底/浅色官方海报，若遮罩从 transparent 渐入，浅色封面上
   白字只有 1~2:1，肉眼在正常屏上几乎不可见 —— 但深色封面上
   完全正常，所以肉眼测试永远发现不了。

   本脚本对最坏情况（纯白封面）沿渐变曲线采样，断言白字全程
   ≥4.5:1（WCAG AA 正文）。任何对 .fc-caption 渐变的改动都要
   跑一遍：node tools/caption-contrast.js
   ============================================================ */
const fs = require("fs");
const path = require("path");

const FILE = process.argv[2] || path.join(__dirname, "..", "anime-rewind.html");

/* ---------- WCAG 相对亮度与对比度 ---------- */
function lum(hex) {
  const h = hex.replace("#", "");
  const c = h.length === 3 ? h.split("").map(x => x + x).join("") : h;
  const v = [0, 2, 4].map(i => parseInt(c.substr(i, 2), 16) / 255)
    .map(x => (x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4)));
  return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
}
function ratio(a, b) {
  const l1 = lum(a), l2 = lum(b);
  const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}
/* alpha 合成：veil 以不透明度 a 覆盖在 base 上 */
function over(base, veil, a) {
  const p = h => [0, 2, 4].map(i => parseInt(h.substr(1 + i, 2), 16));
  const b = p(base), v = p(veil);
  return "#" + b.map((c, i) => Math.round(c * (1 - a) + v[i] * a).toString(16).padStart(2, "0")).join("");
}

/* ---------- 从 CSS 里解析真实的渐变曲线 ---------- */
const html = fs.readFileSync(FILE, "utf8");
const block = /\.fc-caption\{[^}]*\}/.exec(html);
if (!block) {
  console.error("未找到 .fc-caption 规则 —— 卡片结构可能被改过，请确认。");
  process.exit(1);
}
const grad = /linear-gradient\(180deg,((?:rgba?\([^)]*\)|transparent|[^,])[^;]*)\)/.exec(block[0]);
if (!grad) {
  console.error("未找到 .fc-caption 的 180deg 线性渐变，无法解析遮罩曲线。");
  process.exit(1);
}
const veil = /rgba\((\d+),\s*(\d+),\s*(\d+)/.exec(grad[1]);
if (!veil) { console.error("遮罩必须是 rgba() 形式（脚本依赖 alpha 合成）。"); process.exit(1); }
const VEIL = "#" + [veil[1], veil[2], veil[3]].map(x => (+x).toString(16).padStart(2, "0")).join("");

/* 按顶层逗号切分（括号内的逗号不切）—— 直接 split(",") 会把 rgba(4,8,14,.55) 撕成三段 */
function splitTop(src) {
  const out = [];
  let depth = 0, cur = "";
  for (const ch of src) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (ch === "," && depth === 0) { out.push(cur.trim()); cur = ""; }
    else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/* 解析 stop：transparent / rgba(r,g,b,a) [位置] / 位置
   注意 CSS 允许「颜色后跟位置」写成 rgba(...) 34%，
   所以颜色正则不能锚定 $，位置正则也不能要求颜色在前。 */
function parseStops(src) {
  return splitTop(src).map((tok, i, arr) => {
    const pos = /([\d.]+)%\s*$/.exec(tok);
    const at = pos ? (+pos[1]) / 100 : (i / Math.max(1, arr.length - 1));
    if (/^transparent$/i.test(tok)) return { at, a: 0 };
    // rgba 的第 4 个分量才是 alpha；必须允许后面还跟着位置（"rgba(...) 34%"）
    const rgba = /^rgba?\(([^)]*)\)/i.exec(tok);
    if (rgba) {
      const parts = rgba[1].split(",").map(s => s.trim());
      const a = parts.length >= 4 ? parseFloat(parts[3]) : 1;
      return { at, a: isNaN(a) ? 1 : a };
    }
    return { at, a: 1 };
  });
}
const stops = parseStops(grad[1]);
// 归一化为 [位置, alpha] 列表，按位置升序
const pts = stops.map((s, i) => ({ at: s.at == null ? i / Math.max(1, stops.length - 1) : s.at, a: s.a }))
  .sort((x, y) => x.at - y.at);

function alphaAt(t) {
  if (t <= pts[0].at) return pts[0].a;
  for (let i = 1; i < pts.length; i++) {
    if (t <= pts[i].at) {
      const [ta, aa] = [pts[i - 1].at, pts[i - 1].a];
      const [tb, ab] = [pts[i].at, pts[i].a];
      return tb === ta ? ab : aa + (ab - aa) * (t - ta) / (tb - ta);
    }
  }
  return pts[pts.length - 1].a;
}

/* ---------- 最坏情况封面 ---------- */
const COVERS = {
  "纯白海报": "#ffffff",
  "浅灰海报": "#d8dde3",
  "米色海报": "#e8e0d0",
  "亮黄海报": "#f0e68c",
  "淡蓝海报": "#cfe0ec",
};
const WHITE = "#ffffff";
const SAMPLES = [0, 0.15, 0.3, 0.45, 0.6, 0.8, 1];

console.log("=== 封面卡字幕可读性（最坏情况采样）===");
console.log("遮罩色 " + VEIL + "   曲线 " + pts.map(p => p.a.toFixed(2) + "@" + (p.at * 100).toFixed(0) + "%").join(" → "));
console.log("");
let bad = 0, globalMin = Infinity;
for (const [name, base] of Object.entries(COVERS)) {
  const row = SAMPLES.map(t => ratio(WHITE, over(base, VEIL, alphaAt(t))));
  const min = Math.min(...row);
  globalMin = Math.min(globalMin, min);
  const ok = min >= 4.5;
  if (!ok) bad++;
  console.log("  " + name.padEnd(10) + row.map(v => v.toFixed(1).padStart(5)).join(" ") +
    "   最低 " + min.toFixed(2) + "  " + (ok ? "PASS" : "FAIL"));
}
console.log("\n采样位 " + SAMPLES.map(t => (t * 100 + "%").padStart(5)).join(" "));
console.log("全局最低对比度 " + globalMin.toFixed(2) + ":1");

if (bad) {
  console.error("\n" + bad + " 种封面下未达 WCAG AA 4.5:1。");
  console.error("修法：提高 .fc-caption 渐变起点的 alpha（下限建议 ≥0.55），而不是从 transparent 渐入。");
  process.exit(1);
}
console.log("\n全部通过 WCAG AA (≥4.5:1)");
