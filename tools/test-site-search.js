/* 站点搜索型片源测试。
 * 覆盖：首页判定、搜索模板推断与拼接、搜索源的存储字段、
 *       选源必须排除它、不能设为「使用中」、详情页点击走搜索、台账徽标与按钮。
 *
 * 防回归点（每一条都对应一个真实的错法）：
 *  1. 搜索型**必须被排除在播放候选之外** —— 它顶掉能播的线路时，
 *     表现为「明明存了 B 站那条，播放却说没有可用线路」；
 *  2. 搜索型**不能被设为使用中** —— 徽标写着使用中、播放却跳过它，界面在骗人；
 *  3. 关键词必须编码进 URL：中文不编码会直接 400 / 搜空；
 *  4. kind 缺省必须是 play：老数据没有这个键，按 truthy 判断会把所有旧线路变成搜索型。 */
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

(async () => {
  const dom = new JSDOM(html, { runScripts:"dangerously", url:"https://local.test/", pretendToBeVisual:true });
  const win = dom.window;
  const doc = win.document;
  await sleep(1100);
  const ev = async expr => await win.eval("(async()=>{" + expr + "})()");

  /* ---------- 1. 站点首页判定 ---------- */
  check("https://www.bilibili.com 判为首页",
    await ev(`return isSiteHome("https://www.bilibili.com")`));
  check("带尾斜杠仍判为首页",
    await ev(`return isSiteHome("https://example.com/")`));
  check("裸域名（补协议后）判为首页",
    await ev(`return isSiteHome("example.com")`));
  check("视频页不是首页",
    !(await ev(`return isSiteHome("https://www.bilibili.com/video/BV1xx411c7mD")`)));
  check("带查询串的不是首页",
    !(await ev(`return isSiteHome("https://example.com/?a=1")`)));
  check("带 hash 路由的不是首页",
    !(await ev(`return isSiteHome("https://example.com/#/home")`)));

  /* ---------- 2. 模板推断 ---------- */
  const bili = await ev(`return JSON.stringify(searchCandidates("https://www.bilibili.com"))`);
  check("B 站认出内置搜索模板",
    JSON.parse(bili)[0] === "https://search.bilibili.com/all?keyword={kw}", bili);
  const unk = JSON.parse(await ev(`return JSON.stringify(searchCandidates("https://www.example.com"))`));
  check("陌生站点给出三种常见路由（不硬猜一个）",
    unk.length === 3 && unk[0].indexOf("{kw}") >= 0 && unk[0].indexOf("example.com") >= 0, JSON.stringify(unk));
  check("inferSearchUrl 取第一个候选",
    await ev(`return inferSearchUrl("https://www.bilibili.com") === "https://search.bilibili.com/all?keyword={kw}"`));

  /* ---------- 3. 拼 URL ---------- */
  const built = await ev(`
    return JSON.stringify({
      cn: buildSearchUrl("https://so.example.com/search?q={kw}", "启航"),
      enc: buildSearchUrl("https://so.example.com/search?q={kw}", "a b&c"),
      noTpl: buildSearchUrl("https://so.example.com/s/", "启航"),
      emptyKw: buildSearchUrl("https://so.example.com/search?q={kw}", "")
    });
  `);
  const b = JSON.parse(built);
  check("中文关键词被编码进 URL", b.cn === "https://so.example.com/search?q=%E5%90%AF%E8%88%AA", built);
  check("空格与 & 也被编码", b.enc.indexOf("a%20b%26c") >= 0, built);
  check("模板漏写 {kw} 时末尾追加（不让用户面对点了没反应）",
    b.noTpl === "https://so.example.com/s/%E5%90%AF%E8%88%AA", built);
  check("关键词为空时不拼脏数据", b.emptyKw === "https://so.example.com/search?q={kw}", built);

  /* ---------- 4. 关键词与命名 ---------- */
  check("关键词取中文名，没有再退回原名",
    await ev(`return searchKeywordFor({ titleCn:"启航", titleOriginal:"Sazae" }) === "启航" &&
                     searchKeywordFor({ titleOriginal:"Sazae" }) === "Sazae"`));
  check("站点命名：认得出的用站点名，认不出用域名",
    await ev(`return siteLabelOf("https://www.bilibili.com") === "哔哩哔哩 · 搜索" &&
                     siteLabelOf("https://www.example.com") === "www.example.com · 搜索"`));

  /* ---------- 5. 存储字段与老数据兼容 ---------- */
  const st = await ev(`
    const now = new Date().toISOString();
    const old = normalizeSource({ url:"https://a.com/v.mp4" }, 0, now);
    const s = normalizeSource({ url:"https://www.bilibili.com", kind:"search", searchUrl:"https://search.bilibili.com/all?keyword={kw}" }, 1, now);
    const fake = normalizeSource({ url:"https://a.com", kind:"search" }, 2, now);
    return JSON.stringify({
      oldKind: old.kind, oldSearch: old.searchUrl,
      sKind: s.kind, sSearch: !!s.searchUrl,
      fakeIsSearch: sourceIsSearch(fake)
    });
  `);
  const s = JSON.parse(st);
  check("老线路（无 kind）默认 play，不会被误判成搜索型",
    s.oldKind === "play" && s.oldSearch === "", st);
  check("搜索型保存 kind 与 searchUrl", s.sKind === "search" && s.sSearch === true, st);
  check("只有 kind=search 但没模板的不算搜索型（缺一半就不认）",
    s.fakeIsSearch === false, st);

  /* ---------- 6. 选源纪律 ---------- */
  const sel = await ev(`
    const now = new Date().toISOString();
    const search = normalizeSource({ url:"https://www.bilibili.com", name:"站", kind:"search", searchUrl:"https://search.bilibili.com/all?keyword={kw}", tier:0 }, 0, now);
    const play = normalizeSource({ url:"https://a.com/v.mp4", name:"可播", tier:2 }, 1, now);
    const a = { id:"A1", titleCn:"启航", sources:[search, play], activeSourceId:null };
    /* showExcluded：排除项默认不出现在返回里，
       这里要看的正是「它被排除了、原因是什么」。 */
    const rows = filterSources(a.sources, { showExcluded:true });
    const pick = autoSelect(rows, {});
    const res = await setActiveSource({ anime:a, source:search });
    return JSON.stringify({
      searchExcluded: rows.find(r => r.original.id === search.id).reason,
      picked: pick.source ? pick.source.name : null,
      active: res.ok, reason: res.reason,
      usable: sourceUsable(search),
      why: sourceUnusableReason(search)
    });
  `);
  const sl = JSON.parse(sel);
  check("搜索型被排除在播放候选之外（reason=search_only）", sl.searchExcluded === "search_only", sel);
  check("自动选源选中真正能播的那条，不被搜索型顶掉", sl.picked === "可播", sel);
  check("搜索型不能设为使用中", sl.active === false && sl.reason === "search_only", sel);
  check("搜索型不是「可用线路」，且原因说清是搜索型", sl.usable === false && sl.why.indexOf("搜索型") >= 0, sel);

  /* ---------- 7. 详情页：胶囊与点击 ---------- */
  await ev(`
    state.anime = [{
      id:"A1", titleCn:"启航", totalEpisodes:12, watchedEpisodes:0, statusId:"st_want",
      sources:[
        { id:"s1", url:"https://www.bilibili.com", name:"B站搜索", kind:"search",
          searchUrl:"https://search.bilibili.com/all?keyword={kw}", enabled:true,
          subtitleKind:"EXTERNAL", tier:2, savedAt:"", health:{state:"unknown",at:"",detail:""} },
        { id:"s2", url:"https://a.com/v.mp4", name:"直链", kind:"play",
          enabled:true, subtitleKind:"EXTERNAL", tier:2, savedAt:"", health:{state:"unknown",at:"",detail:""} }
      ],
      activeSourceId:"s2", aliases:[], genres:[], studios:[], personalTags:[], reviews:[]
    }];
    window.__opened = null;
    window.open = (u) => { window.__opened = u; return null; };
    go("theater", "A1");
  `);
  const cap = await ev(`
    const caps = Array.from(document.querySelectorAll("[data-st-line]"));
    const s1 = caps.find(c => c.dataset.stLine === "s1");
    return JSON.stringify({
      count: caps.length,
      text: s1 ? s1.textContent : null,
      hasSearchIcon: !!(s1 && s1.innerHTML.indexOf("circle") >= 0)
    });
  `);
  const cp = JSON.parse(cap);
  check("搜索型胶囊显示「搜《片名》」", cp.text && cp.text.indexOf("搜《启航》") >= 0, cap);
  check("胶囊渲染出搜索图标", cp.hasSearchIcon === true, cap);

  const clicked = await ev(`
    document.querySelector('[data-st-line="s1"]').click();
    await new Promise(r => setTimeout(r, 60));
    const kw = document.querySelector("#ss-kw");
    const url = document.querySelector("#ss-url");
    const out = { hasModal: !!kw, kw: kw ? kw.value : null, url: url ? url.value : null };
    if(document.querySelector("#ss-go")) document.querySelector("#ss-go").click();
    await new Promise(r => setTimeout(r, 60));
    out.opened = window.__opened;
    return JSON.stringify(out);
  `);
  const ck = JSON.parse(clicked);
  check("点搜索型胶囊弹出确认框，关键词预填片名", ck.hasModal === true && ck.kw === "启航", clicked);
  check("确认框里给出将打开的完整网址",
    ck.url === "https://search.bilibili.com/all?keyword=%E5%90%AF%E8%88%AA", clicked);
  check("点「打开搜索」带编码后的片名打开新标签",
    ck.opened === "https://search.bilibili.com/all?keyword=%E5%90%AF%E8%88%AA", clicked);

  /* 改关键词后打开的是改过的词 */
  const edited = await ev(`
    document.querySelector('[data-st-line="s1"]').click();
    await new Promise(r => setTimeout(r, 60));
    const kw = document.querySelector("#ss-kw");
    kw.value = "启航 第二季";
    kw.dispatchEvent(new Event("input"));
    document.querySelector("#ss-go").click();
    await new Promise(r => setTimeout(r, 60));
    return window.__opened;
  `);
  check("关键词可改，打开的网址跟着改",
    String(edited).indexOf("%E5%90%AF%E8%88%AA%20%E7%AC%AC%E4%BA%8C%E5%AD%A3") >= 0, String(edited));

  /* ---------- 8. 台账：徽标与按钮 ---------- */
  const led = await ev(`
    const rows = sourceLedger();
    const r = rows.find(x => x.source.id === "s1");
    const flags = sourceFlags(r);
    return JSON.stringify({
      flagIds: flags.map(f => f.id),
      flagTexts: flags.map(f => f.text)
    });
  `);
  const lj = JSON.parse(led);
  check("台账给搜索型打「搜索型」徽标", lj.flagIds.indexOf("search") >= 0, led);
  check("搜索型不会同时挂「使用中」（它播不了）", lj.flagTexts.indexOf("使用中") < 0, led);

  await ev("go('sources')");
  const btn = await ev(`
    const tr = Array.from(document.querySelectorAll("tr[data-key]")).find(t => t.dataset.key.indexOf("s1") >= 0);
    const searchBtn = tr ? tr.querySelector('[data-act="search"]') : null;
    const useBtn = tr ? tr.querySelector('[data-act="use"]') : null;
    return JSON.stringify({ hasSearch: !!searchBtn, hasUse: !!useBtn });
  `);
  const bj = JSON.parse(btn);
  check("台账搜索型行给的是「搜索」按钮而不是「设为使用中」",
    bj.hasSearch === true && bj.hasUse === false, btn);

  console.log("");
  console.log("== 站点搜索型片源测试：pass=" + pass + " fail=" + fail + " ==");
  if(fails.length){ console.log("失败项：\n - " + fails.join("\n - ")); process.exit(1); }
})().catch(e => { console.error("测试脚本异常：", e); process.exit(1); });
