/* 放映厅详情页：精确定位"顶部被裁切"的到底是什么元素
 *
 * 截图里能看到 detail-hero 的封面和标题被上边界切掉一半，
 * 但「返回放映厅 / 收藏 / 神作」那一行完全看不见。
 * 这个脚本把 #topbar / #view / detail-wrap 首行 的实际坐标与
 * 裁剪关系逐条打出来，避免靠肉眼猜。
 */
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

const ROOT = path.join(__dirname, "..");
const PAGE = "file:///" + path.join(ROOT, "anime-rewind.html").replace(/\\/g, "/");
const W = Number(process.argv[2] || 1280);
const H = Number(process.argv[3] || 679);
const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const PORT = 9500 + Math.floor(Math.random() * 200);
const sleep = ms => new Promise(r => setTimeout(r, ms));

const FIXTURE = {
  id: "probe-1", titleCn: "EVA 2", titleOriginal: "", aliases: [], coverUrl: "",
  airDate: "", totalEpisodes: 13, watchedEpisodes: 0, durationMinutes: null,
  genres: [], studios: [], summary: "", communityScore: null, myScore: null,
  watchYear: null, watchGrade: null, watchChannel: null, statusId: "st_want",
  favorite: false, masterpiece: false, reviews: [], personalTags: [],
  source: "manual", fetchedAt: "2026-10-04T12:00:00.000Z",
  streamUrl: "https://www.bilibili.com/bangumi/play/ep102167?spm_id_from=333.337.0.0",
  streamEp: null, streamUrlAt: ""
};

(async () => {
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), "probe-"));
  const proc = spawn(EDGE, [
    "--headless=new", "--remote-debugging-port=" + PORT, "--user-data-dir=" + userDir,
    "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--hide-scrollbars",
    "--force-device-scale-factor=1", "--window-size=" + W + "," + H, "about:blank"
  ], { stdio: "ignore" });

  let ver = null;
  for (let i = 0; i < 60; i++) {
    await sleep(250);
    try { ver = await (await fetch("http://127.0.0.1:" + PORT + "/json/version")).json(); break; } catch (e) {}
  }
  const list = await (await fetch("http://127.0.0.1:" + PORT + "/json/list")).json();
  const target = list.find(t => t.type === "page");
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let id = 0; const pending = new Map();
  ws.addEventListener("message", e => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  });
  await new Promise(r => ws.addEventListener("open", r));
  const send = (method, params, sessionId) => new Promise((res, rej) => {
    const mid = ++id;
    pending.set(mid, m => m.error ? rej(new Error(method + ": " + JSON.stringify(m.error))) : res(m.result));
    ws.send(JSON.stringify({ id: mid, method, params: params || {}, sessionId }));
  });
  const { sessionId } = await send("Target.attachToTarget", { targetId: target.id, flatten: true });
  const S = (m, p) => send(m, p, sessionId);
  await S("Page.enable"); await S("Runtime.enable");
  await S("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });
  await S("Page.navigate", { url: PAGE });
  await sleep(2600);

  const ev = async code => {
    const r = await S("Runtime.evaluate", {
      expression: "(async()=>{" + code + "})()", awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails.exception));
    return r.result.value;
  };

  await ev(`
    localStorage.clear();
    settings.ui_skin = "pixel";
    applyAppearance();
    state.anime = [${JSON.stringify(FIXTURE)}];
    go("theater", "probe-1");
    await new Promise(r => setTimeout(r, 900));
    return 1;
  `);
  await sleep(800);

  const out = await ev(`
    const r = n => { const b = n.getBoundingClientRect(); return { top: Math.round(b.top), bottom: Math.round(b.bottom), h: Math.round(b.height) }; };
    const tb = document.getElementById("topbar");
    const view = document.getElementById("view");
    const cs = getComputedStyle(tb);
    const rows = [...view.querySelectorAll(".detail-wrap > *")].slice(0, 4).map(n => ({
      cls: n.className || n.tagName,
      ...r(n),
      text: (n.textContent||"").trim().replace(/\\s+/g," ").slice(0, 30),
      visibleInView: n.getBoundingClientRect().top >= view.getBoundingClientRect().top - 0.5
    }));
    return JSON.stringify({
      viewport: { w: innerWidth, h: innerHeight },
      topbar: { ...r(tb), position: cs.position, zIndex: cs.zIndex, overflow: cs.overflow },
      view: { ...r(view), scrollTop: view.scrollTop, scrollHeight: view.scrollHeight, clientHeight: view.clientHeight, overflow: getComputedStyle(view).overflowY },
      firstRows: rows,
      hero: (() => { const h = view.querySelector(".detail-hero"); return h ? r(h) : null; })(),
      coverRect: (() => { const c = view.querySelector(".detail-cover"); return c ? r(c) : null; })()
    }, null, 1);
  `);
  console.log(out);
  ws.close(); proc.kill();
  try { fs.rmSync(userDir, { recursive: true, force: true }); } catch (e) {}
  process.exit(0);
})().catch(e => { console.error("失败: " + e.message); process.exit(1); });
