/* 收尾确认：三项改动在真实浏览器里的样子。
 * 1. 卡片右下角只有一个翻面按钮（正反两面各截一张）
 * 2. 背面只剩一个「详情」入口，且能点得动
 * 3. 系列功能：卡片徽标、筛选器、详情页同系列区块
 * 顺带确认控制台无报错、无横向溢出。 */
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const PORT = 9455;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "ar-series-"));
const ROOT = path.join(__dirname, "..");
const OUT = path.join(__dirname, "_shot");
const sleep = ms => new Promise(r => setTimeout(r, ms));
fs.mkdirSync(OUT, { recursive:true });

(async () => {
  const proc = spawn(EDGE, [
    "--headless=new", "--disable-gpu", "--no-sandbox",
    "--window-size=1500,1100",
    "--remote-debugging-port=" + PORT, "--user-data-dir=" + profile,
    "about:blank"
  ], { stdio:"ignore" });

  let list = null;
  for(let i = 0; i < 40; i++){
    await sleep(500);
    try{
      const r = await fetch("http://127.0.0.1:" + PORT + "/json/list");
      list = await r.json();
      if(list && list.some(t => t.type === "page")) break;
    }catch(e){}
  }
  const page = list.find(t => t.type === "page");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0; const pending = new Map();
  const logs = [];
  const send = (m, p) => new Promise((res, rej) => {
    const mid = ++id; pending.set(mid, { res, rej });
    ws.send(JSON.stringify({ id:mid, method:m, params:p || {} }));
  });
  await new Promise(r => ws.addEventListener("open", r));
  ws.addEventListener("message", e => {
    const m = JSON.parse(e.data);
    if(m.method === "Runtime.consoleAPICalled" && m.params.type === "error")
      logs.push("console.error: " + m.params.args.map(a => a.value || a.description || "").join(" "));
    if(m.method === "Runtime.exceptionThrown")
      logs.push("exception: " + (m.params.exceptionDetails.text || ""));
    if(m.id && pending.has(m.id)){
      const p = pending.get(m.id); pending.delete(m.id);
      m.error ? p.rej(new Error(m.error.message)) : p.res(m.result);
    }
  });
  await send("Page.enable"); await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride",
    { width:1500, height:1100, deviceScaleFactor:1, mobile:false });
  await send("Page.navigate",
    { url:"file:///" + path.join(ROOT, "anime-rewind.html").replace(/\\/g, "/") });
  await sleep(3200);

  const ev = async expr => {
    const r = await send("Runtime.evaluate",
      { expression:"(async()=>{" + expr + "})()", awaitPromise:true, returnByValue:true });
    if(r.exceptionDetails) throw new Error(r.exceptionDetails.text);
    return r.result.value;
  };
  const shot = async name => {
    const s = await send("Page.captureScreenshot", { format:"png" });
    fs.writeFileSync(path.join(OUT, name), Buffer.from(s.data, "base64"));
  };

  // 造数据：同系列两部 + 一部未归类
  const setup = await ev(`
    state.anime = []; state.series = [];
    const s = await ensureSeries("漆黑的子弹");
    const mk = (id, cn, y, eps, watched, sid) => ({
      id, titleCn:cn, titleOriginal:"", totalEpisodes:eps, watchedEpisodes:watched,
      coverUrl:"", aliases:[], genres:["科幻","悬疑"], studios:["Kinema Citrus"],
      summary:"", airDate:y, statusId: watched>=eps ? "st_done" : "st_watching",
      seriesId:sid, personalTags:[], favorite:false, masterpiece:false, reviews:[], rewatchCount:0
    });
    state.anime = [
      mk("a1","漆黑的子弹","2012-04-08",13,13,s.id),
      mk("a2","漆黑的子弹 第二季","2013-07-04",12,4,s.id),
      mk("a3","冒险的风","1991-09-18",26,5,"")
    ];
    for(const a of state.anime) await saveAnime(a);
    go("library");
    libState.view = "wall";
    libState.seriesId = null;
    libState.q = ""; libState.statusId = ""; libState.decade = ""; libState.watchYear = "";
    libState.watchGrade = ""; libState.studio = ""; libState.genre = ""; libState.flag = "";
    rerender();
    await new Promise(r=>setTimeout(r,600));
    return JSON.stringify({
      cards: document.querySelectorAll(".wall .card").length,
      flipBtns: document.querySelectorAll(".fc-flip").length,
      perCard: document.querySelectorAll(".wall .card")[0].querySelectorAll(".fc-flip").length,
      seriesTags: document.querySelectorAll(".fc-series").length,
      actsPerCard: document.querySelectorAll(".fc-acts [data-act]").length,
      seriesOptions: document.querySelectorAll("#lib-series option").length,
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth
    });
  `);
  console.log("片库: " + setup);
  const pos=await ev(`
    return JSON.stringify(Array.from(document.querySelectorAll(".fc-flip")).map(b=>{const r=b.getBoundingClientRect();return {x:Math.round(r.left),y:Math.round(r.top),w:Math.round(r.width),h:Math.round(r.height)};}));
  `);
  console.log("翻面按钮坐标: "+pos);
  await shot("1-片库正面.png");

  // 真实鼠标 hover 翻面，看背面
  const card = JSON.parse(await ev(`
    const r = document.querySelector(".wall .card").getBoundingClientRect();
    return JSON.stringify({ x: Math.round(r.left+r.width/2), y: Math.round(r.top+r.height/2) });
  `));
  await send("Input.dispatchMouseEvent", { type:"mouseMoved", x:card.x, y:card.y, buttons:0 });
  await sleep(1500);
  const back = await ev(`
    const c = document.querySelector(".wall .card");
    const btn = c.querySelector('.fc-acts [data-act="detail"]');
    const r = btn.getBoundingClientRect();
    const x = Math.round(r.left+r.width/2), y = Math.round(r.top+r.height/2);
    const el = document.elementFromPoint(x,y);
    return JSON.stringify({
      acts: Array.from(c.querySelectorAll(".fc-acts [data-act]")).map(b=>b.dataset.act),
      flipVisible: !!document.querySelector(".fc-flip"),
      hitOk: !!(el && el.closest && el.closest('.fc-acts [data-act="detail"]')),
      x, y
    });
  `);
  console.log("背面: " + back);
  await shot("2-片库背面.png");

  // 真实点击背面按钮
  const bp = JSON.parse(back);
  await send("Input.dispatchMouseEvent",
    { type:"mousePressed", x:bp.x, y:bp.y, button:"left", clickCount:1, buttons:1 });
  await send("Input.dispatchMouseEvent",
    { type:"mouseReleased", x:bp.x, y:bp.y, button:"left", clickCount:1, buttons:0 });
  await sleep(900);
  console.log("点详情后: " + await ev(`
    return JSON.stringify({ route: state.route, id: state.routeId });
  `));

  // 详情页：系列区块
  await sleep(600);
  const det = await ev(`
    const root = document.querySelector("#view");
    return JSON.stringify({
      sibs: root.querySelectorAll("[data-series-go]").length,
      sel: !!root.querySelector("#dt-series"),
      add: !!root.querySelector("#dt-seriesAdd"),
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth
    });
  `);
  console.log("详情页: " + det);
  await shot("3-详情页系列.png");

  // 筛选器
  const filt = await ev(`
    go("library"); libState.seriesId = null; rerender();
    await new Promise(r=>setTimeout(r,400));
    const sel0 = document.querySelector("#lib-series");
    const opts = Array.from(sel0.options).map(o=>o.textContent);
    sel0.value = "";
    sel0.dispatchEvent(new Event("change"));
    await new Promise(r=>setTimeout(r,500));
    const n1 = document.querySelectorAll(".wall .card").length;
    const sel1 = document.querySelector("#lib-series");   // rerender 后是新的 select
    const first = Array.from(sel1.options).find(o=>o.value!=="__all__");
    sel1.value = first.value;
    sel1.dispatchEvent(new Event("change"));
    await new Promise(r=>setTimeout(r,500));
    const n2 = document.querySelectorAll(".wall .card").length;
    return JSON.stringify({ opts, defaultCount:n1, seriesCount:n2 });
  `);
  console.log("筛选: " + filt);
  await shot("4-按系列筛选.png");

  // 系列排序
  const srt = await ev(`
    go("library"); libState.seriesId = null; libState.sort = "series_asc"; rerender();
    await new Promise(r=>setTimeout(r,500));
    return JSON.stringify(Array.from(document.querySelectorAll(".fc-name")).map(n=>n.textContent));
  `);
  console.log("排序: " + srt);
  await shot("5-按系列排序.png");

  // 设置页系列管理
  const setg = await ev(`
    settingsState.tab = "series";
    go("settings");
    await new Promise(r=>setTimeout(r,600));
    const root = document.querySelector("#view");
    return JSON.stringify({
      rows: root.querySelectorAll("[data-sefield]").length,
      addBtn: !!root.querySelector('[data-act="se-add"]'),
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth
    });
  `);
  console.log("设置页: " + setg);
  await shot("6-系列管理.png");

    console.log("控制台错误: " + (logs.length ? logs.join(" | ") : "无"));
  console.log("截图目录: tools/_shot/");

  ws.close(); proc.kill();
  try{ fs.rmSync(profile, { recursive:true, force:true }); } catch(e){}
  process.exit(0);
})();
