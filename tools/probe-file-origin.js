/* 定位：file:// 打开时番剧 API 到底能不能取到数据？
 * e2e 测出 iframe 停在 about:blank，说明换算没成功。
 * 两种可能：
 *   A. file:// 的 origin 是 null，接口拒绝 → 必须给用户可用的降级路径
 *   B. 接口其实能通，但我代码里有别的错
 * 先测清楚，再决定怎么改 —— 不能靠猜。
 */
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const PORT = 9425;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "ar-probe-"));
const ROOT = path.join(__dirname, "..");
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const proc = spawn(EDGE, [
    "--headless=new", "--disable-gpu", "--no-sandbox",
    "--remote-debugging-port=" + PORT, "--user-data-dir=" + profile, "about:blank"
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
  await send("Page.enable"); await send("Runtime.enable");
  const ev = async expr => {
    const r = await send("Runtime.evaluate",
      { expression:"(async()=>{" + expr + "})()", awaitPromise:true, returnByValue:true });
    if(r.exceptionDetails) return "EXC: " + r.exceptionDetails.text;
    return r.result.value;
  };

  const fileUrl = "file:///" + path.join(ROOT, "anime-rewind.html").replace(/\\/g, "/");
  await send("Page.navigate", { url: fileUrl });
  await sleep(3000);
  console.log("origin = " + await ev("return String(location.origin)"));
  console.log("protocol = " + await ev("return location.protocol"));
  console.log(await ev(`
    const out = {};
    try{
      const r = await fetch("https://api.bilibili.com/pgc/view/web/season?ep_id=102167", { credentials:"omit" });
      const t = await r.text();
      out.fetch = { status:r.status, len:t.length, head:t.slice(0,100) };
    }catch(e){ out.fetch = { error: e.name + ": " + e.message }; }
    try{
      const res = await resolveEmbedAsync("https://www.bilibili.com/bangumi/play/ep102167");
      out.resolve = res;
    }catch(e){ out.resolve = "EXC " + e.message; }
    return JSON.stringify(out, null, 1);
  `));

  ws.close(); proc.kill();
  try{ fs.rmSync(profile, { recursive:true, force:true }); } catch(e){}
  process.exit(0);
})();
