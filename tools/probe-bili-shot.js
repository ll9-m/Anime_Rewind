/* B 站番剧播放器 iframe 实测（截图法）。
 *
 * contentDocument 对 player.bilibili.com 返回 null（跨域），
 * 读不到内部 DOM 就无法区分「播放器正常」和「一片黑」。
 * 唯一可靠的证据是像素：把 iframe 渲染出来截图，
 * 再统计非黑像素占比 —— 有画面必然有大量非黑像素。
 */
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const PORT = 9413;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "bili-shot-"));
const OUT = path.join(__dirname, "_bili-shot");
fs.mkdirSync(OUT, { recursive: true });

const CASES = [
  ["1-ep_id-valid", "https://player.bilibili.com/player.html?ep_id=102167&high_quality=1&danmaku=0&autoplay=0"],
  ["2-bvid-cid-valid", "https://player.bilibili.com/player.html?bvid=BV1kx411k7VB&cid=14753412&high_quality=1&danmaku=0&autoplay=0"],
  ["3-bvid-only", "https://player.bilibili.com/player.html?bvid=BV1kx411k7VB&high_quality=1&danmaku=0&autoplay=0"],
  ["4-ep_id-invalid", "https://player.bilibili.com/player.html?ep_id=999999999&high_quality=1&danmaku=0&autoplay=0"],
  ["5-control-blank", "about:blank"]
];

const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const proc = spawn(EDGE, [
    "--headless=new", "--disable-gpu", "--no-sandbox",
    "--window-size=1100,760",
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
  let id = 0;
  const pending = new Map();
  const send = (method, params) => new Promise((res, rej) => {
    const mid = ++id; pending.set(mid, { res, rej });
    ws.send(JSON.stringify({ id:mid, method, params: params || {} }));
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
  await send("Emulation.setDeviceMetricsOverride",
    { width:1100, height:760, deviceScaleFactor:1, mobile:false });

  for(const [label, src] of CASES){
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
      html,body{margin:0;background:#000}
      #f{width:1060px;height:700px;border:0;display:block;background:#000}
    </style></head><body><iframe id="f" src="${src}" allowfullscreen
      allow="autoplay; encrypted-media; fullscreen; picture-in-picture"
      referrerpolicy="no-referrer"></iframe></body></html>`;
    await send("Page.navigate", { url:"data:text/html;charset=utf-8," + encodeURIComponent(html) });
    await sleep(9000);
    const shot = await send("Page.captureScreenshot", { format:"png" });
    const file = path.join(OUT, label + ".png");
    fs.writeFileSync(file, Buffer.from(shot.data, "base64"));
    console.log("saved " + file);
  }

  ws.close(); proc.kill();
  try{ fs.rmSync(profile, { recursive:true, force:true }); } catch(e){}
  process.exit(0);
})();
