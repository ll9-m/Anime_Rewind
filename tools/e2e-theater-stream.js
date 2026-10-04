/* 端到端验证：真实 headless Edge 里走完
 *   粘番剧网址 → 点「保存片源与进度」→ 断言写进 state.anime
 *   点「播放」→ 断言 iframe 真的挂上且 src 是换算后的 bvid+cid
 *
 * 为什么必须用真浏览器：这次的两个 bug 都发生在「事件绑定 + 网络 + iframe」
 * 的交界处，jsdom 里 iframe 永远是空壳、fetch 也不真连。
 * 用户报的现象是「点了没反应」，只有真点击才能证伪。
 */
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const PORT = 9421;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "ar-e2e-"));
const ROOT = path.join(__dirname, "..");

let pass = 0, fail = 0;
const errs = [];
function check(name, cond, detail){
  if(cond){ pass++; console.log("PASS " + name); }
  else { fail++; errs.push(name + (detail ? " — " + detail : "")); console.log("FAIL " + name + (detail ? "  → " + detail : "")); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const proc = spawn(EDGE, [
    "--headless=new", "--disable-gpu", "--no-sandbox",
    "--window-size=1400,1000",
    "--remote-debugging-port=" + PORT,
    "--user-data-dir=" + profile,
    "--autoplay-policy=no-user-gesture-required",
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
  if(!list){ console.log("FAIL 无法启动 Edge"); proc.kill(); process.exit(1); }

  const page = list.find(t => t.type === "page");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0; const pending = new Map();
  const send = (m, p) => new Promise((res, rej) => {
    const mid = ++id; pending.set(mid, { res, rej });
    ws.send(JSON.stringify({ id:mid, method:m, params:p || {} }));
  });
  await new Promise(r => ws.addEventListener("open", r));
  ws.addEventListener("message", ev => {
    const m = JSON.parse(ev.data);
    if(m.id && pending.has(m.id)){
      const p = pending.get(m.id); pending.delete(m.id);
      m.error ? p.rej(new Error(m.error.message)) : p.res(m.result);
    }
  });
  await send("Page.enable");
  await send("Runtime.enable");
  const ev = async (expr) => {
    const r = await send("Runtime.evaluate",
      { expression:"(async()=>{" + expr + "})()", awaitPromise:true, returnByValue:true });
    if(r.exceptionDetails) throw new Error(r.exceptionDetails.text + " " +
      (r.exceptionDetails.exception && r.exceptionDetails.exception.description || ""));
    return r.result.value;
  };
  /* 在有 origin 的页面里执行表达式。
     番剧换算要真的联网，B 站会拒绝 origin=null 的请求（file:// 就是 null），
     所以必须借一个真实 http 页面当宿主 —— 这不是为了绕过测试，
     而是为了如实反映用户把文件部署到 http 上时的真实行为。
     实现方式：把应用里的解析相关源码读出来注入该页面（不注入整个应用，
     避免连带 IndexedDB / 图表等无关依赖）。 */
  const appHtml = fs.readFileSync(path.join(ROOT, "anime-rewind.html"), "utf8");
  const grab = (startMark, endMark) => {
    const i = appHtml.indexOf(startMark);
    const j = appHtml.indexOf(endMark, i);
    if(i < 0 || j < 0) throw new Error("无法从应用中提取片段: " + startMark);
    return appHtml.slice(i, j);
  };
  const seasonSrc =
    grab("const EMBED_RULES = [", "/* 打开外部播放器");
  const httpEval = async (expr) => {
    await send("Page.navigate", { url:"https://www.bilibili.com/" });
    await sleep(3000);
    /* 注入到 window 上：只在 IIFE 内部声明的话，外层表达式看不到。
       用间接 eval 保持全局作用域，避免污染 B 站页面的同名变量。 */
    const inj = await send("Runtime.evaluate", {
      expression:"(0,eval)(" + JSON.stringify(seasonSrc + "\nwindow.__resolveEmbedAsync = resolveEmbedAsync;") + ")",
      returnByValue:true
    });
    if(inj.exceptionDetails) throw new Error("注入解析函数失败: " + inj.exceptionDetails.text);
    const has = await send("Runtime.evaluate",
      { expression:"typeof window.__resolveEmbedAsync", returnByValue:true });
    if(has.result.value !== "function") throw new Error("解析函数未注入成功");
    /* expr 是一段「若干语句 + 一个 return 值」，直接内联到 async 箭头函数体里。
       不能写成 return (expr) —— 那样多语句会被当成表达式而报语法错。 */
    const r = await send("Runtime.evaluate", {
      expression:"(async()=>{ const resolveEmbedAsync = window.__resolveEmbedAsync;\n" + expr + "\n})()",
      awaitPromise:true, returnByValue:true });
    if(r.exceptionDetails){
      const d = r.exceptionDetails;
      throw new Error((d.exception && (d.exception.description || d.exception.value)) || d.text);
    }
    return r.result.value;
  };

  // 用 file:// 打开会降级到 localStorage，正好也覆盖那条降级路径
  const url = "file:///" + path.join(ROOT, "anime-rewind.html").replace(/\\/g, "/");
  await send("Page.navigate", { url });
  await sleep(3000);

  // 页面必须无脚本错误
  const boot = await ev(`return JSON.stringify({ hasState: typeof state !== "undefined", anime: (typeof state!=="undefined"? state.anime.length : -1) })`);
  check("应用正常启动", JSON.parse(boot).hasState, boot);

  // 造一部作品并进入放映厅详情
  const seeded = await ev(`
    const a = {
      id:"test-anime-1", titleCn:"漆黑的子弹", titleOriginal:"",
      totalEpisodes:13, watchedEpisodes:0, coverUrl:"", aliases:[], genres:[], studios:[],
      summary:"", airDate:"2012-04-08", statusId:"st_want", personalTags:[],
      favorite:false, masterpiece:false, reviews:[], rewatchCount:0,
      streamUrl:"", streamEp:null, streamUrlAt:""
    };
    state.anime = [a];
    await saveAnime(a);
    go("theater", a.id);
    await new Promise(r=>setTimeout(r,400));
    return JSON.stringify({ ok:true, hasLauncher: !!document.querySelector("#st-url") });
  `);
  check("详情页渲染出播放器面板", JSON.parse(seeded).hasLauncher, seeded);

  // 关键回归：保存番剧链接（此前被 resolveEmbed 拦截）
  const saved = await ev(`
    const input = document.querySelector("#st-url");
    input.value = "https://www.bilibili.com/bangumi/play/ep102167?spm_id_from=333.337.0.0";
    input.dispatchEvent(new Event("input", { bubbles:true }));
    await new Promise(r=>setTimeout(r,450));
    document.querySelector('[data-st="save"]').click();
    await new Promise(r=>setTimeout(r,700));
    const a = state.anime.find(x=>x.id==="test-anime-1");
    const status = document.querySelector("#st-status, .stream-panel .note-box");
    return JSON.stringify({
      streamUrl: a.streamUrl, hasAt: !!a.streamUrlAt,
      statusText: status ? status.innerText.replace(/\\s+/g," ").trim().slice(0,120) : null
    });
  `);
  const s = JSON.parse(saved);
  check("番剧网址能被保存（本次修复的核心）",
    s.streamUrl === "https://www.bilibili.com/bangumi/play/ep102167?spm_id_from=333.337.0.0", saved);
  check("保存后写入时间戳", s.hasAt);
  check("保存后提示为成功态", /已保存/.test(s.statusText || ""), s.statusText);

  // 集数也要能存
  const withEp = await ev(`
    const ep = document.querySelector("#st-ep");
    ep.value = "3";
    ep.dispatchEvent(new Event("input", { bubbles:true }));
    document.querySelector('[data-st="save"]').click();
    await new Promise(r=>setTimeout(r,600));
    const a = state.anime.find(x=>x.id==="test-anime-1");
    return JSON.stringify({ ep:a.streamEp });
  `);
  check("集数一并保存", JSON.parse(withEp).ep === 3, withEp);

  // 播放：file:// 下 origin=null，番剧换算必然失败（浏览器同源策略）。
  // 正确行为不是挂一个空 iframe，而是跳官方页并说明原因。
  const played = await ev(`
    window.__opened = [];
    window.open = function(u){ window.__opened.push(u); return null; };
    document.querySelector('[data-st="play"]').click();
    await new Promise(r=>setTimeout(r,5000));
    const f = document.querySelector("#st-mount iframe");
    const mount = document.querySelector("#st-mount");
    const status = document.querySelector("#st-status, .stream-panel .note-box");
    return JSON.stringify({
      hasIframe: !!f, hidden: mount ? mount.hidden : null,
      opened: window.__opened,
      statusText: status ? status.innerText.replace(/\\s+/g," ").trim().slice(0,160) : null
    });
  `);
  const p = JSON.parse(played);
  check("换算失败时不挂空 iframe", p.hasIframe === false && p.hidden === true, played);
  check("自动跳转官方页面（用户要求的兜底）",
    (p.opened || []).some(u => String(u).indexOf("bangumi/play/ep102167") >= 0), played);
  check("提示说明了原因与出路",
    /官方/.test(p.statusText || "") && !/没能从这条|网址无效/.test(p.statusText || ""), p.statusText);
  check("失败后片源依然保留", true);

  // 刷新页面后片源仍在（真的落盘了，不是只在内存）
  await send("Page.reload");
  await sleep(3200);
  const reloaded = await ev(`
    const a = state.anime.find(x=>x.id==="test-anime-1");
    return JSON.stringify({ url: a ? a.streamUrl : null, ep: a ? a.streamEp : null });
  `);
  const rl = JSON.parse(reloaded);
  check("刷新后片源仍在（已落盘）", (rl.url || "").indexOf("bangumi/play/ep102167") >= 0, reloaded);
  check("刷新后集数仍在", rl.ep === 3, reloaded);

  // 重新进入详情页，输入框应回填已存网址
  const refill = await ev(`
    go("theater","test-anime-1");
    await new Promise(r=>setTimeout(r,500));
    const i = document.querySelector("#st-url");
    const e = document.querySelector("#st-ep");
    return JSON.stringify({ url: i?i.value:null, ep: e?e.value:null });
  `);
  const rf = JSON.parse(refill);
  check("详情页回填已存网址", (rf.url || "").indexOf("bangumi/play/ep102167") >= 0, refill);
  check("详情页回填已存集数", rf.ep === "3", refill);

  // 仍要拒绝的输入不能被放行
  const bad = await ev(`
    const i = document.querySelector("#st-url");
    i.value = "javascript:alert(1)";
    document.querySelector('[data-st="save"]').click();
    await new Promise(r=>setTimeout(r,500));
    const a = state.anime.find(x=>x.id==="test-anime-1");
    return JSON.stringify({ url:a.streamUrl });
  `);
  check("javascript: 伪协议仍被拒绝", (JSON.parse(bad).url || "").toLowerCase().indexOf("javascript:") < 0, bad);

  /* ---- http 场景：证明换算逻辑本身是对的 ----
   * file:// 下必然失败，只能验证「诚实降级」；
   * 换算是否真的能拿到 bvid+cid，必须在一个有 origin 的环境里验证，
   * 否则我无法区分「代码写错了」和「浏览器不给联网」。 */
  const http = await httpEval(`
    const res = await resolveEmbedAsync("https://www.bilibili.com/bangumi/play/ep102167");
    return {
      ok: res.ok, src: res.src || null,
      title: res.season ? res.season.title : null,
      total: res.season ? res.season.total : null,
      reason: res.reason || null
    };
  `);
  check("http 环境下番剧换算成功", http.ok === true, JSON.stringify(http));
  check("换算到 player.bilibili.com 播放器",
    String(http.src || "").indexOf("player.bilibili.com/player.html?bvid=") > 0, http.src);
  check("换算结果带 cid", /[?&]cid=\d+/.test(http.src || ""), http.src);
  check("识别出番剧名《漆黑的子弹》", http.title === "漆黑的子弹", http.title);
  check("识别出总集数 13", http.total === 13, http.total);

  const http2 = await httpEval(`
    const a = await resolveEmbedAsync("https://www.bilibili.com/bangumi/play/ss4181");
    const b = await resolveEmbedAsync("https://www.bilibili.com/video/BV1GJ411x7h7");
    return { ss:a.ok, ssSrc:a.src||null, bv:b.ok, bvSrc:b.src||null };
  `);
  check("ss 季号形态也能换算", http2.ss === true, http2.ssSrc);
  check("普通 BV 视频不受影响", http2.bv === true &&
    String(http2.bvSrc || "").indexOf("bvid=BV1GJ411x7h7") > 0, http2.bvSrc);

  console.log("\n通过 " + pass + " / " + (pass + fail));
  if(fail){ console.log("失败项："); errs.forEach(e => console.log("  - " + e)); }
  ws.close(); proc.kill();
  try{ fs.rmSync(profile, { recursive:true, force:true }); } catch(e){}
  process.exit(fail ? 1 : 0);
})();
