/* 播放源台账（跨作品管理）测试。
 *
 * 覆盖：摊平聚合、状态旗标、统计口径、四种排序、
 *       筛选（含「无播放源」这个特殊分支）、重复检测、
 *       删除后 activeSourceId 与旧字段的同步、批量删除逐条报告。
 *
 * 重点防五类回归：
 *  1. 台账用 sourcesOf 摊平 → 全局兜底片源 settings.stream_url
 *     会让一部没有线路的作品凭空多出一条，统计随之虚高；
 *  2. 删除当前线路后不重置 activeSourceId → 详情页显示已删线路的集数；
 *  3. 台账写操作走 saveAnime → touch() 改 updatedAt，
 *     整理一次线路就会把老作品顶到「最近添加」最前面；
 *  4. 「无播放源」当普通筛选条件塞进线路列表 → 筛选结果里混进
 *     source 为 null 的行，后续排序与操作全部读空；
 *  5. 探测覆盖用户手动标的失效 → 一次网络波动把用户的判断抹掉。
 */
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
  await sleep(1100);
  const ev = async expr => {
    const raw = await win.eval("(async()=>{" + expr + "})()");
    if(raw === undefined) throw new Error("表达式未返回结果（需显式 return）：" + expr.slice(0, 80));
    return typeof raw === "string" ? JSON.parse(raw) : raw;
  };

  /* 装载一份固定的库。所有用例共用它，因此中途不能被写坏 ——
     写操作类的用例改完要复原，否则后面统计类断言会读到脏数据。 */
  const seed = await ev(`
    settings.stream_url = "";
    state.anime = [
      { id:"a1", titleCn:"钢之炼金术师", sources:[
        { id:"s11", url:"https://www.bilibili.com/bangumi/play/ep1", name:"B站", ep:1, resolution:"1080P" },
        { id:"s12", url:"https://youtu.be/aaa", name:"YouTube 1080", ep:2, resolution:"1080P",
          health:{ state:"dead", at:"2026-09-01T00:00:00.000Z", detail:"用户手动标记失效" } },
        { id:"s13", url:"https://vimeo.com/999", name:"Vimeo 备用", ep:null, resolution:"720P",
          enabled:false }
      ], activeSourceId:"s11" },
      { id:"a2", titleCn:"数码宝贝", sources:[
        { id:"s21", url:"https://www.youtube.com/watch?v=bbb", name:"YT", ep:1, resolution:"2160P" },
        { id:"s22", url:"https://www.youtube.com/watch?v=bbb", name:"YT 副本", ep:1, resolution:"2160P" }
      ], activeSourceId:"s21" },
      { id:"a3", titleCn:"葫芦兄弟", sources:[] },
      { id:"a4", titleCn:"蒸发qa", sources:[
        { id:"s41", url:"https://example.org/x.mp4", name:"直链", note:"需要登录" }
      ] }
    ];
    state.anime.forEach(a => migrateSources(a));
    return JSON.stringify({ n:state.anime.length });
  `);
  check("测试库装载完成", seed.n === 4, JSON.stringify(seed));

  /* ---------- 1. 摊平聚合 ---------- */
  const g1 = await ev(`return JSON.stringify(sourceLedger().length)`);
  check("台账摊平出全部线路（3+2+0+1）", g1 === 6, g1);

  /* 反向验证：全局兜底片源不该让「没有线路」的作品长出线路来。
     清空 settings.stream_url 后仍要成立，否则说明有人改回了 sourcesOf。 */
  const g2 = await ev(`
    settings.stream_url = "https://legacy.com/v";
    const n = sourceLedger().length;
    settings.stream_url = "";
    return n;
  `);
  check("台账不受全局兜底片源污染（没有线路就是没有）", g2 === 6, g2);

  const g3 = await ev(`
    const rows = sourceLedger();
    return JSON.stringify({
      allHaveAnime: rows.every(r => r.anime && r.anime.id),
      allHaveSource: rows.every(r => r.source && r.source.url)
    });
  `);
  check("每一项都带得上作品与线路（视图而非第二份存储）",
    g3.allHaveAnime && g3.allHaveSource, JSON.stringify(g3));

  /* ---------- 2. 状态旗标 ---------- */
  const b1 = await ev(`
    const rows = sourceLedger();
    const flags = id => sourceFlags(rows.find(r => r.source.id === id)).map(f => f.id).join(",");
    return JSON.stringify({ s11:flags("s11"), s12:flags("s12"), s13:flags("s13"), s21:flags("s21") });
  `);
  const b1o = b1;
  check("当前线路带「使用中」", b1o.s11.indexOf("active") >= 0, b1o.s11);
  check("标记失效的线路带「已失效」", b1o.s12.indexOf("dead") >= 0, b1o.s12);
  check("停用的线路带「已停用」", b1o.s13.indexOf("disabled") >= 0, b1o.s13);
  check("未探测过的线路显示「未检测」而不是「可用」", b1o.s21.indexOf("unknown") >= 0, b1o.s21);

  /* 失效线路不应同时被标成「使用中」——
     activeSourceOf 已经会跳过它，但旗标层也要自己站得住。 */
  const b2 = await ev(`
    const rows = sourceLedger();
    return sourceFlags(rows.find(r => r.source.id === "s12")).some(f => f.id === "active");
  `);
  check("已失效的线路不会再被标为使用中", b2 === false, b2);

  /* ---------- 3. 统计口径 ---------- */
  const st1 = await ev(`return JSON.stringify(sourceLedgerStats(sourceLedger()))`);
  const st1o = st1;
  check("统计线路总数", st1o.total === 6, JSON.stringify(st1o));
  check("统计已失效数", st1o.dead === 1, JSON.stringify(st1o));
  check("统计停用数（与健康度正交，单独一栏）", st1o.disabled === 1, JSON.stringify(st1o));
  /* 未检测 = 4 条真没探测过的 + s13（它被停用，但也从没探测过）。
     停用与健康度是两个正交维度，所以停用的线路仍会落在某一档里。 */
  check("统计未检测数", st1o.unknown === 5, JSON.stringify(st1o));
  /* 四档健康度必须加起来等于总数：合计对不上时汇总条会让人
     以为有线路既不算可达也不算不通，凭空消失了一条。 */
  check("健康度四档合计等于线路总数",
    st1o.dead + st1o.blocked + st1o.alive + st1o.unknown === st1o.total, JSON.stringify(st1o));
  check("统计有线路的作品数", st1o.animeWith === 3, JSON.stringify(st1o));
  check("统计无线路的作品数", st1o.animeWithout === 1, JSON.stringify(st1o));

  /* ---------- 4. 筛选与排序 ---------- */
  const f1 = await ev(`
    ledgerState.q = ""; ledgerState.filter = "dead"; ledgerState.sort = "anime";
    const n = filterLedgerRows(sourceLedger()).length;
    ledgerState.filter = "";
    return n;
  `);
  check("按「已失效」筛出 1 条", f1 === 1, f1);

  const f2 = await ev(`
    ledgerState.filter = "no-source"; ledgerState.q = "";
    const rows = filterLedgerRows(sourceLedger());
    ledgerState.filter = "";
    return JSON.stringify({ n:rows.length, onlyNull: rows.every(r => r.source === null) });
  `);
  const f2o = f2;
  check("「无播放源」筛出 1 部作品", f2o.n === 1, JSON.stringify(f2o));
  check("「无播放源」这一档的行 source 为 null（不是坏数据）", f2o.onlyNull === true, JSON.stringify(f2o));

  /* 「无播放源」这一档的行 source 是 null，而按状态/时间/站点排的三个档位
     都要读 source 的字段。用户很可能正好在这一档切排序 ——
     没有兜底的话整页会崩成「页面渲染出错」，
     且只在「先切到无播放源、再改排序」这个特定顺序下复现。 */
  const sortNull = await ev(`
    const bad = [];
    ["health","newest","host","anime"].forEach(k => {
      ledgerState.filter = "no-source"; ledgerState.sort = k;
      try{ filterLedgerRows(sourceLedger()); }
      catch(e){ bad.push(k + ":" + e.message); }
    });
    ledgerState.filter = ""; ledgerState.sort = "anime";
    return JSON.stringify(bad);
  `);
  check("在「无播放源」档位切任意排序都不抛错",
    sortNull.length === 0, sortNull);

  /* 兜底不能把行弄丢：四种排序下条数都必须一致 */
  const sortKeep = await ev(`
    const n = {};
    ["health","newest","host","anime"].forEach(k => {
      ledgerState.filter = "no-source"; ledgerState.sort = k;
      n[k] = filterLedgerRows(sourceLedger()).length;
    });
    ledgerState.filter = ""; ledgerState.sort = "anime";
    return JSON.stringify(n);
  `);
  const sk = sortKeep;
  check("四种排序下「无播放源」的行数不变",
    Object.values(sk).every(v => v === 1), JSON.stringify(sk));

  /* 全选本页不能被 source 为 null 的行带崩 */
  const pickAll = await ev(`
    ledgerState.filter = "no-source"; ledgerState.picked = [];
    const rows = filterLedgerRows(sourceLedger());
    rows.forEach(r => { if(!r.source) return; });
    ledgerState.filter = ""; ledgerState.picked = [];
    return JSON.stringify(pickedLedgerRows(sourceLedger()).length);
  `);
  check("待办行不会被算进可批量操作的线路", pickAll === 0, pickAll);

  /* ledgerKey 与选中态判定也必须容错。
     这两处都在渲染路径上，且只在「无播放源」档位才碰到 null source ——
     症状是整页显示「页面渲染出错」，极其显眼却又极难复现。 */
  const keySafe = await ev(`
    ledgerState.filter = "no-source";
    const rows = filterLedgerRows(sourceLedger());
    ledgerState.filter = "";
    let err = "";
    try{ rows.map(r => ledgerKey(r)); }catch(e){ err = e.message; }
    return JSON.stringify({ err, key: rows[0] ? ledgerKey(rows[0]) : "no-rows" });
  `);
  const ks = keySafe;
  check("ledgerKey 对待办行不抛错（渲染路径上的空引用）", ks.err === "", ks.err);
  check("待办行的键是空串（天然不会被选中）", ks.key === "", ks.key);

  /* 渲染路径整条跑一遍（六个档位 × 四种排序）。
     jsdom 这边能测的正是真浏览器崩掉的那条路径：
     renderLedger 会 map 每行算 ledgerKey，任何一处不容错都会抛。 */
  const renderSafe = await ev(`
    const errs = [];
    const filters = ["","active","dead","unknown","disabled","no-source"];
    const sorts = ["anime","health","newest","host"];
    filters.forEach(f => {
      sorts.forEach(k => {
        ledgerState.filter = f; ledgerState.sort = k; ledgerState.picked = [];
        const host = document.createElement("div");
        document.getElementById("view").appendChild(host);
        try{ renderLedger(host); }
        catch(e){ errs.push(f+"/"+k+": "+e.message); }
        host.remove();
      });
    });
    ledgerState.filter = ""; ledgerState.sort = "anime";
    return JSON.stringify(errs);
  `);
  const rs = renderSafe;
  check("六个筛选档位 × 四种排序下渲染均不抛错",
    rs.length === 0, rs.slice(0, 3).join(" | "));

  /* 渲染产物本身也要对：待办行必须带「去添加」而不是操作按钮组 */
  const renderShape = await ev(`
    ledgerState.filter = "no-source";
    const host = document.createElement("div");
    document.getElementById("view").appendChild(host);
    renderLedger(host);
    ledgerState.filter = "";
    const tr = host.querySelector(".ledger-table tbody tr");
    const out = JSON.stringify({
      rows: host.querySelectorAll(".ledger-table tbody tr").length,
      hasAdd: !!host.querySelector('[data-act="open-anime"]'),
      hasDel: !!host.querySelector('[data-act="del"]'),
      hasCheck: !!host.querySelector('[data-act="pick"]'),
      flagCells: host.querySelectorAll(".flag").length
    });
    host.remove();
    return out;
  `);
  const rsh = renderShape;
  check("待办档渲染出 1 行", rsh.rows === 1, rsh.rows);
  check("待办行给的是「去添加」而非删除/勾选", rsh.hasAdd && !rsh.hasDel && !rsh.hasCheck, JSON.stringify(rsh));
  check("待办行没有状态徽标（它不是一条线路）", rsh.flagCells === 0, rsh.flagCells);

  /* 关键词要能命中网址与备注 —— 用户记得住的是「那个要登录的」。 */
  const f3 = await ev(`
    ledgerState.filter = ""; ledgerState.q = "需要登录";
    const n = filterLedgerRows(sourceLedger()).length;
    ledgerState.q = "";
    return n;
  `);
  check("搜索能命中备注", f3 === 1, f3);

  const f4 = await ev(`
    ledgerState.q = "bilibili";
    const n = filterLedgerRows(sourceLedger()).length;
    ledgerState.q = "";
    return n;
  `);
  check("搜索能命中网址/站点", f4 === 1, f4);

  const f5 = await ev(`
    ledgerState.sort = "health";
    const rows = filterLedgerRows(sourceLedger());
    ledgerState.sort = "anime";
    return JSON.stringify(rows.map(r => r.source.id));
  `);
  check("按状态排序时已失效排最前", f5[0] === "s12", JSON.stringify(f5));

  const f6 = await ev(`
    ledgerState.sort = "host";
    const rows = filterLedgerRows(sourceLedger());
    ledgerState.sort = "anime";
    const hosts = rows.map(r => new URL(r.source.url).hostname);
    return JSON.stringify(hosts.every((h,i) => i === 0 || hosts[i-1].localeCompare(h) <= 0));
  `);
  check("按站点排序结果有序", f6 === true, f6);

  const f7 = await ev(`
    ledgerState.sort = "newest";
    const rows = filterLedgerRows(sourceLedger());
    ledgerState.sort = "anime";
    return JSON.stringify(rows.map(r => String(r.source.savedAt || "")));
  `);
  check("按添加时间排序为新→旧",
    f7.every((v, i) => i === 0 || f7[i-1] >= v), JSON.stringify(f7));

  /* ---------- 5. 重复检测 ---------- */
  const d1 = await ev(`return JSON.stringify(ledgerDuplicates(sourceLedger()).length)`);
  check("检出 1 条重复线路（同作品同址同集）", d1 === 1, d1);

  const d2 = await ev(`
    const dups = ledgerDuplicates(sourceLedger());
    return JSON.stringify({ anime:dups[0].anime.id, src:dups[0].source.id, keep:dups[0].keepId });
  `);
  const d2o = d2;
  check("重复项指向多余的那条，保留最早添加的",
    d2o.anime === "a2" && d2o.src === "s22" && d2o.keep === "s21", JSON.stringify(d2o));

  /* 同址但集数不同是合法的两条，不能当成重复。 */
  const d3 = await ev(`
    state.anime.push({ id:"tmp", titleCn:"同址不同集", sources:[
      { id:"t1", url:"https://x.com/v", ep:1, name:"第一集" },
      { id:"t2", url:"https://x.com/v", ep:2, name:"第二集" }
    ] });
    migrateSources(state.anime.find(a => a.id === "tmp"));
    const n = ledgerDuplicates(sourceLedger()).length;
    state.anime = state.anime.filter(a => a.id !== "tmp");
    return n;
  `);
  check("同址不同集不算重复", d3 === 1, d3);

  /* ---------- 6. 删除与旧字段同步 ---------- */
  const del1 = await ev(`
    const a = state.anime.find(x => x.id === "a1");
    const row = { anime:a, source:a.sources.find(s => s.id === "s11") };
    const res = await deleteSource(row);
    return JSON.stringify({
      removed: !!res, left:res && res.left,
      active:a.activeSourceId,
      streamUrl:a.streamUrl, streamEp:a.streamEp,
      hasGone: a.sources.some(s => s.id === "s11")
    });
  `);
  const del1o = del1;
  check("删除当前线路成功", del1o.removed === true, JSON.stringify(del1o));
  check("删除后线路数正确", del1o.left === 2, JSON.stringify(del1o));
  check("删掉的线路确实不在列表里", del1o.hasGone === false, JSON.stringify(del1o));
  check("activeSourceId 让给剩下的线路（不悬空）",
    !!del1o.active && del1o.active !== "s11", JSON.stringify(del1o));
  check("旧字段 streamUrl 跟着新线路走",
    del1o.streamUrl.indexOf("youtu.be") >= 0, JSON.stringify(del1o));

  /* 复原 */
  await ev(`
    const a = state.anime.find(x => x.id === "a1");
    a.sources = [
      { id:"s11", url:"https://www.bilibili.com/bangumi/play/ep1", name:"B站", ep:1, resolution:"1080P" },
      { id:"s12", url:"https://youtu.be/aaa", name:"YouTube 1080", ep:2, resolution:"1080P",
        health:{ state:"dead", at:"2026-09-01T00:00:00.000Z" } },
      { id:"s13", url:"https://vimeo.com/999", name:"Vimeo 备用", ep:null, resolution:"720P", enabled:false }
    ];
    a.activeSourceId = "s11";
    await Repo.put("anime", a);
    return JSON.stringify(1);
  `);

  /* 删掉非当前线路：activeSourceId 不该被动 */
  const del2 = await ev(`
    const a = state.anime.find(x => x.id === "a1");
    await deleteSource({ anime:a, source:a.sources.find(s => s.id === "s13") });
    return JSON.stringify(a.activeSourceId);
  `);
  check("删除非当前线路不动 activeSourceId", del2 === "s11", del2);

  /* 批量删除要逐条报告，不能只给一个布尔 */
  const del3 = await ev(`
    const rows = sourceLedger().filter(r => r.anime.id === "a2");
    const res = await deleteSources(rows);
    const a = state.anime.find(x => x.id === "a2");
    return JSON.stringify({ removed:res.removed.length, failed:res.failed.length, left:a.sources.length, active:a.activeSourceId });
  `);
  const del3o = del3;
  check("批量删除逐条返回成功数", del3o.removed === 2, JSON.stringify(del3o));
  check("批量删除没有失败项时 failed 为 0", del3o.failed === 0, JSON.stringify(del3o));
  check("批量删空后 activeSourceId 为空串而不是悬空 id", del3o.active === "", JSON.stringify(del3o));

  await ev(`
    const a = state.anime.find(x => x.id === "a2");
    a.sources = [
      { id:"s21", url:"https://www.youtube.com/watch?v=bbb", name:"YT", ep:1, resolution:"2160P" },
      { id:"s22", url:"https://www.youtube.com/watch?v=bbb", name:"YT 副本", ep:1, resolution:"2160P" }
    ];
    a.activeSourceId = "s21";
    await Repo.put("anime", a);
    return JSON.stringify(1);
  `);

  /* ---------- 7. 台账写操作不碰 updatedAt ---------- */
  const touch1 = await ev(`
    const a = state.anime.find(x => x.id === "a4");
    a.updatedAt = "2020-01-01T00:00:00.000Z";
    await Repo.put("anime", a);
    const before = a.updatedAt;
    const row = { anime:a, source:a.sources[0] };
    await updateSource(row, { note:"改个备注" });
    return JSON.stringify({ before:before, after:a.updatedAt, note:a.sources[0].note });
  `);
  const touch1o = touch1;
  check("台账写操作不改 updatedAt（不扰乱「最近添加」排序）",
    touch1o.before === touch1o.after, JSON.stringify(touch1o));
  check("台账写操作确实改了目标字段", touch1o.note === "改个备注", JSON.stringify(touch1o));

  /* undefined 表示「不动这个键」——
     否则每次只改备注都会顺手把 enabled 冲回默认值。 */
  const touch2 = await ev(`
    const a = state.anime.find(x => x.id === "a4");
    const row = { anime:a, source:a.sources[0] };
    await updateSource(row, { note:"只改备注", enabled:undefined, resolution:undefined });
    return JSON.stringify({ enabled:a.sources[0].enabled, res:a.sources[0].resolution });
  `);
  const touch2o = touch2;
  check("未传的字段保持原值（enabled 不被冲回默认）", touch2o.enabled === true, JSON.stringify(touch2o));

  /* ---------- 8. 手动标记失效可恢复 ---------- */
  const mk1 = await ev(`
    const a = state.anime.find(x => x.id === "a4");
    const row = { anime:a, source:a.sources[0] };
    await markSourceDead(row, true);
    const dead = normalizeHealth(a.sources[0].health).state;
    await markSourceDead(row, false);
    return JSON.stringify({ dead:dead, back:normalizeHealth(a.sources[0].health).state });
  `);
  const mk1o = mk1;
  check("标记失效生效", mk1o.dead === "dead", JSON.stringify(mk1o));
  check("恢复后回到未检测而不是「可达」", mk1o.back === "unknown", JSON.stringify(mk1o));

  /* ---------- 9. 页面与模块开关 ---------- */
  const fileSrc = fs.readFileSync(path.join(__dirname, "..", "anime-rewind.html"), "utf8");
  check("台账页已注册", /registerPage\(\{\s*\n\s*id:"sources"/.test(fileSrc), "未找到 id:\"sources\"");
  check("台账页受模块开关控制", /id:"sources"[\s\S]{0,320}?settingKey:"module_sources"/.test(fileSrc));
  check("模块开关有默认值", /module_sources:\s*true/.test(fileSrc));
  check("导航顺序里包含台账页",
    /order = \["home","library","sources"/.test(fileSrc), "台账页没进 order 数组，会掉到导航末尾");

  /* 台账写操作统一走 persistAnimeQuiet。
     断言范围要卡在台账自己的那几个写函数上，不能拿整段
     「16.6 → 16.9」的代码块去搜 —— 那段里还夹着播放器面板，
     它切换线路时调saveAnime 是既有行为（另一条路径），
     混进来会让这条断言变成「不许在整个应用里出现 saveAnime」。 */
  const writeFns = fileSrc.match(/async function persistAnimeQuiet[\s\S]*?\/\* 外部播放器区/);
  check("台账写操作代码块存在", !!writeFns, "未找到台账写操作块");
  check("台账写操作不调用 saveAnime",
    !!writeFns && !/saveAnime\(/.test(writeFns[0]),
    writeFns && /saveAnime\(/.test(writeFns[0]) ? "台账写操作里出现了 saveAnime（会改 updatedAt）" : "");
  check("台账写操作走 persistAnimeQuiet",
    !!writeFns && /persistAnimeQuiet/.test(writeFns[0]));
  check("台账删除/标记/更新三类写操作齐备",
    !!writeFns && /function updateSource/.test(writeFns[0]) &&
    /function deleteSource/.test(writeFns[0]) && /function deleteSources/.test(writeFns[0]) &&
    /function markSourceDead/.test(writeFns[0]));

  /* 播放时记录 lastUsedAt 也不能走 saveAnime：
     那样「随便点一次播放」就能把老作品顶到「最近添加」最前面。 */
  const playBlock = fileSrc.match(/记一次「最近使用」[\s\S]{0,320}?persistAnimeQuiet\(a\)/);
  check("播放记录 lastUsedAt 走静默落盘而非 saveAnime",
    !!playBlock && !/saveAnime\(/.test(playBlock[0]),
    playBlock && /saveAnime\(/.test(playBlock[0]) ? "播放动作用了 saveAnime" : "");

  /* 探测必须用 no-cors：默认 cors 模式下对方没有 CORS 头就抛 TypeError，
     那是「浏览器不让读」而不是「网站挂了」。 */
  check("探测使用 no-cors 模式",
    /mode:"no-cors"/.test(fileSrc),
    "缺少 no-cors，探测结果会把 CORS 拦截误报成线路不通");
  check("探测不把不确定判为失效",
    /state:"blocked"[^\n]*detail:"请求未能完成/.test(fileSrc.replace(/\s+/g," ")),
    "失败分支应归入 blocked（被拒绝/不确定），而不是 dead");

  console.log("\n" + (fail === 0 ? "全部通过 " : "") + pass + " 项通过" + (fail ? "，" + fail + " 项失败" : ""));
  if(fail){ console.log("失败项：\n - " + fails.join("\n - ")); process.exit(1); }
})().catch(e => { console.error("测试自身异常：", e); process.exit(2); });