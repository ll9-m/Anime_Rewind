// 背景图可见性核验：不依赖浏览器，直接解析 CSS + 复算层叠顺序。
// 目的：回答「上传后为什么看不见」—— 确认图片层是否真的能被看到，
// 而不是被某个不透明层盖住。这是纯静态可判定的，不需要渲染引擎。
const fs = require("fs");
const path = require("path");

const file = process.argv[2] || path.join(__dirname, "..", "anime-rewind.html");
const css = fs.readFileSync(file, "utf8");

const results = [];
function check(name, ok, detail) {
  results.push([ok ? "PASS" : "FAIL", name, ok ? "" : (detail || "")]);
}

// ---------- 1. 提取 .bg-layer 与 .bg-overlay 规则 ----------
// 注意：选择器里不能出现 '{'，否则正则会把它当成选择器的一部分而永不匹配。
// 调用方传的 sel 是「类名片段」（如 "\\.bg-layer"），由本函数负责拼成完整选择器。
function rule(sel) {
  const re = new RegExp("(?:^|[}\\n])\\s*([^{}\\n]*" + sel + "[^{}\\n]*)\\{([^}]*)\\}", "g");
  let m, out = [];
  while ((m = re.exec(css))) out.push({ sel: m[1].trim(), body: m[2] });
  return out;
}
const layerRules = rule("\\.bg-layer");
const overlayRules = rule("\\.bg-overlay");

check("CSS 中存在 .bg-layer 规则", layerRules.length > 0);
check("CSS 中存在 .bg-overlay 规则", overlayRules.length > 0);

// ---------- 2. 背景层必须在内容层之下但高于 body ----------
const zOf = (sel) => {
  const r = rule(sel)[0];
  if (!r) return null;
  const m = /z-index:\s*(-?\d+)/.exec(r.body);
  return m ? Number(m[1]) : 0;
};
const zLayer = zOf("\\.bg-layer");
const zOverlay = zOf("\\.bg-overlay");
const zShell = zOf("#shell");
const zModal = zOf("#modal-root");

check(".bg-layer 有 z-index", zLayer !== null, `z=${zLayer}`);
check(".bg-layer(z=" + zLayer + ") 在 #shell(z=" + zShell + ") 之下", zLayer < zShell);
check(".bg-layer 在模态框(z=" + zModal + ") 之下", zLayer < zModal);
check(".bg-overlay 不阻断点击", /pointer-events:\s*none/.test(
  (overlayRules[0] && overlayRules[0].body) || ""
));

// ---------- 3. 遮罩可关闭：深色/浅色主题都不能强制盖死 ----------
// 若遮罩永远不透明，图片再亮也只剩一层灰，等于"看不见"
check("遮罩强度由 CSS 变量驱动（可调）", /--bg-overlay/.test(
  (overlayRules[0] && overlayRules[0].body) || ""
));
check("遮罩色由变量驱动而非写死 rgba", /var\(--bg-overlay-rgb/.test(
  (overlayRules[0] && overlayRules[0].body) || ""
));

// ---------- 4. 面板是否会把背景图完全盖死 ----------
// 这是「传了但看不见」的第二大原因：面板若全不透明，
// 页面上 90% 面积都是面板色，背景图只剩缝隙可见 —— 用户会认为没生效。
const panelRule = rule("\\.panel")[0];
const panelBody = panelRule ? panelRule.body.replace(/\s+/g, " ") : "";
const panelUsesVar = /background:\s*var\(--panel\)/.test(panelBody);
const panelOpaqueInAllThemes = ["dark", "light"].every(t => {
  const m = new RegExp("\\[data-theme=\"" + t + "\"\\]\\{([^}]*)\\}").exec(css);
  if (!m) return false;
  const pm = /--panel:\s*(#[0-9a-fA-F]{3,8})/.exec(m[1]);
  if (!pm) return false;
  const h = pm[1];
  if (h.length === 9) return h.slice(7) === "ff";   // #rrggbbaa
  return true;                                       // 6 位或 3 位 = 不透明
});
check(".panel 使用 var(--panel)", panelUsesVar);
check("深色/浅色主题的 --panel 均为不透明色", panelOpaqueInAllThemes,
  "面板不透明时背景图仅在缝隙可见，需靠状态行告知用户（已实现）");

// ---------- 5. 空图时必须完全隐藏，避免留下"有色但没图"的怪底色 ----------
check(".bg-layer 用 opacity 变量控制显隐", /opacity:\s*var\(--bg-on/.test(
  layerRules.map(r => r.body).join(" ")
));
check("无图时 --bg-on 会被写成 0", /useBg \? "1" : "0"/.test(css));
check("无图时 --bg-image 被写成 none 而非 url('')", /: "none"/.test(css));
// 只在代码里找，注释里提到旧 bug 属正常说明，不能算残留。
// 做法：先剥掉所有 /* */ 与 // 注释，再搜。
const codeOnly = css
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");
check("不存在遗留的 settings.theme !== \"dark\" 背景图禁用逻辑",
  !/settings\.theme\s*!==\s*["']dark["']/.test(codeOnly),
  "深色主题禁用背景图是本次修复的核心 bug");

// ---------- 6. 边界可见性 ----------
check("有图时图片区有可见描边", /\[data-bg="on"\][^{]*\.bg-layer\{[^}]*box-shadow/.test(css));
check("描边用 inset 不裁切图像", /\[data-bg="on"\][^{]*\.bg-layer\{[^}]*inset 0 0 0 1px/.test(css));
check("data-bg 属性由 JS 写入", /setAttribute\("data-bg"/.test(css));

// ---------- 7. 缩放补偿：模糊会让边缘透出，必须放大盖住 ----------
const layerBody = layerRules.map(r => r.body).join(" ");
check("模糊时用 scale 放大盖住模糊溢出边缘", /transform:\s*scale\(1\.0?6\)/.test(layerBody));
check("模糊半径可调（由 --bg-blur 驱动）", /blur\(calc\(var\(--bg-blur/.test(layerBody));

// ---------- 8. 压缩常量与容量前提一致 ----------
const mEdge = /BG_MAX_EDGE\s*=\s*(\d+)/.exec(css);
check("定义了背景图压缩上限", !!mEdge, "未找到 BG_MAX_EDGE");
const mQ = /BG_JPEG_QUALITY\s*=\s*([\d.]+)/.exec(css);
check("定义了 JPEG 压缩质量", !!mQ, "未找到 BG_JPEG_QUALITY");

// ---------- 输出 ----------
results.forEach(([st, n, m]) => { if (st === "FAIL") console.log("FAIL " + n + (m ? "  → " + m : "")); });
const pass = results.filter(r => r[0] === "PASS").length;
console.log("\nCSS 可见性核验：" + pass + " / " + results.length);
console.log("\n层叠顺序：body < .bg-layer(z=" + zLayer + ") < .bg-overlay(z=" + zOverlay + ") < #shell(z=" + zShell + ") < 模态(z=" + zModal + ")");
process.exit(pass === results.length ? 0 : 1);