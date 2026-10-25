/* 自定义抓取数据源测试。
 * 覆盖：配置归一/校验、选择器取值（文本/属性/多值）、HTML 与 JSON 两种
 * 搜索解析、代理壳拆包、searchAll 并行聚合与错误隔离、详情页补全、
 * 设置页管理界面（列表/表单开关）。
 * 网络全部用 stub fetch，不真联网。 */
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const html = fs.readFileSync(path.join(__dirname, "..", "anime-rewind.html"), "utf8").replace(/\r\n/g, "\n");
let pass = 0, fail = 0;
const fails = [];
function check(name, cond, extra){
  if(cond){ pass++; console.log("PASS " + name); }
  else { fail++; fails.push(name); console.log("FAIL " + name + (extra != null ? "   → " + extra : "")); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

const SEARCH_HTML = `<!doctype html><html><body>
  <div class="result">
    <a class="t" href="/anime/1024.html">犬夜叉</a>
    <img data-src="https://img.example/1024.jpg">
    <span class="meta">2000年 · 全167话</span>
  </div>
  <div class="result">
    <a class="t" href="/anime/2048.html">犬夜叉 完结篇</a>
    <img data-src="https://img.example/2048.jpg">
    <span class="meta">2009年</span>
  </div>
  <div class="result"><span class="t">没有链接的一条</span></div>
</body></html>`;

const DETAIL_HTML = `<!doctype html><html><body>
  <h1 class="title">犬夜叉（补全版）</h1>
  <div class="orig">Inuyasha</div>
  <div class="cover"><img src="/covers/big/1024.jpg"></div>
  <span class="date">2000-10-16</span>
  <span class="eps">全 167 话</span>
  <div class="desc">战国时代的冒险故事。</div>
  <ul class="genres"><span>奇幻</span><span>冒险</span></ul>
  <span class="studio">SUNRISE</span>
  <span class="score">8.6</span>
</body></html>`;

(async () => {
  const dom = new JSDOM(html, { runScripts:"dangerously", url:"https://local.test/", pretendToBeVisual:true });
  const win = dom.window;
  await sleep(1100);
  const ev = async expr => await win.eval("(async()=>{" + expr + "})()");

  /* ---------- 1. 配置归一与校验 ---------- */
  const r1 = await ev(`
    const cs = normalizeCustomSource({ name:"  我的站  ", searchUrl:" https://e.com/s?q={kw} ", mode:"json" });
    return JSON.stringify({ id: /^cs_[\\w-]+$/.test(cs.id), name: cs.name, mode: cs.mode, enabled: cs.enabled });
  `);
  const c1 = JSON.parse(r1);
  check("normalize：名称去空白、缺省 mode=html/enabled、生成 cs_ id",
    c1.id === true && c1.name === "我的站" && c1.mode === "json" && c1.enabled === true, r1);

  const v1 = await ev(`
    return [ customSourceValidate(normalizeCustomSource({ name:"", searchUrl:"https://e.com" })),
             customSourceValidate(normalizeCustomSource({ name:"x", searchUrl:"ftp://e.com" })),
             customSourceValidate(normalizeCustomSource({ name:"x", searchUrl:"https://e.com/s?q={kw}", itemSelector:".r", fields:{ title:".t", link:"a@href" } })),
             customSourceValidate(normalizeCustomSource({ name:"x", searchUrl:"https://e.com/api", mode:"json", listPath:"data.items", jfields:{ title:"name" } })) ];
  `);
  check("validate：名称/协议/html 字段/json 路径四类拦截",
    v1[0] !== "" && v1[1] !== "" && v1[2] === "" && v1[3] === "", JSON.stringify(v1));

  /* ---------- 2. 选择器取值 ---------- */
  const r2 = await ev(`
    const doc = new DOMParser().parseFromString(${JSON.stringify(SEARCH_HTML)}, "text/html");
    return JSON.stringify({
      text: extractBySpec(doc, ".result .t", false),
      attr: extractBySpec(doc, ".result img@data-src", false),
      multi: extractBySpec(doc, ".genres span", true),
      none: extractBySpec(doc, ".nope", false)
    });
  `);
  const c2 = JSON.parse(r2);
  check("extractBySpec：文本/属性/多值/未命中", c2.text === "犬夜叉" && c2.attr === "https://img.example/1024.jpg"
    && Array.isArray(c2.multi) && c2.none === "", r2);

  /* ---------- 3. HTML 搜索解析（stub fetch） ---------- */
  await ev(`
    win = window;
    window.__fetchLog = [];
    window.fetch = async (url) => {
      window.__fetchLog.push(String(url));
      return { ok:true, status:200, headers:new Headers(), text: async () => ${JSON.stringify(SEARCH_HTML)}, json: async () => ({}) };
    };
  `);
  const r3 = await ev(`
    const cs = normalizeCustomSource({ name:"测试站", searchUrl:"https://e.com/s?q={kw}",
      itemSelector:".result", fields:{ title:".t", link:"a.t@href", cover:"img@data-src", meta:".meta" } });
    const list = await searchCustomSource(cs, "犬夜叉");
    return JSON.stringify({
      n: list.length,
      url: window.__fetchLog[0],
      first: list[0] && { t: list[0].titleCn, link: list[0].sourceId, cover: list[0].coverUrl, date: list[0].airDate, src: list[0].source },
      second: list[1] && list[1].titleCn
    });
  `);
  const c3 = JSON.parse(r3);
  check("HTML 搜索：条目解析、相对链接补全、{kw} 替换",
    c3.n === 3 && c3.url === "https://e.com/s?q=" + encodeURIComponent("犬夜叉")
    && c3.first && c3.first.t === "犬夜叉" && c3.first.link === "https://e.com/anime/1024.html"
    && c3.first.cover === "https://img.example/1024.jpg" && c3.first.date === "2000"
    && c3.first.src === c3.first.src, r3);
  check("HTML 搜索：缺链接的条目按标题兜底 id", c3.second === "犬夜叉 完结篇", r3);

  /* ---------- 4. JSON 模式 + 代理壳 ---------- */
  const payload = JSON.stringify({ contents: JSON.stringify({ data: { items: [
    { name:"钢之炼金术师", url:"https://e.com/4096", cover:"https://img.example/4096.jpg", year:"2003" },
    { name:"无链接条目" }
  ] } }) });
  await ev(`
    window.fetch = async () => ({ ok:true, status:200, headers:new Headers(), text: async () => ${JSON.stringify(payload)}, json: async () => { throw new Error("不是对象"); } });
  `);
  const r4 = await ev(`
    const cs = normalizeCustomSource({ name:"JSON站", searchUrl:"https://e.com/api?kw={kw}", mode:"json",
      listPath:"data.items", jfields:{ title:"name", link:"url", cover:"cover", meta:"year" } });
    const list = await searchCustomSource(cs, "钢炼");
    return JSON.stringify({ n: list.length, first: list[0] && { t: list[0].titleCn, link: list[0].sourceId, date: list[0].airDate } });
  `);
  const c4 = JSON.parse(r4);
  check("JSON 模式：列表路径/字段路径、代理壳自动拆包",
    c4.n === 2 && c4.first && c4.first.t === "钢之炼金术师" && c4.first.link === "https://e.com/4096" && c4.first.date === "2003", r4);

  /* ---------- 5. searchAll 聚合与错误隔离 ---------- */
  await ev(`
    settings.src_bangumi_enabled = false;
    settings.src_anilist_enabled = false;
    settings.custom_sources = [ normalizeCustomSource({ id:"cs_test1", name:"好站", searchUrl:"https://good.com/s?q={kw}",
        itemSelector:".result", fields:{ title:".t", link:"a.t@href" } }),
      normalizeCustomSource({ id:"cs_test2", name:"坏站", searchUrl:"https://bad.com/s?q={kw}",
        itemSelector:".result", fields:{ title:".t", link:"a.t@href" } }) ];
    saveCustomSources(settings.custom_sources);
    window.fetch = async (url) => {
      if(String(url).indexOf("good.com") >= 0) return { ok:true, status:200, headers:new Headers(), text: async () => ${JSON.stringify(SEARCH_HTML)} };
      throw new TypeError("Failed to fetch");
    };
  `);
  const r5 = await ev(`
    const out = await searchAll("犬夜叉");
    return JSON.stringify({
      n: out.results.length,
      src: out.sources.map(s => s.name + (s.ok ? ":ok" : ":fail")).join(","),
      badErr: (out.errors.find(e => e.name === "坏站") || {}).message || ""
    });
  `);
  const c5 = JSON.parse(r5);
  check("searchAll：自定义源并行聚合", c5.n === 3, r5);
  check("searchAll：一个源失败不影响另一个", c5.src.indexOf("好站:ok") >= 0 && c5.src.indexOf("坏站:fail") >= 0, r5);
  check("searchAll：失败源给出可读错误", c5.badErr.indexOf("网络错误") >= 0 || c5.badErr.length > 0, r5);

  /* 全部关闭时的提示 */
  const r5b = await ev(`
    saveCustomSources(customSources().map(s => Object.assign({}, s, { enabled:false })));
    const out = await searchAll("x");
    return JSON.stringify({ msg: (out.errors[0] || {}).message });
  `);
  check("searchAll：全部数据源关闭时提示", (JSON.parse(r5b).msg || "").indexOf("关闭") >= 0, r5b);

  /* ---------- 6. 详情页补全 ---------- */
  await ev(`
    saveCustomSources([ normalizeCustomSource({ id:"cs_test1", name:"好站", searchUrl:"https://good.com/s?q={kw}",
      itemSelector:".result", fields:{ title:".t", link:"a.t@href" }, detailEnabled:true,
      detailSelectors:{ titleCn:".title", titleOriginal:".orig", cover:".cover img@src", airDate:".date",
        totalEpisodes:".eps", summary:".desc", genres:".genres span", studios:".studio", communityScore:".score" } }) ]);
    window.fetch = async (url) => ({ ok:true, status:200, headers:new Headers(),
      text: async () => String(url).indexOf("detail") >= 0 ? ${JSON.stringify(DETAIL_HTML)} : ${JSON.stringify(SEARCH_HTML)} });
  `);
  const r6 = await ev(`
    const cs = customSources()[0];
    const base = { id:"l1", sourceId:"https://good.com/detail/1024.html", source:cs.id, sourceLabel:cs.name,
      titleCn:"犬夜叉", titleOriginal:"", coverUrl:"", airDate:"", totalEpisodes:null, summary:"", genres:[], studios:[] };
    const full = await enrichCustomCandidate(base, cs);
    return JSON.stringify({
      t: full.titleCn, orig: full.titleOriginal, cover: full.coverUrl, date: full.airDate,
      eps: full.totalEpisodes, sum: full.summary, genres: full.genres, studios: full.studios,
      score: full.communityScore, sid: full.sourceIds && full.sourceIds[cs.id]
    });
  `);
  const c6 = JSON.parse(r6);
  check("详情补全：非空字段覆盖、空字段不清掉",
    c6.t === "犬夜叉（补全版）" && c6.orig === "Inuyasha" && c6.cover === "https://good.com/covers/big/1024.jpg"
    && c6.date === "2000-10-16" && c6.eps === 167 && c6.sum === "战国时代的冒险故事。"
    && JSON.stringify(c6.genres) === JSON.stringify(["奇幻","冒险"])
    && JSON.stringify(c6.studios) === JSON.stringify(["SUNRISE"]) && c6.score === 8.6, r6);
  check("详情补全：sourceIds 记到源上", c6.sid === "https://good.com/detail/1024.html", r6);

  /* ---------- 7. 设置页管理界面 ---------- */
  await ev(`
    saveCustomSources([ normalizeCustomSource({ id:"cs_ui1", name:"界面站", searchUrl:"https://ui.com/s?q={kw}",
      itemSelector:".r", fields:{ title:".t", link:"a@href" } }) ]);
    settingsState.tab = "source";
    go("settings");
  `);
  await sleep(300);
  const doc = win.document;
  check("设置页：自定义源列表渲染", !!Array.from(doc.querySelectorAll("b")).find(b => b.textContent === "界面站"));
  check("设置页：添加按钮存在", !!doc.querySelector('[data-act="cs-add"]'));
  check("设置页：编辑/删除按钮存在",
    !!doc.querySelector('[data-act="cs-edit"]') && !!doc.querySelector('[data-act="cs-del"]'));
  /* 打开表单 */
  doc.querySelector('[data-act="cs-edit"]').click();
  await sleep(200);
  check("表单：编辑模式回填名称", (doc.querySelector("#cs-name") || {}).value === "界面站");
  check("表单：html/json 块随模式切换", doc.querySelector("#cs-html-block").hidden === false && doc.querySelector("#cs-json-block").hidden === true);
  doc.querySelector("#cs-mode").value = "json";
  doc.querySelector("#cs-mode").dispatchEvent(new win.Event("change"));
  check("表单：切到 JSON 模式后隐藏 HTML 块", doc.querySelector("#cs-html-block").hidden === true && doc.querySelector("#cs-json-block").hidden === false);
  win.eval("closeModal()");

  /* ---------- 8. 导入白名单带走 custom_sources ---------- */
  const r8 = await ev(`
    const p = { app: APP_KEY, settings: { custom_sources: [ { id:"cs_imp", name:"导入站", searchUrl:"https://i.com/s?q={kw}", mode:"html", itemSelector:".r", fields:{ title:".t", link:"a@href" } } ] } };
    const an = analyzeImport(p);
    return JSON.stringify({ carried: !!an.settingPatch.custom_sources && an.settingPatch.custom_sources.length === 1 });
  `);
  check("导入：custom_sources 进设置白名单", JSON.parse(r8).carried === true, r8);

  /* ---------- 9. 预置模板（萌娘百科 / 必应中国，2026-10 实测结构） ---------- */
  /* fetch 桩在运行时用 JSON.stringify 拼接：模板字符串会提前消化 \n 转义，
     把多行 fixture 拆断成非法字符串字面量。 */
  const stubFetchWith = async (fx) => {
    const code = "(async()=>{ window.fetch = async () => ({ ok:true, status:200, headers:new Headers(), text: async () => " + JSON.stringify(fx) + " }); })()";
    await win.eval(code);
  };
  const MOE_FIXTURE = "<ul class=\"mw-search-results\">\n  <li class=\"mw-search-result mw-search-result-ns-0\">\n    <div class=\"mw-search-result-heading\"><a href=\"/%E7%8A%AC%E5%A4%9C%E5%8F%89\" title=\"犬夜叉\"><span class=\"searchmatch\">犬夜叉</span></a></div>\n    <div class=\"searchresult\">从2001年至2004年，每年都推出《犬夜叉》剧场版。</div>\n  </li>\n  <li class=\"mw-search-result mw-search-result-ns-0\">\n    <div class=\"mw-search-result-heading\"><a href=\"/%E6%A1%94%E6%A2%97\" title=\"桔梗\">桔梗</a></div>\n    <div class=\"searchresult\">《犬夜叉》中的角色。</div>\n  </li>\n</ul>";
  const BING_FIXTURE = "<ol id=\"b_results\"><li class=\"b_algo\">\n  <h2><a href=\"https://baike.baidu.com/item/%E7%8A%AC%E5%A4%9C%E5%8F%89/26878\">犬夜叉（1996年高桥留美子创作的少年漫画）</a></h2>\n  <div class=\"b_caption\"><p class=\"b_lineclamp2\">《犬夜叉》是高桥留美子创作的漫画作品。</p></div>\n</li><li class=\"b_algo\">\n  <h2><a href=\"https://www.bilibili.com/bangumi/play/ep289986\">犬夜叉 - 哔哩哔哩番剧</a></h2>\n  <div class=\"b_caption\"><p>2000年开播的TV动画。</p></div>\n</li></ol>";
  const r9 = await ev(`
    const ok = PRESET_CUSTOM_SOURCES.map(p => customSourceValidate(normalizeCustomSource(p)));
    return JSON.stringify({ n: PRESET_CUSTOM_SOURCES.length, allValid: ok.every(x => x === "") });
  `);
  const c9 = JSON.parse(r9);
  check("预置模板：两条且全部通过配置校验", c9.n === 2 && c9.allValid === true, r9);

  await stubFetchWith(MOE_FIXTURE);
  const r9a = await ev(`
    const cs = normalizeCustomSource(PRESET_CUSTOM_SOURCES.find(p => p.name.indexOf("萌娘百科") >= 0));
    const list = await searchCustomSource(cs, "犬夜叉");
    return JSON.stringify({ n: list.length, t: list[0] && list[0].titleCn, link: list[0] && list[0].sourceId });
  `);
  const c9a = JSON.parse(r9a);
  check("萌娘百科模板：解析实测 mw-search-result 结构、相对链接补全",
    c9a.n === 2 && c9a.t === "犬夜叉" && c9a.link === "https://zh.moegirl.org.cn/%E7%8A%AC%E5%A4%9C%E5%8F%89", r9a);

  await stubFetchWith(BING_FIXTURE);
  const r9b = await ev(`
    const cs = normalizeCustomSource(PRESET_CUSTOM_SOURCES.find(p => p.name.indexOf("必应") >= 0));
    const list = await searchCustomSource(cs, "犬夜叉");
    return JSON.stringify({ n: list.length, t: list[0] && list[0].titleCn, link: list[0] && list[0].sourceId });
  `);
  const c9b = JSON.parse(r9b);
  check("必应中国模板：解析实测 b_algo 结构、保留真实链接",
    c9b.n === 2 && c9b.t.indexOf("犬夜叉") === 0 && c9b.link.indexOf("https://baike.baidu.com/") === 0, r9b);

  await ev(`openPresetSourcePicker()`);
  await sleep(150);
  const presetRows = doc.querySelectorAll("[data-preset]");
  check("模板弹窗：列出两条模板", presetRows.length === 2);
  presetRows[1].click();
  await sleep(150);
  check("点模板后打开预填表单（萌百）",
    (doc.querySelector("#cs-name") || {}).value === "萌娘百科（ACG 百科）" &&
    (doc.querySelector("#cs-item") || {}).value === ".mw-search-result");
  win.eval("closeModal()");
  /* 清理 */
  await ev('saveCustomSources([]); settings.src_bangumi_enabled = true; settings.src_anilist_enabled = true; saveSettings();');

  console.log("");
  console.log(fail ? "失败 " + fail + " 项：" : "全部通过 " + pass + " 项");
  fails.forEach(f => console.log("  - " + f));
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error("CRASH", e); process.exit(2); });
