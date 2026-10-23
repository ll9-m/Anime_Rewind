/* 导入/导出数据完整性测试。
 * 背景：rawToDraft 曾是纯白名单映射，备份里明明有的 sources / activeSourceId /
 *       streamUrl* / statusId 全部被丢弃，「备份→恢复」会静默清空线路台账、
 *       把全库状态归零成「想看」。本文件钉死这些字段必须随记录迁移。
 *
 * 覆盖：
 *  1. rawToDraft 保留 sources / activeSourceId / 旧片源字段
 *  2. activeSourceId 指向搜索型片源时被拒（不变量）
 *  3. statusId：系统状态直取、自定义状态按名称重映射
 *  4. 导出 payload 带 assets；导入后能读回
 *  5. mergeRecords：表单默认值（想看/0集）不清掉 base 的已有进度
 *  6. applyImport 落库走静默路径，备份的 updatedAt 不被 touch 覆盖
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
  const ev = async expr => await win.eval("(async()=>{" + expr + "})()");

  /* ---------- 1. rawToDraft 保留播放源 ---------- */
  const raw = {
    titleCn: "数码宝贝大冒险", statusId: "st_done", watchedEpisodes: 12,
    sources: [
      { id:"src-a", name:"线路A", url:"https://example.com/a.mp4", ep:3, kind:"play", enabled:true, health:{ state:"alive", at:"2026-01-01T00:00:00Z", detail:"" } },
      { id:"src-s", name:"某站", url:"https://site.example/", kind:"search", searchUrl:"https://site.example/s?q={kw}" }
    ],
    activeSourceId: "src-a",
    streamUrl: "https://legacy.example/v.mp4", streamEp: 5, streamUrlAt: "2025-01-01T00:00:00Z"
  };
  const r1 = await ev(`
    const d = rawToDraft(${JSON.stringify(raw)});
    return JSON.stringify({
      n: d.sources.length,
      ids: d.sources.map(s => s.id).join(","),
      act: d.activeSourceId,
      url: d.streamUrl, ep: d.streamEp, at: d.streamUrlAt,
      kindA: d.sources[0].kind, healthA: d.sources[0].health.state
    });
  `);
  const d1 = JSON.parse(r1);
  check("rawToDraft 保留全部 sources", d1.n === 2 && d1.ids === "src-a,src-s", r1);
  check("rawToDraft 保留 activeSourceId", d1.act === "src-a", r1);
  check("rawToDraft 保留旧片源字段 streamUrl/streamEp/streamUrlAt",
    d1.url === raw.streamUrl && d1.ep === 5 && d1.at === raw.streamUrlAt, r1);
  check("线路 kind/health 原样迁移", d1.kindA === "play" && d1.healthA === "alive", r1);

  /* ---------- 2. activeSourceId 指向搜索型 → 拒绝 ---------- */
  const r2 = await ev(`
    const bad = Object.assign({}, ${JSON.stringify(raw)}, { activeSourceId: "src-s" });
    const d = rawToDraft(bad);
    return d.activeSourceId;
  `);
  check("activeSourceId 指向搜索型片源被置空", r2 === "", r2);

  /* ---------- 3. statusId 重映射 ---------- */
  const r3 = await ev(`
    const foreign = {
      anime: [
        { id:"f1", titleCn:"系统状态作品", statusId:"st_done", watchedEpisodes:1 },
        { id:"f2", titleCn:"自定义状态作品", statusId:"st_custom_old", watchedEpisodes:1 }
      ],
      statuses: [
        { id:"st_custom_old", name:"童年补完", color:"#FF0000", isSystem:false }
      ],
      settings: {}
    };
    const an = analyzeImport(foreign);
    const byT = {};
    an.add.concat(an.dup.map(x => x.draft)).forEach(d => { byT[d.titleCn] = d.statusId; });
    return JSON.stringify({
      sys: byT["系统状态作品"],
      cus: byT["自定义状态作品"],
      newSt: an.statusAdd.length
    });
  `);
  const d3 = JSON.parse(r3);
  check("系统状态 id 直取不重置", d3.sys === "st_done", r3);
  check("自定义状态新建并重映射到本机新 id",
    d3.newSt === 1 && d3.cus && d3.cus !== "st_custom_old" && d3.cus !== "st_want", r3);

  /* ---------- 4. assets 随导出/导入走 ---------- */
  await ev(`
    await Repo.setAsset("honor_test_art", "data:image/png;base64,iVBORw0KGgo=");
  `);
  const r4 = await ev(`
    const p = await buildExportPayload(false);
    const has = Array.isArray(p.assets) && p.assets.some(a => a.key === "honor_test_art");
    return JSON.stringify({ has });
  `);
  check("导出 payload 含 assets（荣誉配图等）", JSON.parse(r4).has === true, r4);

  /* ---------- 5. mergeRecords 默认值不清进度 ---------- */
  const r5 = await ev(`
    const base = {
      id:"an_x", titleCn:"旧记录", statusId:"st_done", watchedEpisodes:12,
      rewatchCount:1, updatedAt:"2025-01-01T00:00:00Z", sources:[], locked:{}, pending:{}, reviews:[]
    };
    const incoming = {
      id:"an_new", titleCn:"旧记录", statusId:"st_want", watchedEpisodes:0,
      rewatchCount:0, updatedAt:new Date().toISOString(), sources:[], locked:{}, pending:{}, reviews:[]
    };
    const m = mergeRecords(base, incoming, {});
    return JSON.stringify({ st: m.statusId, ep: m.watchedEpisodes, rw: m.rewatchCount });
  `);
  const d5 = JSON.parse(r5);
  check("合并不把「看完/12集」重置成「想看/0集」",
    d5.st === "st_done" && d5.ep === 12 && d5.rw === 1, r5);

  /* base 无线路、incoming（备份草稿）带线路 → 采纳备份线路 */
  const r5b = await ev(`
    const base = { id:"an_y", titleCn:"无源记录", statusId:"st_want", watchedEpisodes:0, sources:[], locked:{}, pending:{}, reviews:[] };
    const incoming = { id:"an_z", titleCn:"无源记录", statusId:"st_want", watchedEpisodes:0,
      sources:[{ id:"src-b", name:"B", url:"https://b.example/v.mp4", kind:"play" }], activeSourceId:"src-b",
      locked:{}, pending:{}, reviews:[] };
    const m = mergeRecords(base, incoming, {});
    return JSON.stringify({ n: (m.sources||[]).length, act: m.activeSourceId });
  `);
  const d5b = JSON.parse(r5b);
  check("合并时 base 无线路则采纳备份线路", d5b.n === 1 && d5b.act === "src-b", r5b);

  /* ---------- 6. 落库不 touch：备份时间戳保留 ---------- */
  const r6 = await ev(`
    const before = state.anime.length;
    const p = {
      app: APP_KEY,
      anime: [ { id:"imp_ts", titleCn:"时间戳作品", statusId:"st_done", watchedEpisodes:3,
        createdAt:"2020-06-01T00:00:00Z", updatedAt:"2021-08-15T12:00:00Z",
        sources:[{ id:"src-t", name:"T", url:"https://t.example/v.mp4", kind:"play" }] } ],
      statuses: [], settings: {}
    };
    const an = analyzeImport(p);
    await applyImport(an, "skip", {});
    const rec = state.anime.find(a => a.titleCn === "时间戳作品");
    const all = await Repo.all("anime");
    const fromDb = all.find(a => a.id === rec.id);
    return JSON.stringify({
      created: rec.createdAt, updated: rec.updatedAt,
      srcN: (rec.sources||[]).length,
      dbSrcN: fromDb ? (fromDb.sources||[]).length : -1,
      notTouched: rec.updatedAt === "2021-08-15T12:00:00Z"
    });
  `);
  const d6 = JSON.parse(r6);
  check("导入后 updatedAt 保持备份原值（不被 touch）", d6.notTouched === true, r6);
  check("导入的作品带上 sources（内存与库内一致）",
    d6.srcN === 1 && d6.dbSrcN === 1, r6);

  /* 清理：把本测试写进库里的记录删掉，不留副作用 */
  await ev(`
    const rec = state.anime.find(a => a.titleCn === "时间戳作品");
    if(rec) await removeAnime(rec.id);
    const cus = state.statuses.find(s => s.name === "童年补完");
    if(cus){ state.statuses = state.statuses.filter(s => s.id !== cus.id); await Repo.del("statuses", cus.id); }
    await Repo.delAsset("honor_test_art");
  `);

  console.log("");
  console.log(fail ? "失败 " + fail + " 项：" : "全部通过 " + pass + " 项");
  fails.forEach(f => console.log("  - " + f));
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error("CRASH", e); process.exit(2); });
