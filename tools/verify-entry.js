/* 站点根路径（index.html）验证
 *
 * 背景：GitHub Pages 报「404 未找到文件」的根因是仓库根目录没有 index.html，
 * 主文件叫 anime-rewind.html。Pages 的站点根只会解析 index.html，缺了就404。
 *
 * 这里要验三件 jsdom 与纯静态检查都测不出来的事：
 *  1. 根路径经HTTP 真的返回 200（模拟 Pages 的根解析规则，而不是 file:// 假象）
 *  2. 跳转后落在 anime-rewind.html，且主应用真的启动（不是白屏）
 *  3. 主应用在 http:// 源下能正常跑 —— IndexedDB / localStorage 在 file:// 下
 *     与 http:// 下行为不同，file:// 验过不等于线上验过
 *
 * 同时做反向验证：把 index.html 挪走，根路径必须真的返回 404，
 * 否则这个脚本自己就是个永远绿的摆设。
 */
const { spawn } = require("child_process");
const fs = require("fs"), path = require("path"), os = require("os");
const http = require("http");

const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const PORT = 9631;
const ROOT = path.join(__dirname, "..");
const INDEX = path.join(ROOT, "index.html");
const SHOT = path.join(__dirname, "_shot");
const sleep = ms => new Promise(r => setTimeout(r, ms));

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8" };

/* 静态服务：路径解析规则对齐 GitHub Pages 的根行为——
   目录请求回落到该目录下的 index.html，没有就404。 */
function serve(root){
  return new Promise(resolve => {
    const srv = http.createServer((req, res) => {
      let p = decodeURIComponent(req.url.split("?")[0].split("#")[0]);
      if (p.endsWith("/")) p += "index.html";
      const file = path.join(root, p);
      if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()){
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        return res.end("404 Not Found");
      }
      res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream" });
      fs.createReadStream(file).pipe(res);
    });
    srv.listen(0, "127.0.0.1", () => resolve({ srv, port: srv.address().port }));
  });
}

const get = port => new Promise(res => {
  const req = http.get({ host: "127.0.0.1", port, path: "/" }, r => {
    let body = "";
    r.on("data", c => body += c);
    r.on("end", () => res({ status: r.statusCode, body }));
  });
  req.on("error", () => res({ status: 0, body: "" }));
});

async function run(){
  fs.mkdirSync(SHOT, { recursive: true });
  const out = { errors: [], checks: [] };
  const add = (name, ok, note) => out.checks.push({ name, ok: !!ok, note: note || "" });

  // ---- 1. 根路径 HTTP 行为（正向）----
  const a = await serve(ROOT);
  const rootRes = await get(a.port);
  out.rootStatus = rootRes.status;
  add("根路径 GET / 返回 200", rootRes.status === 200, "实测 " + rootRes.status);
  add("根路径返回的是 index.html 内容",
    /location\.replace\("anime-rewind\.html"\)/.test(rootRes.body), "");
  add("根路径含 noscript 兜底链接",
    /<noscript>[\s\S]*?<a href="anime-rewind\.html">/.test(rootRes.body), "");

  const mainRes = await new Promise(res => {
    http.get({ host: "127.0.0.1", port: a.port, path: "/anime-rewind.html" }, r => {
      let n = 0; r.on("data", c => n += c.length); r.on("end", () => res({ status: r.statusCode, bytes: n }));
    });
  });
  out.mainBytes = mainRes.bytes;
  add("主文件可直接访问且非空", mainRes.status === 200 && mainRes.bytes > 500000,
    "实测 " + mainRes.status + " / " + mainRes.bytes + " 字节");
  a.srv.close();

  // ---- 2. 反向验证：撤掉 index.html 后根路径必须404，否则本脚本是摆设 ----
  const b = await serve(ROOT);
  const bak = INDEX + ".bak";
  fs.copyFileSync(INDEX, bak);
  fs.unlinkSync(INDEX);
  const rootRes2 = await get(b.port);
  out.rootStatusWithoutIndex = rootRes2.status;
  add("反向验证：撤掉 index.html 后根路径确实 404",
    rootRes2.status === 404, "实测 " + rootRes2.status);
  fs.copyFileSync(bak, INDEX);
  fs.unlinkSync(bak);
  b.srv.close();
  if (!fs.existsSync(INDEX)) throw new Error("index.html 未能恢复，请检查 " + INDEX);

  // ---- 3. 真实浏览器：从根路径进入，确认跳到主文件且应用启动 ----
  const c = await serve(ROOT);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "ar-entry-"));
  const proc = spawn(EDGE, ["--headless=new", "--disable-gpu", "--no-sandbox",
    "--remote-debugging-port=" + PORT, "--user-data-dir=" + profile, "about:blank"], { stdio: "ignore" });
  let ws = null;
  try{
    let list = null;
    for (let i = 0; i < 40; i++){
      await sleep(500);
      try{
        const r = await fetch("http://127.0.0.1:" + PORT + "/json/list");
        list = await r.json();
        if (list && list.some(t => t.type === "page")) break;
      }catch(e){}
    }
    const page = list.find(t => t.type === "page");
    ws = new WebSocket(page.webSocketDebuggerUrl);
    let id = 0; const pending = new Map();
    const send = (m, p) => new Promise((res2, rej) => {
      const i = ++id;
      const timer = setTimeout(() => { pending.delete(i); rej(new Error("CDP 超时: " + m)); }, 15000);
      pending.set(i, { res: v => { clearTimeout(timer); res2(v); }, rej: e => { clearTimeout(timer); rej(e); } });
      ws.send(JSON.stringify({ id: i, method: m, params: p || {} }));
    });
    await new Promise(r => ws.onopen = r);
    ws.onmessage = e => {
      const m = JSON.parse(e.data);
      if (m.id && pending.has(m.id)){
        const { res: ok, rej: no } = pending.get(m.id); pending.delete(m.id);
        m.error ? no(new Error(JSON.stringify(m.error))) : ok(m.result);
      }
      if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error")
        out.errors.push(m.params.args.map(a => a.value || a.description || "").join(" "));
      if (m.method === "Runtime.exceptionThrown")
        out.errors.push("EXC " + (m.params.exceptionDetails.text || ""));
    };
    /* evaluate 的异常必须让检查失败。若把 "ERR:..." 当字符串返回，
       选择器写错会伪装成「检查通过」—— 这类假绿比红更危险。 */
    const ev = async x => {
      const r = await send("Runtime.evaluate", { expression: x, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails){
        const msg = r.exceptionDetails.exception?.description || r.exceptionDetails.text;
        out.errors.push("EVAL " + String(msg).split("\n")[0]);
        return null;
      }
      return r.result.value;
    };

    await send("Page.enable");
    await send("Runtime.enable");
    await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await send("Page.navigate", { url: "http://127.0.0.1:" + c.port + "/" });
    await sleep(3000);

    out.finalUrl = await ev("location.pathname");
    add("浏览器从根路径跳到主文件",
      out.finalUrl === "/anime-rewind.html", "实测 " + out.finalUrl);

    out.app = await ev(`JSON.stringify({
      title: document.title,
      hasApp: !!document.querySelector('#app, .app, #view'),
      viewChildren: document.getElementById('view')?.childElementCount || 0,
      idb: typeof indexedDB !== 'undefined',
      boot: typeof go === 'function'
    })`);
    const app = out.app ? JSON.parse(out.app) : {};
    add("主应用在 http:// 源下正常启动",
      app.viewChildren > 0 && app.boot === true, out.app || "null");
    add("http:// 源下 IndexedDB 可用", app.idb === true, "");

    const shot = await send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(SHOT, "entry-根路径.png"), Buffer.from(shot.data, "base64"));
    out.errors = out.errors.filter(e => !/favicon|ERR_(NAME|INTERNET|CONNECTION)/i.test(e));
    add("页面无脚本报错", out.errors.length === 0, out.errors.join(" | ").slice(0, 200));
  } finally {
    if (ws) try{ ws.close(); }catch(e){}
    try{ proc.kill(); }catch(e){}
    c.srv.close();
    try{ fs.rmSync(profile, { recursive: true, force: true }); }catch(e){}
  }

  const pass = out.checks.filter(x => x.ok).length;
  console.log(JSON.stringify(out, null, 1));
  console.log("\n通过 " + pass + "/" + out.checks.length);
  if (pass < out.checks.length){
    console.log("--- 未通过 ---");
    out.checks.filter(x => !x.ok).forEach(x => console.log("  FAIL " + x.name + "  " + x.note));
    process.exitCode = 1;
  }
}

run().catch(e => { console.error("验证脚本异常: " + e.message); process.exitCode = 1; });
