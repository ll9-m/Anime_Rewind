// 背景图开启后的文字对比度实测。
// 关键风险：面板是半透明/模糊的，底色不再是纯 --panel，
// 而是「面板色 ⊕ 遮罩 ⊕ 背景图」的混合结果。纯色主题下测过的对比度
// 在这里不再成立 —— 必须按最坏情况的背景图亮度重算。
const fs = require("fs");
const path = require("path");

function srgbToLin(c) {
  c = c / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
function lum(rgb) {
  return 0.2126 * srgbToLin(rgb[0]) + 0.7152 * srgbToLin(rgb[1]) + 0.0722 * srgbToLin(rgb[2]);
}
function ratio(a, b) {
  const l1 = lum(a), l2 = lum(b);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}
function hex2rgb(h) {
  h = h.replace("#", "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
function mix(a, b, alpha) {
  // a 覆盖在 b 之上，alpha 为 a 的不透明度
  return [0, 1, 2].map((i) => Math.round(a[i] * alpha + b[i] * (1 - alpha)));
}

const THEMES = {
  dark:  { panel: "#141a22", bg: "#0d1117", text: "#e8eef5", text2: "#b3c0cd", muted: "#8b9aab", accent: "#22d3ee", overlayRGB: [6, 10, 16] },
  light: { panel: "#fbfcfd", bg: "#eceff3", text: "#111820", text2: "#3a4756", muted: "#5d6b7a", accent: "#0b7186", overlayRGB: [255, 255, 255] },
  glass: { panel: "#1a222c", bg: "#0f151c", text: "#eaf1f8", text2: "#c1cfdd", muted: "#9fb0c1", accent: "#22d3ee", overlayRGB: [6, 10, 16] }
};

// 背景图最坏情况采样：纯黑、纯白、以及几种高饱和色
const BG_SAMPLES = {
  "纯黑海报": [0, 0, 0],
  "纯白海报": [255, 255, 255],
  "亮黄海报": [250, 230, 90],
  "亮青海报": [90, 230, 240],
  "中灰海报": [128, 128, 128]
};

const OVERLAY_SETTING = 0.42;  // settings.bg_overlay 默认（用户设定值）
const OVERLAY_MAX = 0.92;      // 滑块上限
const ALPHA = { dark: 1, light: 1, glass: 0.85 };

// 与 anime-rewind.html 的 bgRequiredOverlay() 保持一致：
// 取「让纯黑与纯白两种极端背景都达标」的最小遮罩，作为实际渲染下限。
const TINTS = { dark: [6, 10, 16], light: [255, 255, 255], glass: [6, 10, 16] };
const TEXTS = { dark: "#e8eef5", light: "#111820", glass: "#eaf1f8" };
function requiredOverlay(theme) {
  const tint = TINTS[theme], text = hex2rgb(TEXTS[theme]);
  let best = 0;
  for (const raw of [[0, 0, 0], [255, 255, 255]]) {
    for (let o = 0; o <= 0.9601; o += 0.02) {
      if (ratio(text, mix(tint, raw, o)) >= 4.6) { best = Math.max(best, o); break; }
    }
  }
  return Math.min(OVERLAY_MAX, Math.ceil(best * 50) / 50);
}

let worst = { r: 99 };
let fails = 0;

for (const [tname, t] of Object.entries(THEMES)) {
  const req = requiredOverlay(tname);
  const eff = Math.max(OVERLAY_SETTING, req);   // 实际生效遮罩
  console.log("[" + tname + "]  面板不透明度 " + ALPHA[tname] +
    "  设定遮罩 " + OVERLAY_SETTING + " → 实际 " + eff + (eff > OVERLAY_SETTING ? "（已自动兜底）" : ""));
  const panelRGB = hex2rgb(t.panel);
  for (const [bname, bgRGB] of Object.entries(BG_SAMPLES)) {
    const toned = mix(t.overlayRGB, bgRGB, eff);
    const effectivePanel = mix(panelRGB, toned, ALPHA[tname]);
    const row = [];
    for (const [label, fg] of [["text", t.text], ["text-2", t.text2], ["muted", t.muted], ["accent", t.accent]]) {
      const r = ratio(hex2rgb(fg), effectivePanel);
      row.push(label + " " + r.toFixed(2));
      if (r < worst.r) worst = { r, t: tname, bg: bname, label };
      if (r < 4.5) fails++;
    }
    console.log("  " + bname.padEnd(10, "　") + row.join("   "));
  }
  console.log("");
}

// 未开启面板遮罩的裸露区域：正文直接落在「背景图 + 遮罩」上。
// 这是唯一真正依赖遮罩的地方 —— 也正是旧代码漏掉、导致深色主题下正文读不清的地方。
console.log("[裸露背景区]  无面板遮挡，正文直接落在背景图上（实际遮罩）");
for (const [tname, t] of Object.entries(THEMES)) {
  const eff = Math.max(OVERLAY_SETTING, requiredOverlay(tname));
  const row = [];
  for (const [bname, bgRGB] of Object.entries(BG_SAMPLES)) {
    const toned = mix(t.overlayRGB, bgRGB, eff);
    const r = ratio(hex2rgb(t.text), toned);
    row.push(bname + " " + r.toFixed(2));
    if (r < worst.r) worst = { r, t: tname, bg: bname, label: "text(裸露)" };
    if (r < 4.5) fails++;
  }
  console.log("  " + tname.padEnd(6, "　") + row.join("   "));
}
console.log("");

console.log("最差组合: " + worst.t + " / " + worst.bg + " / " + worst.label + " = " + worst.r.toFixed(2) + ":1");
if (fails === 0 && worst.r >= 4.5) {
  console.log("全部通过 WCAG AA (≥4.5:1)");
} else {
  console.log("存在 " + fails + " 处低于 4.5:1 —— 需要提高遮罩或面板不透明度");
  process.exit(1);
}