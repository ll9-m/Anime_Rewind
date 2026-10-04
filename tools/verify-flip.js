/* 验证「删掉卡片右下角圆形翻面按钮」这次改动（真实浏览器 / CDP）。
 *
 * 桌面端（能 hover）：
 *   - 卡片右下角不再有任何常驻按钮
 *   - 鼠标移上去卡片仍会翻面（行为不变）
 *   - 点背面的「详情」仍能进放映厅
 * 无 hover 端（模拟触摸设备）：
 *   - 点第一下卡片是翻面，不会直接跳走
 *     （否则删掉按钮后，手机上背面就成了永远看不到的死功能）
 *   - 再点一下才进详情
 * 顺带确认控制台无报错、无横向溢出。
 *
 * 两个环境性的坑（都已在下面注释里标明，别再踩）：
 *   1. --window-size 在 headless=new 下会被忽略，视口只有 500x450，
 *      卡片被排到视口外 → elementFromPoint 恒返回 null。必须用
 *      Emulation.setDeviceMetricsOverride 显式覆盖。
 *   2. CDP 无法模拟 hover 媒体特性；setTouchEmulationEnabled /
 *      synthesizeTapGesture 在本机会挂死或报 "Touch points must be
 *      between 1 and 16"。所以无 hover 分支改用注入脚本覆写 matchMedia
 *      —— 测的是产品代码的分支判断本身，比模拟更直接。
 *      触摸事件序列由 smoke.js 的 jsdom 断言覆盖，两边互补。
 */
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const ROOT = path.join(__dirname, "..");
const OUT = path.join(__dirname, "_shot");
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* 让页面「以为」自己是无 hover 设备。必须在文档创建前注入。 */
const NO_HOVER_SNIPPET = `
(() => {
  const mm = window.matchMedia.bind(window);
  window.matchMedia = (q) => {
    if (/\\(\\s*hover\\s*:\\s*hover\\s*\\)/.test(q)) {
      return { matches:false, media:q, onchange:null,
        addListener(){}, removeListener(){},
        addEventListener(){}, removeEventListener(){}, dispatchEvent(){ return false; } };
    }
    return mm(q);
  };
})();
`;

async function session(hover, label){
  const PORT = 9520 + (hover ? 1 : 2);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "ar-flip-"));
  const proc = spawn(EDGE, [
    "--headless=new", "--disable-gpu", "--no-sandbox",
    "--remote-debugging-port=" + PORT, "--user-data-dir=" + profile,
    "about:blank"
  ], { stdio:"ignore" });

  const out = { label, errors: [] };
  let ws = null;
  const step = m => process.stdout.write("  [" + label + "] " + m + "\n");
  try{
    step("等待浏览器");
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
    ws = new WebSocket(page.webSocketDebuggerUrl);
    let id = 0;
    const pending = new Map();
    const logs = [];

    const send = (m, p) => new Promise((res, rej) => {
      const i = ++id;
      const timer = setTimeout(() => {
        pending.delete(m.id);
        rej(new Error("CDP 超时: " + m));
      }, 15000);
      pending.set(i, {
        res: v => { clearTimeout(timer); res(v); },
        rej: e => { clearTimeout(timer); rej(e); }
      });
      ws.send(JSON.stringify({ id: i, method: m, params: p || {} }));
    });

    await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
    ws.onmessage = e => {
      const m = JSON.parse(e.data);
      if(m.id && pending.has(m.id)){
        const h = pending.get(m.id);
        pending.delete(m.id);
        m.error ? h.rej(new Error(JSON.stringify(m.error))) : h.res(m.result);
      } else if(m.method === "Runtime.consoleAPICalled" && m.params.type === "error"){
        logs.push("console.error: " + m.params.args.map(a => a.value || a.description || "").join(" "));
      } else if(m.method === "Runtime.exceptionThrown"){
        logs.push("exception: " + (m.params.exceptionDetails.exception
          ? m.params.exceptionDetails.exception.description : m.params.exceptionDetails.text));
      }
    };

    const ev = async expr => {
      const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
      if(r.exceptionDetails){
        throw new Error(r.exceptionDetails.exception
          ? r.exceptionDetails.exception.description : r.exceptionDetails.text);
      }
      return r.result.value;
    };
    const shot = async name => {
      const r = await send("Page.captureScreenshot", { format: "png" });
      fs.writeFileSync(path.join(OUT, name), Buffer.from(r.data, "base64"));
    };
    const mouse = (type, x, y) => send("Input.dispatchMouseEvent", {
      type, x: Math.round(x), y: Math.round(y), button: "left", clickCount: 1
    });

    step("Page.enable");
    await send("Page.enable");
    await send("Runtime.enable");
    if(!hover){
      await send("Page.addScriptToEvaluateOnNewDocument", { source: NO_HOVER_SNIPPET });
    }
    // 坑 1：--window-size 被 headless=new 忽略，必须显式覆盖视口
    await send("Emulation.setDeviceMetricsOverride", {
      width: 1500, height: 1100, deviceScaleFactor: 1, mobile: false
    });
    step("navigate");
    await send("Page.navigate", {
      url: "file:///" + path.join(ROOT, "anime-rewind.html").replace(/\\/g, "/")
    });
    await sleep(2600);

    step("读 viewport");
    out.viewport = await ev(`innerWidth + "x" + innerHeight`);
    out.hoverMedia = await ev(`matchMedia("(hover: hover)").matches`);
    out.cardFlipByHover = await ev(`cardFlipByHover()`);

    // 造 3 部作品，归到 2 个系列
    step("造数据");
    await ev(`(async () => {
      const mk = (t, o, sid) => ({ id: uid("an"), titleCn: t, titleOriginal: o, seriesId: sid,
        statusId: "st_want", airDate: "2014-04-06", totalEpisodes: 12, watchedEpisodes: 6,
        cover: "", aliases: [], studios: [], genres: [], reviews: [], tags: [] });
      const s1 = await ensureSeries("漆黑的子弹");
      const s2 = await ensureSeries("冒险的风");
      state.anime = [ mk("七人魔法使","トリニティセブン", s1.id),
                      mk("漆黑的子弹","RIZ", s1.id),
                      mk("冒险的风","ソレイユ", s2.id) ];
      for(const a of state.anime) await saveAnime(a);
      go("library");
      return 1;
    })()`);
    await sleep(800);

    step("读卡片数");
    out.cardCount = await ev(`document.querySelectorAll(".wall .card").length`);
    out.flipBtns = await ev(`document.querySelectorAll(".fc-flip").length`);

    // 把第一张卡滚到视口中央，再取坐标
    const geo = await ev(`(() => {
      const c = document.querySelector(".wall .card");
      if(!c) return null;
      c.scrollIntoView({ block: "center" });
      const r = c.getBoundingClientRect();
      return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2),
               w: Math.round(r.width), h: Math.round(r.height) };
    })()`);
    out.cardGeo = geo;
    await sleep(300);

    /* 关键检查点：卡片右下角不该再有按钮。
       原来那里是一个 30x30 的圆形 .fc-flip；现在命中测试应落在封面/字幕上。 */
    step("命中测试");
    out.bottomRightHit = await ev(`(() => {
      const c = document.querySelector(".wall .card");
      const r = c.getBoundingClientRect();
      const h = document.elementFromPoint(Math.round(r.right - 16), Math.round(r.bottom - 16));
      if(!h) return null;
      return { tag: h.tagName, cls: String(h.className || ""),
               inFlipBtn: !!(h.closest && h.closest(".fc-flip")) };
    })()`);

    if(hover){
      // 桌面：hover 翻面，等过渡完成（transition var(--dur-slow) ≈ 0.52s）
      step("桌面 hover");
      await mouse("mouseMoved", geo.x, geo.y);
      await sleep(1500);
      out.afterHover = await ev(`(() => {
        const c = document.querySelector(".wall .card");
        const r = c.getBoundingClientRect();
        const h = document.elementFromPoint(Math.round(r.left + r.width/2), Math.round(r.top + r.height/2));
        return { transform: getComputedStyle(c.querySelector(".card-3d")).transform.slice(0, 30),
                 hitFace: h ? (h.closest(".fc-back") ? "back" : "front") : null,
                 backActs: document.querySelectorAll(".fc-acts [data-act]").length };
      })()`);
      await shot("1-桌面-hover翻面.png");

      // 点背面「详情」进放映厅（保持 hover，背面按钮才pointer-events:auto）
      const d = await ev(`(() => {
        const b = document.querySelector(".fc-acts [data-act='detail']").getBoundingClientRect();
        return { x: Math.round(b.left + b.width/2), y: Math.round(b.top + b.height/2) };
      })()`);
      await mouse("mouseMoved", geo.x, geo.y);
      await sleep(200);
      await mouse("mousePressed", d.x, d.y);
      await mouse("mouseReleased", d.x, d.y);
      await sleep(800);
      out.afterDetailClick = await ev(`JSON.stringify({ route: state.route, id: state.routeId })`);
      await ev(`go("library")`);
      await sleep(600);
    } else {
      /* 无 hover：分支由 cardFlipByHover() 决定，与事件来源无关，
         所以用普通鼠标事件即可测到产品代码的触摸端路径。 */
      step("无hover 第一下");
      await mouse("mousePressed", geo.x, geo.y);
      await mouse("mouseReleased", geo.x, geo.y);
      await sleep(900);
      out.tap1 = await ev(`(() => {
        const c = document.querySelector(".wall .card");
        return { flipped: c.classList.contains("is-flipped"), route: state.route,
                 transform: getComputedStyle(c.querySelector(".card-3d")).transform.slice(0, 30) };
      })()`);
      await shot("2-无hover-点一下翻面.png");
      // 第二下才进详情
      await mouse("mousePressed", geo.x, geo.y);
      await mouse("mouseReleased", geo.x, geo.y);
      await sleep(800);
      out.tap2 = await ev(`JSON.stringify({ route: state.route, id: state.routeId })`);
      await ev(`go("library")`);
      await sleep(600);
    }

    out.overflow = await ev(`document.documentElement.scrollWidth - document.documentElement.clientWidth`);
    await shot("3-" + label + "-片库全景.png");
    out.errors = out.errors.concat(logs);
  } catch(e){
    out.errors.push(String(e && e.message || e));
  } finally{
    try{ if(ws) ws.close(); }catch(e){}
    try{ proc.kill(); }catch(e){}
    await sleep(400);
    try{ fs.rmSync(profile, { recursive: true, force: true }); }catch(e){}
  }
  return out;
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const desktop = await session(true, "桌面");
  const noHover = await session(false, "无hover");
  console.log("桌面端  :", JSON.stringify(desktop));
  console.log("无hover :", JSON.stringify(noHover));

  const fails = [];
  const ok = (cond, msg) => { if(!cond) fails.push(msg); };
  ok(desktop.flipBtns === 0, "桌面端仍有翻面按钮");
  ok(noHover.flipBtns === 0, "无 hover 端仍有翻面按钮");
  ok(desktop.bottomRightHit && desktop.bottomRightHit.inFlipBtn === false, "右下角仍命中翻面按钮");
  ok(/matrix3d|matrix/.test((desktop.afterHover || {}).transform || ""), "桌面端 hover 未翻面");
  ok((desktop.afterHover || {}).hitFace === "back", "桌面端 hover 后命中点未落在背面");
  ok(JSON.parse(desktop.afterDetailClick || "{}").route === "theater", "背面详情按钮没进放映厅");
  ok(noHover.cardFlipByHover === false, "无 hover 端 cardFlipByHover 应为 false");
  ok((noHover.tap1 || {}).flipped === true, "无 hover 端点第一下没翻面");
  ok((noHover.tap1 || {}).route === "library", "无 hover 端点第一下就跳走了（背面成了死功能）");
  ok(JSON.parse(noHover.tap2 || "{}").route === "theater", "无 hover 端第二下没进详情");
  ok(desktop.overflow === 0 && noHover.overflow === 0, "出现横向溢出");
  ok(desktop.errors.length === 0 && noHover.errors.length === 0, "控制台有报错");

  console.log(fails.length ? "❌ 未通过:\n  " + fails.join("\n  ") : "✅ 全部通过");
  console.log("截图目录:", OUT);
})();
