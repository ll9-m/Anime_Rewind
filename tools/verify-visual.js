/* 收尾视觉确认：把番剧片源存好之后，详情页长什么样。
 * 顺带确认控制台没有报错 —— 静默的 JS 异常最容易在这种改动里漏掉。 */
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const PORT = 9433;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "ar-visual-"));
const ROOT = path.join(__dirname, "..");
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const proc = spawn(EDGE, [
    "--headless=new", "--disable-gpu", "--no-sandbox",
    "--window-size=1500,1080",
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
  ws.addEventListener("message", ev => {
    const m = JSON.parse(ev.data);
    if(m.method === "Runtime.consoleAPICalled" && m.params.type === "error"){
      logs.push("console.error: " + JSON.stringify(m.params.args.map(a => a.value || a.description || "")));
    }
    if(m.method === "Runtime.exceptionThrown"){
      logs.push("exception: " + (m.params.exceptionDetails.text || "") + " " +
        (m.params.exceptionDetails.exception && m.params.exceptionDetails.exception.description || ""));
    }
    if(m.id && pending.has(m.id)){
      const p = pending.get(m.id); pending.delete(m.id);
      m.error ? p.rej(new Error(m.error.message)) : p.res(m.result);
    }
  });
  await send("Page.enable"); await send("Runtime.enable"); await send("Log.enable");
  await send("Emulation.setDeviceMetricsOverride",
    { width:1500, height:1080, deviceScaleFactor:1, mobile:false });

  await send("Page.navigate",
    { url:"file:///" + path.join(ROOT, "anime-rewind.html").replace(/\\/g, "/") });
  await sleep(3200);

  const ev = async expr => {
    const r = await send("Runtime.evaluate",
      { expression:"(async()=>{" + expr + "})()", awaitPromise:true, returnByValue:true });
    if(r.exceptionDetails) throw new Error(r.exceptionDetails.text);
    return r.result.value;
  };

  await ev(`
    const a = {
      id:"vis-1", titleCn:"漆黑的子弹", titleOriginal:"",
      totalEpisodes:13, watchedEpisodes:4, coverUrl:"", aliases:["Black Bullet"],
      genres:["科幻","悬疑"], studios:["Kinema Citrus"], summary:"在学园默示国，幻想与现实界限崩塌的少年少女们，被卷入名为「慢性失 Sender」的人体实验。",
      airDate:"2012-04-08", statusId:"st_watching", personalTags:["重温经典","科幻"],
      favorite:true, masterpiece:false, reviews:[], rewatchCount:1,
      streamUrl:"https://www.bilibili.com/bangumi/play/ep102167", streamEp:5,
      streamUrlAt:"2026-10-04T12:00:00.000Z"
    };
    state.anime = [a];
    await saveAnime(a);
    go("theater","vis-1");
    await new Promise(r=>setTimeout(r,600));
    return "ok";
  `);
  await sleep(1200);

  const shot = await send("Page.captureScreenshot", { format:"png" });
  fs.writeFileSync(path.join(__dirname, "_verify-detail.png"), Buffer.from(shot.data, "base64"));

  const st = await ev(`
    const panel = document.querySelector(".stream-panel");
    const i = document.querySelector("#st-url");
    const e = document.querySelector("#st-ep");
    const rect = panel.getBoundingClientRect();
    // 检查是否有横向溢出
    return JSON.stringify({
      url: i ? i.value : null, ep: e ? e.value : null,
      panelW: Math.round(rect.width), panelH: Math.round(rect.height),
      docOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      noteText: (panel.querySelector(".note-box")||{}).innerText
    });
  `);
  console.log("状态: " + st);
  console.log("控制台错误: " + (logs.length ? logs.join(" | ") : "无"));
  console.log("截图: tools/_verify-detail.png");

  ws.close(); proc.kill();
  try{ fs.rmSync(profile, { recursive:true, force:true }); } catch(e){}
  process.exit(0);
})();
