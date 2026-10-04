/* 验证：B 站番剧 season API 能否在浏览器里直接 fetch。
 *
 * curl 带 Origin 头返回了 403，但那可能是 curl 的 UA 触发了风控，
 * 不等于浏览器里也不行。这个差别决定了架构：
 *   能 fetch → 纯前端即可自动把 ep102167 换成 bvid+cid
 *   不能     → 必须靠「服务端代理」或「引导用户去官方页」
 * 所以必须实测，不能靠推断。
 */
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const PORT = 9417;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "bili-api-"));

const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const proc = spawn(EDGE, [
    "--headless=new", "--disable-gpu", "--no-sandbox",
    "--remote-debugging-port=" + PORT,
    "--user-data-dir=" + profile,
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

  // 在真实 https 源下测（data: 源的 CORS 行为不同）
  await send("Page.navigate", { url:"https://www.bilibili.com/" });
  await sleep(4000);

  const expr = `(async () => {
    const out = {};
    const urls = [
      'https://api.bilibili.com/pgc/view/web/season?ep_id=102167',
      'https://api.bilibili.com/pgc/view/web/season?ep_id=102167&jsonp=jsonp'
    ];
    for(const u of urls){
      try{
        const r = await fetch(u, { credentials:'omit' });
        const t = await r.text();
        out[u] = { status:r.status, len:t.length, head:t.slice(0,120) };
      }catch(e){
        out[u] = { error: e.message };
      }
    }
    return JSON.stringify(out, null, 1);
  })()`;
  const r = await send("Runtime.evaluate", { expression:expr, awaitPromise:true, returnByValue:true });
  console.log(r.result && r.result.value);

  ws.close(); proc.kill();
  try{ fs.rmSync(profile, { recursive:true, force:true }); } catch(e){}
  process.exit(0);
})();
