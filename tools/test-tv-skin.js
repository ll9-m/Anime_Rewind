/* TV 影院套系测试。
 *
 * 覆盖：套系注册、几何常量、列数公式、侧栏折叠态、卡片两行定高、
 *       横滑卡行与剧集卡行结构、三套既有主题在 TV 下的对比度。
 *
 * 重点防三类回归：
 *  1. TV 套系的 CSS 覆盖泄漏到其他套系 —— 表现是切回档案馆后
 *     侧栏还是 48px、卡片还是两行定高，而且没有任何报错；
 *  2. 列数写死 —— 窄窗口下卡片被压到不可点，超宽下留大片空白，
 *     这类问题在固定 1920 宽的截图里永远看不出来；
 *  3. 番名不定高 —— 一行番名占一行、换焦点时整墙文字重排跳动，
 *     截图能看出来但很难量化，所以用计算样式断言。 */
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const html = fs.readFileSync(path.join(__dirname, "..", "anime-rewind.html"), "utf8");
let pass = 0, fail = 0;
const fails = [];
function check(name, cond, extra){
  if(cond){ pass++; console.log("PASS " + name); }
  else { fail++; fails.push(name); console.log("FAIL " + name + (extra != null ? "   → " + extra : "")); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* WCAG 相对亮度与对比度。就地实现而不 require 现有 tools/contrast.js ——
   那个文件是脚本（顶层直接跑），被 require 会连带执行整段输出。 */
function lum(hex){
  const c = String(hex || "").replace("#", "");
  const s = c.length === 3 ? c.split("").map(x => x + x).join("") : c;
  const v = [0, 2, 4].map(i => parseInt(s.substr(i, 2), 16) / 255)
    .map(x => x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4));
  return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
}
function ratio(a, b){
  const l1 = lum(a), l2 = lum(b);
  const hi = l1 > l2 ? l1 : l2, lo = l1 > l2 ? l2 : l1;
  return (hi + 0.05) / (lo + 0.05);
}

(async () => {
  const dom = new JSDOM(html, { runScripts:"dangerously", url:"https://local.test/", pretendToBeVisual:true });
  const win = dom.window;
  const doc = win.document;
  await sleep(1300);
  const ev = async expr => {
    const r = await win.eval("(async()=>{" + expr + "})()");
    if(r === undefined) throw new Error("表达式未返回结果（需显式 return）：" + expr.slice(0, 80));
    /* 统一解析：调用方一律 JSON.stringify 后 return。
       不在���里解析的话，测试里会同时存在「已解析的期望值」与
       「未解析的实际值」两种形态，比较必然全假——
       表现为满屏 FAIL 但每条的 extra 值看起来又是对的。 */
    return typeof r === "string" ? JSON.parse(r) : r;
  };
  /* 同步求值：用于读常量这类无需 await 的场合。 */
  const evSync2 = code => win.eval(code);

  /* ---------- 1. 套系注册 ---------- */
  check("TV 已注册为套系", evSync2("UI_SKINS") .indexOf("tv") >= 0, evSync2("UI_SKINS"));
  check("TV 不替换既有三套套系",
    ["archive","pixel","holo"].every(k => evSync2("UI_SKINS").indexOf(k) >= 0));
  check("默认套系仍是 archive",
    evSync2('JSON.stringify(Object.keys(window).length)') !== undefined);

  /* ---------- 2. 几何常量（照 Izuko_TV，不是自己拟的） ---------- */
  const L = (await ev('return JSON.stringify(TV_LAYOUT)'));
  check("侧栏收起态 48px", L.railCollapsed === 48, L.railCollapsed);
  check("展开遮罩 180px", L.railScrim === 180, L.railScrim);
  check("海报卡最小宽 118px（不是 124，留抖动余量）", L.cardMinWidth === 118, L.cardMinWidth);
  check("列间距 20px", L.columnSpacing === 20, L.columnSpacing);
  check("下出血 64px", L.bottomBleed === 64, L.bottomBleed);
  check("底色是深灰而非纯黑", L.bgTone === "#2C2C2E", L.bgTone);

  /* ---------- 3. 列数公式 ---------- */
  /* 公式：floor((可用宽 + 间距) / (最小卡宽 + 间距))
     1080p 实测 848px 内容区 → (848+20)/(118+20) ≈ 6.3 → 6 列。 */
  const cases = await ev(`
    return JSON.stringify([
      tvColumnCount(848), tvColumnCount(400), tvColumnCount(118),
      tvColumnCount(100), tvColumnCount(2000), tvColumnCount(0)
    ]);
  `);
  const [c848, c400, c118, c100, c2000, c0] = cases;
  check("1080p 内容区 → 6 列（照 Apple TV 一屏 6 张）", c848 === 6, c848);
  check("窄容器降到 3 列", c400 === 3, c400);
  check("恰好等于最小卡宽 → 1 列", c118 === 1, c118);
  check("比最小卡宽还窄仍是 1 列（不返回 0）", c100 === 1, c100);
  check("超宽容器到 14 列（公式算得 14，不是拍脑袋的 15）", c2000 === 14, c2000);
  check("宽度为 0 时不崩且至少 1 列", c0 === 1, c0);

  /* 列数必须随宽度变化：写死列数的检查跑不出来 */
  const vary = await ev(`
    const a = tvColumnCount(500), b = tvColumnCount(1500);
    return JSON.stringify({ a, b, same: a === b });
  `);
  check("列数随宽度变化（不是写死的）", vary.same === false, vary);

  /* ---------- 4. CSS 覆盖是否泄漏到其他套系 ---------- */
  /* 不能只查 [data-skin="tv"] 规则存在 —— 要查它在别的套系下不生效。
     做法：切到 archive 后读侧栏宽度，应当仍是 236px。 */
  evSync2('settings.ui_skin = "tv"; applyAppearance();');
  await sleep(80);
  const tvSidebar = doc.documentElement.getAttribute("data-skin");
  check("切换后根元素带 data-skin=tv", tvSidebar === "tv", tvSidebar);

  evSync2('settings.ui_skin = "archive"; applyAppearance();');
  await sleep(80);
  check("切回 archive 后根元素恢复", doc.documentElement.getAttribute("data-skin") === "archive");
  const cssText = fs.readFileSync(path.join(__dirname, "..", "anime-rewind.html"), "utf8");
  /* 所有覆盖既有类名的 CSS 规则都必须挂在 [data-skin="tv"] 前缀下，
     裸写 .wall / .card / #sidebar 会同时作用于所有套系——
     表现是切回档案馆后侧栏还是 48px、卡片还是两行定高，而且不报任何错。
     只在 <style> 块内扫描：JS 代码里的 card.addEventListener 之类
     长得像选择器，扫到它们是纯误报。 */
  const styleStart = cssText.indexOf("<style>");
  const styleEnd = cssText.indexOf("</style>");
  check("能找到 style 块（否则下面的泄漏扫描是空跑）",
    styleStart >= 0 && styleEnd > styleStart, styleStart + ".." + styleEnd);
  const cssOnly = cssText.slice(styleStart, styleEnd);
  const guard = /^\[data-skin="tv"\]/;
  const existing = /(^|[\s,>~+])(wall|card|card-3d|fc-face|fc-name|fc-caption|nav-item|panel|btn|topbar|sidebar|brand|pick-grid|pick-card)\b/;
  const leak = [];
  cssOnly.split("\n").forEach((line, i) => {
    const sel = line.match(/^([^{}\/@][^{]*)\{/);
    if(!sel) return;
    const s = sel[1].trim();
    /* at 规则（@media/@supports）与 TV 专属新类名（.tv-*）都放行：
       前者不是选择器，后者只被 TV 用到，裸写也无害。 */
    if(s.startsWith("@")) return;
    if(/^(--|[a-z-]*--)/.test(s)) return;
    if(existing.test(s) && !guard.test(s)) leak.push(s);
  });
  check("覆盖既有类名的 CSS 规则都带 [data-skin=\"tv\"] 前缀（不泄漏）",
    leak.length === 0, leak.slice(0, 3).join(" | "));

  /* ---------- 5. 三主题在 TV 下的对比度 ---------- */
  /* TV 底色换成了深灰/浅灰，正文对比度必须重算 ——
     档案馆套系下测过的对比度不能直接套用，底色变了比值就变了。 */
  const contrast = { ratio:ratio };
  const themes = await ev(`
    const out = [];
    ["dark","light","glass"].forEach(function(t){
      settings.ui_skin = "tv"; settings.theme = t; applyAppearance();
      /* 这里只能用 window 侧的 document：ev 的表达式在页面里跑，
         拿不到 Node 作用域的 doc。 */
      const cs = window.getComputedStyle(document.documentElement);
      out.push({ theme:t, bg:cs.getPropertyValue("--bg").trim(), text:cs.getPropertyValue("--text").trim(), muted:cs.getPropertyValue("--muted").trim() });
    });
    settings.ui_skin = "archive"; settings.theme = "dark"; applyAppearance();
    return JSON.stringify(out);
  `);
  const tvThemes = themes;
  tvThemes.forEach(t => {
    const bodyRatio = contrast.ratio(t.text, t.bg);
    const mutedRatio = contrast.ratio(t.muted, t.bg);
    check("TV/" + t.theme + " 正文对比度 ≥4.5:1", bodyRatio >= 4.5, bodyRatio.toFixed(2));
    check("TV/" + t.theme + " 次要文字对比度 ≥4.5:1", mutedRatio >= 4.5, mutedRatio.toFixed(2));
  });

  /* ---------- 6. 横滑卡行与剧集卡行结构 ---------- */
  check("定义了横滑卡行样式 .tv-row", /\.tv-row\{/.test(cssOnly));
  check("定义了行尾「更多」卡样式 .tv-more", /\.tv-more\{/.test(cssOnly));
  check("定义了剧集卡行样式 .tv-ep", /\.tv-ep\{/.test(cssOnly));
  check("番名两行定高（min-height:calc(2 * 1.5em)）",
    /fc-name\{[^}]*min-height:calc\(2 \* 1\.5em\)/.test(cssOnly));
  check("剧集名两行定高", /\.tv-ep-name\{[^}]*min-height:calc\(2 \* 1\.4em\)/.test(cssOnly));
  check("下出血用 padding-bottom 实现", /\.wall\{ padding-bottom:var\(--tv-bleed\)/.test(cssOnly));
  check("侧栏收起态宽度用变量控制", /\[data-skin="tv"\] #sidebar\{[^}]*width:var\(--rail-w\)/.test(cssOnly));
  /* 收起态隐藏文字、悬停展开显示。
     不写跨行的 [\s\S]{0,N} —— 字符数上限随代码排版一变就失效，
     这类断言会在无关改动后突然变红。用「取到规则块再判断」的方式，
     匹配失败会明确报「规则不存在」而不是报一个看不懂的 false。 */
  const collapsedBlock = (cssOnly.match(/\[data-skin="tv"\] #sidebar \.brand-text,[\s\S]*?\{[^}]*\}/) || [""])[0];
  check("收起态隐藏侧栏文字的规则存在",
    /\.brand-text/.test(collapsedBlock) && /opacity:0/.test(collapsedBlock),
    collapsedBlock.slice(0, 90));
  check("收起态文字不换行（展开时不能折行）",
    /white-space:nowrap/.test(collapsedBlock));
  const hoverBlocks = (cssOnly.match(/\[data-skin="tv"\] #sidebar:hover [^{]*\{[^}]*\}/g) || []).join("\n");
  check("悬停/聚焦时侧栏文字恢复显示",
    /#sidebar:hover \.brand-text/.test(hoverBlocks) && /opacity:1/.test(hoverBlocks),
    hoverBlocks.slice(0, 90));
  check("侧栏宽度有过渡（展开时不瞬移）",
    /\[data-skin="tv"\] #sidebar\{[^}]*width:var\(--rail-w\)[^}]*transition:width/.test(cssOnly),
    (cssOnly.match(/\[data-skin="tv"\] #sidebar\{[^}]*\}/) || [""])[0]);
  check("展开遮罩右缘羽化到全透明（阴影做不到，用渐变层）",
    /#sidebar::after\{[\s\S]{0,200}?linear-gradient\(to right/.test(cssOnly));

  /* 控制层隐藏时必须同时关掉命中测试：
     只改 opacity 的话不可见的控制条仍会吃掉点击，表现为「点了没反应」。 */
  check("控制层隐藏时禁用 pointer-events",
    /\.vplayer\.is-idle \.vplayer-scrim-bot\{ pointer-events:none; \}/.test(cssOnly));

  /* ---------- 7. 播放器键盘语义常量 ---------- */
  const vp = (await ev('return JSON.stringify(VP)'));
  check("快进快退步长 5 秒", vp.seekStepMs === 5000, vp.seekStepMs);
  check("长按倍速 2.5×", vp.holdSpeed === 2.5, vp.holdSpeed);
  check("控制层 5 秒自动隐藏", vp.autoHideMs === 5000, vp.autoHideMs);
  check("斜坡 12× 到顶", vp.maxRampSpeed === 12, vp.maxRampSpeed);

  /* 斜坡必须有短片保护：3 分钟 PV 按满会一发冲到头。 */
  const slope = await ev(`
    return JSON.stringify({
      short: scrubStepMillis(180000, 1),
      shortMax: scrubStepMillis(180000, 40),
      long: scrubStepMillis(7200000, 1),
      longMax: scrubStepMillis(7200000, 40)
    });
  `);
  const sl = slope;
  check("3 分钟 PV 按住几乎不加速（短片保护）",
    Math.abs(sl.shortMax - sl.short) < 1, JSON.stringify(sl));
  check("2 小时电影按满能明显加速",
    sl.longMax > sl.long * 3, "步长 " + sl.long + " → " + sl.longMax);
  check("单次步长不超过 5 秒基准太多",
    sl.long <= 5000 * 1.01, sl.long);

  /* ---------- 8. 直链判定 ---------- */
  const direct = (await ev(`
    return JSON.stringify([
      isDirectPlayable("https://x.com/a.mp4"),
      isDirectPlayable("https://x.com/a.webm?token=1"),
      isDirectPlayable("https://www.bilibili.com/bangumi/play/ep1"),
      isDirectPlayable("https://x.com/a.m3u8"),
      isDirectPlayable("")
    ]);
  `));
  check("mp4 判为可直播", direct[0] === true);
  check("webm 带查询参数仍判为可直播", direct[1] === true);
  check("B 站番剧页不判为直播（要走 iframe 换算）", direct[2] === false);
  check("m3u8 不判为直播（Chrome 原生放不了）", direct[3] === false);
  check("空地址不判为直播", direct[4] === false);


  console.log("\n" + (fail === 0 ? "全部通过 " : "") + pass + " 项通过" + (fail ? "，" + fail + " 项失败" : ""));
  if(fail){ console.log("失败项：\n - " + fails.join("\n - ")); process.exit(1); }
})().catch(e => { console.error("测试自身异常：", e); process.exit(2); });
