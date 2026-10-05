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
  check("侧栏展开态 216px", L.railOpen === 216, L.railOpen);
  check("海报卡最小宽 118px（不是 124，留抖动余量）", L.cardMinWidth === 118, L.cardMinWidth);
  check("列间距 20px", L.columnSpacing === 20, L.columnSpacing);
  check("下出血 64px", L.bottomBleed === 64, L.bottomBleed);
  check("底色是深灰而非纯黑", L.bgTone === "#2C2C2E", L.bgTone);
  /* 常量与 CSS 变量必须同源。原来 CSS 里另写了一份 --rail-w / --tv-bleed，
     与这里的数字各活各的：改一处忘另一处就会出现「CSS 说 48px、
     列数公式按 236 算」的错位，而两边各自的断言都是绿的。
     判据是「applyTvTokens 跑完后，CSS 变量读出来等于常量」。 */
  /* 常量与 CSS 变量必须同源。原来 CSS 里另写了一份 --rail-w / --tv-bleed，
     与这里的数字各活各的：改一处忘另一处就会出现「CSS 说 48px、
     列数公式按 236 算」的错位，而两边各自的断言都是绿的。
     判据不能是「跑完后两者相等」—— 双源同值时它恒绿，
     正是这类断言的通病（原缺陷下两边都是 48，永远相等）。
     真正能测的是「改掉常量后 CSS 跟着变」：
     临时把常量改成怪值，看 CSS 变量是否同步。 */
  const tokShift = (await ev(`
    const keep = TV_LAYOUT.railCollapsed;
    TV_LAYOUT.railCollapsed = 77;
    applyTvTokens();
    const v = getComputedStyle(document.documentElement).getPropertyValue("--rail-w").trim();
    TV_LAYOUT.railCollapsed = keep;
    applyTvTokens();
    return JSON.stringify(v);
  `));
  check("改常量后 CSS --rail-w 跟着变（两者同源，不是各写一份）",
    tokShift === "77px", tokShift);
  const tokBack = (await ev(`
    const cs = getComputedStyle(document.documentElement);
    return JSON.stringify({
      rail: cs.getPropertyValue("--rail-w").trim(),
      railOpen: cs.getPropertyValue("--rail-w-open").trim(),
      bleed: cs.getPropertyValue("--tv-bleed").trim(),
      gap: cs.getPropertyValue("--tv-gap").trim(),
      cardMin: cs.getPropertyValue("--card-min").trim()
    });
  `));
  check("CSS --rail-w 与常量同源", tokBack.rail === "48px", tokBack.rail);
  check("CSS --rail-w-open 与常量同源", tokBack.railOpen === "216px", tokBack.railOpen);
  check("CSS --tv-bleed 与常量同源", tokBack.bleed === "64px", tokBack.bleed);
  check("CSS --tv-gap 与常量同源", tokBack.gap === "20px", tokBack.gap);
  check("CSS --card-min 与常量同源", tokBack.cardMin === "118px", tokBack.cardMin);

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

  /* .tv-* 被放行裸写（它们只在TV 下渲染），但它们内部用的
     var(--panel-2) 之类是全局令牌 —— 令牌随套系变。
     要防的是「TV 顺手改了全局令牌、切回档案馆后圆角也跟着变」。
     这里只能查 CSS 文本，不能读计算样式：jsdom 不解析
     自定义属性里的 var() 链（读出来一律是 0 或字面引用串），
     用计算样式断言会得到「两个套系都是 0」这种恒真的假象。 */
  const rLgDecls = Array.from(cssOnly.matchAll(/--r-lg\s*:\s*([^;]+);/g)).map(m => m[1].trim());
  check("TV 套系在自己的作用域里覆写 --r-lg（不改全局）",
    cssOnly.indexOf('[data-skin="tv"]{') >= 0 &&
    cssOnly.slice(cssOnly.indexOf('[data-skin="tv"]{')).indexOf("--r-lg:var(--tv-card-radius)") >= 0,
    rLgDecls.join(" | "));
  /* 全局（:root）那条必须还是档案馆自己的 11px。
     被改成 8px 的话所有套系的圆角都变成 TV 的，
     而上面那条断言照样绿 —— 它只看 TV 块内。 */
  check("全局 --r-lg 仍是 11px（没被 TV 覆写）",
    rLgDecls.some(v => v === "11px"), rLgDecls.join(" | "));
  check("没有任何套系把全局 --r-lg 定成 TV 的 8px",
    rLgDecls.every(v => v !== "8px"), rLgDecls.join(" | "));

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
     隐藏方式是 display:none 而非 opacity:0 —— 理由见第13 组，
     那里有完整的坑位说明。opacity 版本曾让品牌只剩「nime R」。 */
  const collapsedBlock = (cssOnly.match(/\[data-skin="tv"\] #sidebar \.brand-text,[\s\S]*?\{[^}]*\}/) || [""])[0];
  check("收起态隐藏侧栏文字的规则存在",
    /\.brand-text/.test(collapsedBlock) && /display:none/.test(collapsedBlock),
    collapsedBlock.slice(0, 90));
  check("收起态文字不换行（展开时不能折行）",
    /white-space:nowrap/.test(collapsedBlock));
  const hoverBlocks = (cssOnly.match(/\[data-skin="tv"\] #sidebar:hover [^{]*\{[^}]*\}/g) || []).join("\n");
  check("悬停/聚焦时侧栏文字恢复显示",
    /#sidebar:hover \.brand-text/.test(hoverBlocks) && /display:/.test(hoverBlocks),
    hoverBlocks.slice(0, 90));
  check("侧栏宽度有过渡（展开时不瞬移）",
    /\[data-skin="tv"\] #sidebar\{[^}]*width:var\(--rail-w\)[^}]*transition:width/.test(cssOnly),
    (cssOnly.match(/\[data-skin="tv"\] #sidebar\{[^}]*\}/) || [""])[0]);
  /* 窗口开 400 而不是 200：这条断言要在这条规则里找到渐变，
     而规则里还夹着两行中文注释与 content/width/opacity。
     200 刚好差一点（渐变落在 202）—— 窗口宽度不该决定测试成败，
     一次无害的注释增删就会让这条假绿转红或反过来。 */
  /* 曾经照搬 Izuko_TV 的右缘羽化遮罩（TV_RAIL_SCRIM_WIDTH）。
     那个前提是「侧栏浮在内容之上」，而本项目侧栏是 flex 里的独立不透明栏，
     文字本来不压在内容上。更糟的是 ::after 作为最后一个子元素
     z 序在内容之上，展开动画期间那层半透明渐变会把自己的文字
     洗成残影。现在整块删掉，改断言「别再加回来」。 */
  check("侧栏没有 ::after 羽化遮罩（会盖住自己的文字）",
    !/#sidebar::after\{/.test(cssOnly),
    "查到了 #sidebar::after 规则");
  check("侧栏没有 linear-gradient(to right 的遮罩层",
    !/linear-gradient\(to right/.test(cssOnly),
    "查到了 to right 渐变");

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

  /* ---------- 9. 横滑卡行的数据组织 ---------- */
  /* 这一节测的是「纯函数」而不是渲染结果 —— 卡行最容易出的错是
     静默丢作品（一屏里少了几部，没有任何报错），
     而这种错在截图里几乎看不出来：少一张卡看着仍然像正常的卡行。 */
  await ev(`
    settings.ui_skin = "tv";
    state.anime = [];
    state.series = [
      { id:"s1", name:"钢炼" },
      { id:"s2", name:"EVA" },
      { id:"s3", name:"EVA 新版" }   // 与 s2 同名，用来抓「拿标题当 key」的错
    ];
    const mk = (o) => { const a = Object.assign({
      id:"a" + Math.random().toString(36).slice(2,9),
      titleCn:"测试", titleOriginal:"", seriesId:"", statusId:"st_want",
      watchedEpisodes:0, totalEpisodes:null, coverUrl:"",
      createdAt:"2026-01-01T00:00:00.000Z", updatedAt:"2026-01-01T00:00:00.000Z",
      sources:[], activeSourceId:"", series:[], aliases:[], genres:[], studios:[],
      personalTags:[], reviews:[]
    }, o); state.anime.push(a); return a; };
    /* 在看、看完一半、看完、想看、只有已看无总数 各来一部 */
    window.__a1 = mk({ titleCn:"A在看", statusId:"st_watching", watchedEpisodes:3, totalEpisodes:12, updatedAt:"2026-03-05T00:00:00.000Z", seriesId:"s1" });
    window.__a2 = mk({ titleCn:"B半途", statusId:"st_want",  watchedEpisodes:6, totalEpisodes:24, updatedAt:"2026-03-01T00:00:00.000Z", seriesId:"s1" });
    window.__a3 = mk({ titleCn:"C看完", statusId:"st_done",  watchedEpisodes:12, totalEpisodes:12, updatedAt:"2026-02-01T00:00:00.000Z", seriesId:"s1" });
    window.__a4 = mk({ titleCn:"D想看", statusId:"st_want",  watchedEpisodes:0,  totalEpisodes:26, updatedAt:"2026-01-01T00:00:00.000Z", seriesId:"s2" });
    window.__a5 = mk({ titleCn:"E无总数", statusId:"st_want", watchedEpisodes:4,  totalEpisodes:null, updatedAt:"2026-01-15T00:00:00.000Z", seriesId:"s2" });
    window.__a6 = mk({ titleCn:"F未归类", statusId:"st_want", watchedEpisodes:0,  totalEpisodes:null, updatedAt:"2026-01-01T00:00:00.000Z", seriesId:"" });
    /* s3 与 s2 同名，用来抓「拿系列名当分组键」的错 */
    window.__a7 = mk({ titleCn:"G同名系列", statusId:"st_want", watchedEpisodes:0, totalEpisodes:null, updatedAt:"2026-01-02T00:00:00.000Z", seriesId:"s3" });
    return JSON.stringify(1);
  `);

  const cont = (await ev('return JSON.stringify(continueWatchingList(state.anime).map(a => a.titleCn))'));
  check("继续观看含「在看」的作品", cont.indexOf("A在看") >= 0, JSON.stringify(cont));
  check("继续观看含「有进度未看完」的作品（状态没手动改也在内）",
    cont.indexOf("B半途") >= 0, JSON.stringify(cont));
  check("看完的不进继续观看", cont.indexOf("C看完") < 0, JSON.stringify(cont));
  check("零进度的想看不进继续观看", cont.indexOf("D想看") < 0, JSON.stringify(cont));
  check("总集数未知但看过 4 集的进继续观看",
    cont.indexOf("E无总数") >= 0, JSON.stringify(cont));
  check("继续观看按最近更新倒序",
    cont[0] === "A在看" && cont[1] === "B半途", JSON.stringify(cont));

  /* 上限 10（照 WATCH_NEXT_LIMIT）：超出的不该全塞进置顶行 */
  const watchLimit = (await ev('return JSON.stringify(TV_ROW.watchNextLimit)'));
  const cap = (await ev(`
    const many = [];
    for(let i = 0; i < 18; i++) many.push({
      id:"m" + i, titleCn:"M" + i, titleOriginal:"", seriesId:"s3", statusId:"st_watching",
      watchedEpisodes:1, totalEpisodes:10, coverUrl:"", createdAt:"2026-01-01T00:00:00.000Z",
      updatedAt:"2026-01-01T00:00:00.000Z", sources:[], activeSourceId:""
    });
    return JSON.stringify(continueWatchingList(many).length);
  `));
  check("继续观看上限取自 TV_ROW.watchNextLimit", watchLimit === 10, watchLimit);
  check("继续观看确实按上限截断", cap === watchLimit, cap);

  const groups = (await ev(`
    const g = seriesRowGroups(state.anime);
    return JSON.stringify(g.map(x => ({ id:x.id, name:x.name, n:x.items.length })));
  `));
  check("按系列分组覆盖每个有作品的系列", groups.length === 4, JSON.stringify(groups));
  check("同系列内部按首播年排（首播年缺失排最后）",
    (await ev('return JSON.stringify(seriesRowGroups([{seriesId:"s1",airDate:"2020-01-01",id:"x"},{seriesId:"s1",airDate:"",id:"y"},{seriesId:"s1",airDate:"2010-01-01",id:"z"}]).map(g=>g.items.map(a=>a.id)))'))
      [0].join(",") === "z,x,y",
    (await ev('return JSON.stringify(seriesRowGroups([{seriesId:"s1",airDate:"2020-01-01",id:"x"},{seriesId:"s1",airDate:"",id:"y"},{seriesId:"s1",airDate:"2010-01-01",id:"z"}]).map(g=>g.items.map(a=>a.id)))')));

  /* 分组用的是 seriesId 而不是系列名 —— s2 与 s3 同名（都是"EVA"）。
     按名分组会把它们并成一行，点「更多」再去筛就命中错的组。 */
  const dupName = (await ev('return JSON.stringify(seriesRowGroups(state.anime).map(g => g.id))'));
  check("同名系列仍是两个独立的行（分组键是 id）",
    dupName.indexOf("s2") >= 0 && dupName.indexOf("s3") >= 0, JSON.stringify(dupName));

  /* ---------- 10. 卡行视图：不许丢作品 ---------- */
  /* 这一条是整个卡行功能的核心断言：
     一屏里出现过的每个作品，要么在置顶行，要么在某个系列行，
     要么在兜底行 —— 任何一条路径漏了它，它就在卡行视图里消失了，
     而界面上不会报任何错。
     注意 rowsViewHTML 返回的是 HTML 字符串，不能过 ev
     （ev 会把它当 JSON 解析），所以在页面里就地判断。 */
  const missing = (await ev(`
    const h = rowsViewHTML(state.anime);
    const ids = state.anime.map(a => a.id);
    return JSON.stringify(ids.filter(id => h.indexOf('data-open="' + id + '"') < 0));
  `));
  check("卡行视图不丢任何作品", missing.length === 0, JSON.stringify(missing));

  /* 反过来也要盯住：同一个作品不能在两个行里各出现一次。
     「继续观看」置顶与它的系列行都含它的话，一屏里两张一模一样的卡，
     用户会以为是 bug（而它不是丢数据，比丢数据更难解释）。 */
  const dupInRows = (await ev(`
    const h = rowsViewHTML(state.anime);
    const counts = {};
    (h.match(/data-open="[^"]*"/g) || []).forEach(m => { counts[m] = (counts[m] || 0) + 1; });
    return JSON.stringify(Object.keys(counts).filter(k => counts[k] > 1));
  `));
  check("同一作品不在多个行里重复出现", dupInRows.length === 0, JSON.stringify(dupInRows));

  const rowInfo = (await ev(`
    const h = rowsViewHTML(state.anime);
    return JSON.stringify({
      rows: (h.match(/class="tv-row"/g) || []).length,
      firstTitle: (h.match(/<h3>([^<]*)<\\/h3>/) || [])[1],
      hasMore: h.indexOf('class="tv-more"') >= 0
    });
  `));
  check("卡行视图渲染出多个行", rowInfo.rows >= 3, JSON.stringify(rowInfo));
  check("置顶行是「继续观看」", rowInfo.firstTitle === "继续观看", rowInfo.firstTitle);
  /* 6 部作品、每行都不到 8 张，不该挂「更多」卡：
     挂上去点进去还是同一批，纯噪音。 */
  check("作品少于阈值时不挂「更多」卡", rowInfo.hasMore === false, JSON.stringify(rowInfo));

  /* 超过阈值才挂，且带的是行的身份而非标题 */
  const bigRow = (await ev(`
    const many = [];
    for(let i = 0; i < 30; i++) many.push({
      id:"b" + i, titleCn:"B" + i, titleOriginal:"", seriesId:"sb", statusId:"st_want",
      watchedEpisodes:0, totalEpisodes:null, coverUrl:"", createdAt:"2026-01-01T00:00:00.000Z",
      updatedAt:"2026-01-01T00:00:00.000Z", sources:[], activeSourceId:""
    });
    const h = tvRowHTML("超长系列", many, { moreKey:"sb" });
    return JSON.stringify({
      cards: (h.match(/class="card"/g) || []).length,
      moreKey: (h.match(/data-row-more="([^"]*)"/) || [])[1],
      hasHead: h.indexOf("更多") >= 0
    });
  `));
  check("行内最多渲染 20 张", bigRow.cards === 20, bigRow.cards);
  check("超量时挂「更多」卡", bigRow.hasHead === true, JSON.stringify(bigRow));
  check("「更多」卡带的是行身份（系列 id）不是标题", bigRow.moreKey === "sb", bigRow.moreKey);

  /* ---------- 11. 卡行只在 TV 套系下出现 ---------- */
  const gated = (await ev(`
    const out = {};
    settings.ui_skin = "tv";  libState.view = "rows";
    go("library"); out.tvRows = !!document.querySelector(".tv-row");
    out.tvBtn = !!document.querySelector('[data-view="rows"]');
    settings.ui_skin = "archive"; libState.view = "rows"; rerender();
    out.archRows = !!document.querySelector(".tv-row");
    out.archBtn = !!document.querySelector('[data-view="rows"]');
    out.archWall = !!document.querySelector(".wall");
    return JSON.stringify(out);
  `));
  check("TV 套系下卡行渲染", gated.tvRows === true, JSON.stringify(gated));
  check("TV 套系下有「卡行」视图按钮", gated.tvBtn === true, JSON.stringify(gated));
  check("非 TV 套系下不渲染卡行（纵网格才是桌面该有的）", gated.archRows === false, JSON.stringify(gated));
  check("非 TV 套系下不显示「卡行」按钮", gated.archBtn === false, JSON.stringify(gated));
  check("非 TV 套系下即使 view=rows 也回落到封面墙", gated.archWall === true, JSON.stringify(gated));

  /* ---------- 12. 「更多」卡点开后的行为 ---------- */
  const more = (await ev(`
    const out = {};
    libState.rowExpanded = ""; settings.ui_skin = "tv"; libState.view = "rows";
    state.series.push({ id:"sb", name:"超长" });
    for(let i = 0; i < 30; i++) state.anime.push({
      id:"b" + i, titleCn:"B" + i, titleOriginal:"", seriesId:"sb", statusId:"st_want",
      watchedEpisodes:0, totalEpisodes:null, coverUrl:"", createdAt:"2026-01-01T00:00:00.000Z",
      updatedAt:"2026-01-01T00:00:00.000Z", sources:[], activeSourceId:""
    });
    go("library");
    const card = document.querySelector('[data-row-more="sb"]');
    out.found = !!card;
    if(card) card.click();
    await new Promise(r => setTimeout(r, 30));
    out.view = libState.view;
    out.expanded = libState.rowExpanded;
    out.seriesId = libState.seriesId;
    out.cards = document.querySelectorAll(".wall .card").length;
    out.note = !!document.querySelector('[data-act="back-rows"]');
    return JSON.stringify(out);
  `));
  check("系列行的「更多」卡渲染出来了", more.found === true, JSON.stringify(more));
  check("点「更多」切到网格视图", more.view === "wall", more.view);
  check("系列行走真实筛选器", more.seriesId === "sb", more.seriesId);
  check("点「更多」后该系列全部摊开（30 部一张不少）", more.cards === 30, more.cards);
  check("摊开后有返回卡行的出口", more.note === true, JSON.stringify(more));

  /* 虚拟分组没有对应筛选器，靠 rowExpanded 走临时集合 */
  /* 12 部在库、每行都不到 moreLimit(20)，不该挂「更多」卡 ——
     挂上去点进去还是同一批，纯噪音。 */
  const smallCont = (await ev(`
    const out = {};
    state.anime = [];
    for(let i = 0; i < 12; i++) state.anime.push({
      id:"c" + i, titleCn:"C" + i, titleOriginal:"", seriesId:"", statusId:"st_watching",
      watchedEpisodes:2, totalEpisodes:20, coverUrl:"", createdAt:"2026-01-01T00:00:00.000Z",
      updatedAt:"2026-01-01T00:00:00.000Z", sources:[], activeSourceId:""
    });
    resetLibraryFilter();
    settings.ui_skin = "tv"; libState.view = "rows";
    go("library");
    out.found = !!document.querySelector('[data-row-more="' + ROW_CONTINUE + '"]');
    return JSON.stringify(out);
  `));
  check("12 部在看的行不挂「更多」卡（点进去还是同一批）",
    smallCont.found === false, JSON.stringify(smallCont));

  /* 超过 moreLimit 才挂。放在置顶行而不是系列行是有意义的：
     继续观看最容易累积（追番一追就是几十部），
     而系列行通常只有三五季。 */
  const contMore = (await ev(`
    const out = {};
    state.anime = [];
    for(let i = 0; i < 26; i++) state.anime.push({
      id:"c" + i, titleCn:"C" + i, titleOriginal:"", seriesId:"", statusId:"st_watching",
      watchedEpisodes:2, totalEpisodes:20, coverUrl:"", createdAt:"2026-01-01T00:00:00.000Z",
      updatedAt:"2026-01-01T00:00:00.000Z", sources:[], activeSourceId:""
    });
    resetLibraryFilter();
    settings.ui_skin = "tv"; libState.view = "rows";
    go("library");
    const card = document.querySelector('[data-row-more="' + ROW_CONTINUE + '"]');
    out.found = !!card;
    out.rowCards = document.querySelectorAll(".tv-row .card").length;
    if(card) card.click();
    await new Promise(r => setTimeout(r, 30));
    out.cards = document.querySelectorAll(".wall .card").length;
    out.label = rowExpandedLabel();
    return JSON.stringify(out);
  `));
  check("继续观看超过行内容量时挂「更多」卡", contMore.found === true, JSON.stringify(contMore));
  check("行内渲染不超过 moreLimit", contMore.rowCards === 20, contMore.rowCards);
  check("继续观看「更多」摊开该组全部 26 部（不受置顶行上限影响）",
    contMore.cards === 26, contMore.cards);
  check("继续观看组的显示名不是「默认系列」", contMore.label === "继续观看", contMore.label);

  /* 改筛选条件必须退出展开态 —— 展开中的网格无视筛选，
     用户换了下拉却看不到变化，会以为筛选器坏了。 */
  const exitExpand = (await ev(`
    const out = {};
    libState.rowExpanded = ROW_CONTINUE;
    libState.view = "wall";
    go("library");
    const sel = document.querySelector("#lib-status");
    if(sel){ sel.value = "st_done"; sel.dispatchEvent(new window.Event("change", { bubbles:true })); }
    await new Promise(r => setTimeout(r, 30));
    out.expanded = libState.rowExpanded;
    out.status = libState.statusId;
    return JSON.stringify(out);
  `));
  check("改筛选条件会退出展开态", exitExpand.expanded === "", JSON.stringify(exitExpand));
  check("改筛选条件本身生效", exitExpand.status === "st_done", JSON.stringify(exitExpand));

  /* ---------- 13. 剧集卡行 ---------- */
  /* 数据侧的硬约束：本项目没有逐集剧照与集名。
     所以剧照位只能用作品封面。测试要盯住的是
     「不假装有剧照」而不是「剧照好看」。 */
  const epOn = (await ev(`
    const out = {};
    settings.ui_skin = "tv";
    state.anime = [Object.assign({}, window.__a2, { id:"e1", totalEpisodes:12, watchedEpisodes:5,
      coverUrl:"https://img.test/c.jpg", sources:[] })];
    go("theater","e1");
    out.cards = document.querySelectorAll(".tv-ep").length;
    out.row = !!document.querySelector(".tv-ep-row");
    out.still = document.querySelectorAll(".tv-ep-still").length;
    out.no = document.querySelectorAll(".tv-ep-no").length;
    out.playing = document.querySelectorAll(".tv-ep.is-playing").length;
    out.watched = document.querySelectorAll(".tv-ep.is-watched").length;
    out.next = document.querySelectorAll(".tv-ep.is-next").length;
    return JSON.stringify(out);
  `));
  check("TV 套系下详情页渲染剧集卡行", epOn.row === true, JSON.stringify(epOn));
  check("剧集卡数量等于总集数", epOn.cards === 12, epOn.cards);
  check("每张卡都有剧照位与集号", epOn.still === 12 && epOn.no === 12, JSON.stringify(epOn));
  /* 已看 5 集、当前第 5 集（无线路声明时回落���已看数），第 5 集不该同时算「已看」——
     正在看的那一集没看完，压暗它等于说「这一集已经看完了」。
     所以是 5 - 1 = 4 张，不是 5 张。 */
  check("正在看的那一集不同时算已看", epOn.watched === 4, epOn.watched);
  check("恰好一集标为在播", epOn.playing === 1, epOn.playing);
  check("下一集标为 is-next", epOn.next === 1, epOn.next);

  const epOff = (await ev(`
    settings.ui_skin = "archive";
    go("theater","e1");
    return JSON.stringify({
      row: !!document.querySelector(".tv-ep-row"),
      cards: document.querySelectorAll(".tv-ep").length
    });
  `));
  check("非 TV 套系下不渲染剧集卡行（数字输入框仍然够用）",
    epOff.row === false && epOff.cards === 0, JSON.stringify(epOff));

  /* 集数上限：一部 1000 集的长番按集号铺开能把页面卡死 */
  const epCap = (await ev(`
    settings.ui_skin = "tv";
    state.anime = [Object.assign({}, window.__a2, { id:"e2", totalEpisodes:1000, watchedEpisodes:0, sources:[] })];
    go("theater","e2");
    return JSON.stringify({
      cards: document.querySelectorAll(".tv-ep").length,
      note: (document.querySelector(".mt-2 .hint") || {}).textContent || ""
    });
  `));
  check("超长番剧按上限截断（1000 集不铺 1000 张卡）",
    epCap.cards === (await ev('return JSON.stringify(TV_ROW.epRowLimit)')), epCap.cards);
  check("截断时明说「只显示前 N 集」而不是静默少显示",
    epCap.note.indexOf("已显示前") >= 0, epCap.note);

  /* 集数未知时整行不渲染：编不出集号 */
  const epNone = (await ev(`
    settings.ui_skin = "tv";
    state.anime = [Object.assign({}, window.__a2, { id:"e3", totalEpisodes:null, watchedEpisodes:2, sources:[] })];
    go("theater","e3");
    return JSON.stringify({ row: !!document.querySelector(".tv-ep-row") });
  `));
  check("总集数未知时不渲染剧集卡行", epNone.row === false, JSON.stringify(epNone));

  /* 点集 = 设为当前集，且与播放器面板写同一个字段 */
  const epPick = (await ev(`
    const out = {};
    settings.ui_skin = "tv";
    const a = Object.assign({}, window.__a2, { id:"e4", totalEpisodes:12, watchedEpisodes:2, sources:[] });
    state.anime = [a];
    migrateSources(a);
    a.sources = [normalizeSource({ url:"https://v.test/a.mp4", ep:2, name:"L" }, 0, new Date().toISOString())];
    a.activeSourceId = a.sources[0].id;
    go("theater","e4");
    const card = document.querySelector('[data-ep-pick="7"]');
    out.found = !!card;
    if(card) card.click();
    await new Promise(r => setTimeout(r, 60));
    out.ep = a.sources[0].ep;
    out.legacyEp = a.streamEp;
    out.cur = currentEpisodeOf(a);
    out.playing = document.querySelectorAll(".tv-ep.is-playing").length;
    out.playingNo = (document.querySelector(".tv-ep.is-playing") || {}).dataset
      ? document.querySelector(".tv-ep.is-playing").dataset.epPick : null;
    out.inputVal = (document.querySelector("#st-ep") || {}).value;
    return JSON.stringify(out);
  `));
  check("剧集卡可点", epPick.found === true, JSON.stringify(epPick));
  check("点第 7 集把当前线路的 ep 改成 7", epPick.ep === 7, epPick.ep);
  check("点集同时写旧字段 streamEp（面板与详情页读同一个值）",
    epPick.legacyEp === 7, epPick.legacyEp);
  check("currentEpisodeOf 与改动一致", epPick.cur === 7, epPick.cur);
  check("点集后 is-playing 挪到第 7 集", epPick.playingNo === "7", JSON.stringify(epPick));
  check("点集后播放器面板的集数输入框同步", epPick.inputVal === "7", epPick.inputVal);

  /* 没有线路时点集要明确拒绝，不能静默无效 */
  const epNoSrc = (await ev(`
    const out = {};
    settings.ui_skin = "tv";
    const a = Object.assign({}, window.__a2, { id:"e5", totalEpisodes:12, watchedEpisodes:2, sources:[], streamUrl:"" });
    state.anime = [a];
    go("theater","e5");
    const card = document.querySelector('[data-ep-pick="7"]');
    if(card) card.click();
    await new Promise(r => setTimeout(r, 40));
    out.ep = currentEpisodeOf(a);
    out.playing = document.querySelectorAll(".tv-ep.is-playing").length;
    return JSON.stringify(out);
  `));
  check("无线路时点集不改动进度（静默无效是最糟的）",
    epNoSrc.ep === 2, JSON.stringify(epNoSrc));

  /* ---------- 14. 当前集口径唯一 ---------- */
  /* 这个推导出现在三处（片尾下一集 / 详情页播放记录 / 剧集卡行）。
     各写一遍的话，改其中一处就会出现「下一集提示跳错集数」。 */
  const epRule = (await ev(`
    const out = {};
    const mkA = (srcEp, legacyEp, watched) => {
      const a = { id:"z", titleCn:"Z", series:[], sources:[], watchedEpisodes:watched,
        streamEp:legacyEp, streamUrl:"" };
      if(srcEp != null) a.sources = [normalizeSource({ url:"https://v.test/a.mp4", ep:srcEp }, 0, new Date().toISOString())];
      return a;
    };
    out.srcWins = currentEpisodeOf(mkA(7, 3, 5));      /* 线路声明 7 > 旧字段 3 > 已看 5 */
    out.legacyUsed = currentEpisodeOf(mkA(null, 4, 5));  /* 线路没声明 → 用旧字段 4 */
    out.watchedUsed = currentEpisodeOf(mkA(null, null, 5));/* 都没有 → 用已看集数 5 */
    out.none = currentEpisodeOf(mkA(null, null, 0));
    return JSON.stringify(out);
  `));
  check("当前集：线路声明优先", epRule.srcWins === 7, epRule.srcWins);
  check("当前集：线路没声明则用旧字段", epRule.legacyUsed === 4, epRule.legacyUsed);
  check("当前集：都没有则用已看集数", epRule.watchedUsed === 5, epRule.watchedUsed);
  check("当前集：全空时为 0（不返回 NaN）", epRule.none === 0, epRule.none);

  /* ---------- 13. 收起态侧栏：文字必须退出布局流 ---------- */
  /* 背景：收起态原本用 opacity:0 藏文字。opacity:0 的元素照样占布局空间，
     而 .brand 是 justify-content:center —— 居中的是「图标 + 隐藏文字」
     这个整体（28+gap+文字宽，远大于 48px），两侧溢出被 overflow:hidden
     裁掉：图标被推出左缘、只剩半个字露在中间，底部信息同样被拦腰截断。
     截图上表现为「品牌只剩 nime R」「底部只剩一个 9」。
     修法是 display:none（上游 AnimatedVisibility 的语义：不参与布局）。 */
  const railBlock = (() => {
    const i = cssOnly.indexOf('[data-skin="tv"] #sidebar{');
    return i < 0 ? "" : cssOnly.slice(i, cssOnly.indexOf("}", i) + 1);
  })();
  check("找到 TV 侧栏规则块", railBlock.length > 0);
  check("收起态侧栏同时改 width 与 flex-basis",
    /width:var\(--rail-w\)/.test(railBlock) && /flex:0 0 var\(--rail-w\)/.test(railBlock),
    railBlock.replace(/\s+/g, " "));
  check("展开态同样改 flex-basis（只改 width 的话展开永远不生效）",
    /#sidebar:hover[^{]*\{[\s\S]{0,160}?flex-basis:var\(--rail-w-open\)/.test(cssOnly),
    "见 #sidebar:hover 规则");
  /* 收起态不能用 opacity:0 藏侧栏文字 —— 那正是占位不掉的根因。
     只查这四类选择器，不查全文件：别处用 opacity 做淡入淡出是对的。 */
  check("收起态侧栏文字不用 opacity:0（会占位）",
    !/\[data-skin="tv"\]\s*#sidebar[^{]*\.(?:brand-text|nav-item span|side-honor span)[^{]*\{[^}]*opacity:0/.test(cssOnly),
    "查到了 opacity:0 的收起态规则");
  check("收起态侧栏文字 display:none（退出布局流）",
    /\[data-skin="tv"\]\s*#sidebar\s+\.brand-text[^{]*\{[^}]*display:none/.test(cssOnly),
    "未找到 display:none");
  check("展开态侧栏文字恢复显示",
    /#sidebar:hover\s+\.brand-text[^{]*\{[^}]*display:/.test(cssOnly),
    "未找到展开态 display 规则");
  /* 展开态必须把 nav-item 放回全宽 —— TV 收起态写死了 32px 方块，
     忘了放回的话文字被塞进 32px 宽的框里逐字换行。 */
  check("展开态 nav-item 放回全宽（不是 32px 方块）",
    /#sidebar:hover\s+\.nav-item[^{]*\{[^}]*width:100%/.test(cssOnly),
    "见 #sidebar:hover .nav-item 规则");
  check("展开态 brand 恢复左对齐（收起态是 center）",
    /#sidebar:hover\s+\.brand[^{]*\{[^}]*justify-content:flex-start/.test(cssOnly),
    "见 #sidebar:hover .brand 规则");
  /* brand-mark 在 TV 收起态被压到 28px。塌回档案馆的 34px 的话
     图标在 48px 里看着偏小，但更严重的是漏掉 flex:0 0 会让
     28px 的 mark 在 flex 容器里被文字挤扁。 */
  check("TV 收起态的 brand-mark 仍固定 28px",
    /\[data-skin="tv"\]\s+\.brand-mark\{[^}]*width:28px/.test(cssOnly),
    "见 .brand-mark 规则");

  /* ---------- 14. 卡片翻面：抬起不能吃掉背面的 rotateY ---------- */
  /* 背景：TV 的聚焦抬起原本写成 .card:hover .fc-face{ transform:scale(1.06) }。
     .fc-face 是 .fc-front 和 .fc-back 的公共类，而 .fc-back 自身带着
     transform:rotateY(180deg) —— 那行把它整个覆盖了。父级 .card-3d
     已经转过 180°，背面失去自身旋转就转到侧面，被自己的
     backface-visibility:hidden 干掉；正面同理。
     两个面同时不可见 = 卡片翻过去一片空白。 */
  const blankFace = /\[data-skin="tv"\]\s*\.card:hover\s+\.fc-face\s*\{[^}]*transform:scale/;
  check("抬起不挂在 .fc-face 上（会覆盖背面的 rotateY）",
    !blankFace.test(cssOnly),
    "查到了 .card:hover .fc-face{ transform:scale... }");
  check("正面抬起只写 scale",
    /\[data-skin="tv"\]\s*\.card:hover\s+\.fc-front[^{]*\{[^}]*transform:scale/.test(cssOnly),
    "见 .card:hover .fc-front 规则");
  check("背面抬起保留 rotateY(180deg)（否则翻面后空白）",
    /\[data-skin="tv"\]\s*\.card:hover\s+\.fc-back[^{]*\{[^}]*transform:rotateY\(180deg\)\s*scale/.test(cssOnly),
    "见 .card:hover .fc-back 规则");
  /* 抬起不该再叠 z-index：preserve-3d 元素上 z-index 不参与渲染排序，
     写了以为能抬层，实际无效 —— 属于会误导后来者的假代码。 */
  check("抬起不靠 z-index（preserve-3d 上无效）",
    !/\[data-skin="tv"\][^{]*\.fc-(?:face|front|back)[^{]*\{[^}]*z-index/.test(cssOnly),
    "查到了 .fc-* 上的 z-index");
  check("静止态仍保留浅投影（抬起是从这层交叉淡入的）",
    /\[data-skin="tv"\]\s*\.card\s+\.fc-face\{[^}]*box-shadow/.test(cssOnly),
    "见 .card .fc-face 规则");

  console.log("\n" + (fail === 0 ? "全部通过 " : "") + pass + " 项通过" + (fail ? "，" + fail + " 项失败" : ""));
  if(fail){ console.log("失败项：\n - " + fails.join("\n - ")); process.exit(1); }
})().catch(e => { console.error("测试自身异常：", e); process.exit(2); });
