/* 播放源台账的截图集：详情页入口与编辑弹窗。
 * verify-ledger.js 断言功能，这里出图供人眼过一遍。
 */
const { spawn } = require("child_process");
const fs = require("fs"), path = require("path"), os = require("os");
const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const ROOT = path.join(__dirname, "..");
const OUT = path.join(ROOT, "_shot");
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const PORT = 9553;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "ar-shot-"));
  const proc = spawn(EDGE, ["--headless=new","--disable-gpu","--no-sandbox",
    "--remote-debugging-port="+PORT,"--user-data-dir="+profile,"about:blank"], {stdio:"ignore"});
  try{
    let list=null;
    for(let i=0;i<40;i++){ await sleep(500);
      try{ const r=await fetch("http://127.0.0.1:"+PORT+"/json/list"); list=await r.json();
        if(list&&list.some(t=>t.type==="page")) break; }catch(e){} }
    const page=(list||[]).find(t=>t.type==="page");
    const ws=new WebSocket(page.webSocketDebuggerUrl);
    let id=0; const pending=new Map();
    await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j;});
    ws.onmessage=e=>{const m=JSON.parse(e.data);
      if(m.id&&pending.has(m.id)){const h=pending.get(m.id);pending.delete(m.id);
        m.error?h.rej(new Error(JSON.stringify(m.error))):h.res(m.result);}};
    const send=(m,p)=>new Promise((res,rej)=>{const i=++id;
      const t=setTimeout(()=>{pending.delete(i);rej(new Error("timeout "+m));},20000);
      pending.set(i,{res:v=>{clearTimeout(t);res(v);},rej:e=>{clearTimeout(t);rej(e);}});
      ws.send(JSON.stringify({id:i,method:m,params:p||{}}));});
    const ev=async x=>{const r=await send("Runtime.evaluate",{expression:"(async()=>{return ("+x+");})()",returnByValue:true,awaitPromise:true});
      if(r.exceptionDetails) throw new Error(r.exceptionDetails.exception?r.exceptionDetails.exception.description:r.exceptionDetails.text);
      return r.result.value;};
    const shot=async name=>{const r=await send("Page.captureScreenshot",{format:"png"});
      fs.writeFileSync(path.join(OUT,name), Buffer.from(r.data,"base64"));};

    await send("Page.enable"); await send("Runtime.enable");
    await send("Emulation.setDeviceMetricsOverride",{width:1500,height:1000,deviceScaleFactor:1,mobile:false});
    await send("Page.navigate",{url:"file:///"+path.join(ROOT,"anime-rewind.html").split(path.sep).join("/")});
    await sleep(2800);

    await ev(`
      (async () => {
        settings.stream_url = "";
        const mk=(id,cn,sources,active,extra)=>Object.assign({
          id,titleCn:cn,titleOriginal:"Original "+id,seriesId:"",statusId:"st_watching",
          watchedEpisodes:7,totalEpisodes:24,coverUrl:"",airDate:"2003-04-05",summary:"简介测试文本",
          createdAt:"2026-01-01T00:00:00.000Z",updatedAt:"2026-01-01T00:00:00.000Z",
          sources,activeSourceId:active||"",aliases:[],genres:["奇幻","冒险"],studios:["BONES"],
          personalTags:[],reviews:[]},extra||{});
        state.anime=[
          mk("L1","钢之炼金术师",[
            {id:"s11",url:"https://www.bilibili.com/bangumi/play/ep1",name:"B站",ep:7,resolution:"1080P",
             subtitles:["CHS"],note:"官方片源"},
            {id:"s12",url:"https://youtu.be/aaa",name:"YouTube 1080",ep:7,resolution:"1080P",
             health:{state:"dead",at:"2026-09-01T00:00:00.000Z",detail:"用户手动标记失效"}},
            {id:"s13",url:"https://vimeo.com/999",name:"Vimeo 备用",ep:null,resolution:"720P",enabled:false}
          ],"s11"),
          mk("L2","数码宝贝",[
            {id:"s21",url:"https://www.youtube.com/watch?v=bbb",name:"YouTube",ep:3,resolution:"2160P"},
            {id:"s22",url:"https://www.youtube.com/watch?v=bbb",name:"YouTube 副本",ep:3,resolution:"2160P"}
          ],"s21"),
          mk("L3","葫芦兄弟",[])];
        state.anime.forEach(a=>migrateSources(a));
        ledgerState.q="";ledgerState.filter="";ledgerState.sort="anime";ledgerState.picked=[];
        go("theater","L1");
        await new Promise(r=>setTimeout(r,700));
        return 1;
      })()`);
    await shot("ledger-detail-entry.png");

    /* 编辑弹窗 */
    await ev(`
      (async () => {
        const row = sourceLedger().find(r => sourceUsable(r.source));
        openSourceEditor(row);
        await new Promise(r=>setTimeout(r,500));
        return 1;
      })()`);
    await shot("ledger-editor.png");

    /* 「无播放源」档位 */
    await ev(`
      (async () => {
        closeModal();
        go("sources");
        await new Promise(r=>setTimeout(r,400));
        const sel=document.getElementById("led-filter");
        sel.value="no-source"; sel.dispatchEvent(new Event("change",{bubbles:true}));
        await new Promise(r=>setTimeout(r,400));
        return 1;
      })()`);
    await shot("ledger-no-source.png");

    /* 探测进行中 */
    await ev(`
      (async () => {
        const sel=document.getElementById("led-filter");
        sel.value=""; sel.dispatchEvent(new Event("change",{bubbles:true}));
        await new Promise(r=>setTimeout(r,300));
        ledgerState.probing = true;
        ledgerState.progress = { done:2, total:5, label:"正在探测", keys:new Set(["L1|s11","L1|s12"]) };
        rerenderLedger();
        await new Promise(r=>setTimeout(r,300));
        return 1;
      })()`);
    await shot("ledger-probing.png");

    console.log("截图已生成：ledger-detail-entry / ledger-editor / ledger-no-source / ledger-probing");
  } finally {
    try{ proc.kill(); }catch(e){}
    try{ fs.rmSync(profile,{recursive:true,force:true}); }catch(e){}
  }
})().catch(e => { console.error(e); process.exit(1); });