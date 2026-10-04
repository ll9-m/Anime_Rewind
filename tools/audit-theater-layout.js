/* 放映厅详情页布局体检
 *
 * 截图能看出"不对劲"，但看不出"为什么"。这个脚本把可疑点变成数字：
 * 顶栏是否遮挡内容、hero 右侧是否大片留白、折叠箭头是否可见、
 * 表单控件是否对齐、对比度是否达标。
 *
 * 零依赖：Node 22 内置 WebSocket 直连 CDP + 真浏览器（jsdom 无 CSS 计算）。
 * 用法：node tools/audit-theater-layout.js [skin] [width] [height]
 */
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

const ROOT = path.join(__dirname, "..");
const PAGE = "file:///" + path.join(ROOT, "anime-rewind.html").replace(/\\/g, "/");
const SKIN = process.argv[2] || "pixel";
const W = Number(process.argv[3] || 1280);
const H = Number(process.argv[4] || 860);
const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const PORT = 9700 + Math.floor(Math.random() * 200);

const sleep = ms => new Promise(r => setTimeout(r, ms));

let pass = 0, fail = 0;
const bad = [];
function check(name, cond, detail){
  if (cond) { pass++; console.log("PASS " + name); }
  else { fail++; bad.push(name + (detail ? " — " + detail : "")); console.log("FAIL " + name + (detail ? "  → " + detail : "")); }
}

/* 一条"信息稀疏"的作品：这是最容易暴露布局问题的形态 ——
   标题短、无原名、无别名、进度 0。截图里的正是这种形态。 */
const FIXTURE = {
  id: "audit-1",
  titleCn: "EVA 2",
  titleOriginal: "",
  aliases: [],
  coverUrl: "",
  airDate: "",
  totalEpisodes: 13,
  watchedEpisodes: 0,
  durationMinutes: null,
  genres: [],
  studios: [],
  summary: "",
  communityScore: null,
  myScore: null,
  watchYear: null,
  watchGrade: null,
  watchChannel: null,
  statusId: "st_want",
  favorite: false,
  masterpiece: false,
  reviews: [],
  personalTags: [],
  source: "manual",
  fetchedAt: "2026-10-04T12:00:00.000Z",
  streamUrl: "https://www.bilibili.com/bangumi/play/ep102167?spm_id_from=333.337.0.0",
  streamEp: null,
  streamUrlAt: ""
};

(async () => {
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), "audit-"));
  const proc = spawn(EDGE, [
    "--headless=new", "--remote-debugging-port=" + PORT, "--user-data-dir=" + userDir,
    "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--hide-scrollbars",
    "--force-device-scale-factor=1", "--window-size=" + W + "," + H, "about:blank"
  ], { stdio: "ignore" });

  let ver = null;
  for (let i = 0; i < 60; i++) {
    await sleep(250);
    try { ver = await (await fetch("http://127.0.0.1:" + PORT + "/json/version")).json(); break; }
    catch (e) {}
  }
  if (!ver) { proc.kill(); throw new Error("Edge 没起来"); }

  const list = await (await fetch("http://127.0.0.1:" + PORT + "/json/list")).json();
  const target = list.find(t => t.type === "page");
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const events = [];
  ws.addEventListener("message", ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    else if (m.method) events.push(m);
  });
  await new Promise(r => ws.addEventListener("open", r));
  const send = (method, params, sessionId) => new Promise((res, rej) => {
    const mid = ++id;
    pending.set(mid, m => m.error ? rej(new Error(method + ": " + JSON.stringify(m.error))) : res(m.result));
    ws.send(JSON.stringify({ id: mid, method, params: params || {}, sessionId }));
  });

  const { sessionId } = await send("Target.attachToTarget", { targetId: target.id, flatten: true });
  const S = (m, p) => send(m, p, sessionId);
  await S("Page.enable");
  await S("Runtime.enable");
  await S("Log.enable");
  await S("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });
  await S("Page.navigate", { url: PAGE });
  await sleep(2600);

  const ev = async code => {
    const r = await S("Runtime.evaluate", {
      expression: "(async()=>{" + code + "})()", awaitPromise: true, returnByValue: true
    });
    if (r.exceptionDetails) throw new Error("页面内报错: " + JSON.stringify(r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text));
    return r.result.value;
  };

  await ev(`
    localStorage.clear();
    settings.ui_skin = ${JSON.stringify(SKIN)};
    applyAppearance();
    state.anime = [${JSON.stringify(FIXTURE)}];
    go("theater", "audit-1");
    await new Promise(r => setTimeout(r, 500));
    return 1;
  `);
  await sleep(1200);

  // ---- 1. 顶栏遮挡：详情首行是否被 topbar 盖住 ----
  const cover = await ev(`
    const v = document.getElementById("view");
    const tb = document.getElementById("topbar");
    const vr = v.getBoundingClientRect(), tr = tb.getBoundingClientRect();
    const first = v.querySelector(".detail-wrap > *");
    const fr = first.getBoundingClientRect();
    return JSON.stringify({
      viewTop: Math.round(vr.top), topbarBottom: Math.round(tr.bottom),
      firstTop: Math.round(fr.top), firstText: (first.textContent||"").trim().slice(0,24),
      scrollTop: v.scrollTop
    });
  `);
  const c = JSON.parse(cover);
  check("详情首行不被顶栏遮挡", c.firstTop >= c.topbarBottom - 1,
    "首行 top=" + c.firstTop + " 顶栏 bottom=" + c.topbarBottom + " 内容「" + c.firstText + "」");
  check("进入详情后视图滚动到顶部", c.scrollTop === 0, "scrollTop=" + c.scrollTop);

  // ---- 2. hero 右侧留白：标题短时右列是否浪费整屏 ----
  const hero = await ev(`
    const h = document.querySelector(".detail-hero");
    if (!h) return "null";
    const r = h.getBoundingClientRect();
    const right = h.children[1];
    const rr = right.getBoundingClientRect();
    /* 右列最后一个可见元素的底边 —— 用它判断"内容实际用到的高度" */
    let bottom = rr.top;
    right.querySelectorAll("*").forEach(n => {
      const b = n.getBoundingClientRect();
      if (b.height > 0) bottom = Math.max(bottom, b.bottom);
    });
    return JSON.stringify({
      heroH: Math.round(r.height), coverH: Math.round(h.children[0].getBoundingClientRect().height),
      rightContentBottom: Math.round(bottom), rightTop: Math.round(rr.top),
      heroW: Math.round(r.width)
    });
  `);
  const h = JSON.parse(hero);
  if (h !== "null") {
    const usedH = h.rightContentBottom - h.rightTop;
    check("hero 右列没有大片空白", usedH > h.coverH * 0.5,
      "右列内容高 " + usedH + "px，封面高 " + h.coverH + "px（内容不足封面一半即视觉空洞）");
  }

  // ---- 3. 折叠箭头可见性：▾ 在像素字体下可能缺字形 ----
  const arrow = await ev(`
    const out = [];
    document.querySelectorAll("#view details > summary").forEach(s => {
      const cs = getComputedStyle(s, "::after");
      const b = s.getBoundingClientRect();
      out.push({
        text: (s.textContent||"").trim().slice(0,12),
        content: cs.content, fontFamily: cs.fontFamily.slice(0,40),
        color: cs.color, w: Math.round(b.width)
      });
    });
    return JSON.stringify(out);
  `);
  const arrows = JSON.parse(arrow);
  check("存在 details 折叠项", arrows.length > 0, "找到 " + arrows.length + " 个");
  arrows.forEach(a => {
    check("折叠箭头 ::after 使用字体回退而非像素字体（▾ 缺字形会变豆腐块）",
      !/Silkscreen|Press Start|VT323|Fusion/i.test(a.fontFamily),
      "「" + a.text + "」after 字体=" + a.fontFamily);
  });

  // ---- 4. 播放器表单：URL 框与集数框是否同一行、按钮是否可见 ----
  const form = await ev(`
    const u = document.getElementById("st-url");
    const ep = document.getElementById("st-ep");
    if (!u || !ep) return "null";
    const ur = u.getBoundingClientRect(), er = ep.getBoundingClientRect();
    const btns = [...document.querySelectorAll("[data-st]")].map(b => {
      const bb = b.getBoundingClientRect();
      return { act: b.dataset.st, w: Math.round(bb.width), h: Math.round(bb.height),
               hidden: b.hidden, disabled: b.disabled };
    });
    return JSON.stringify({
      sameRow: Math.abs(ur.top - er.top) < 12,
      urlW: Math.round(ur.width), epW: Math.round(er.width),
      btns
    });
  `);
  const f = JSON.parse(form);
  if (f !== "null") {
    check("网址框与集数框同一行", f.sameRow);
    check("网址框有可用宽度", f.urlW > 200, "url 宽 " + f.urlW + "px");
    check("集数框有可用宽度", f.epW >= 90, "ep 宽 " + f.epW + "px");
    f.btns.forEach(b => {
      check("按钮 [" + b.act + "] 可见且可点", !b.hidden && !b.disabled && b.w > 40 && b.h >= 24,
        "hidden=" + b.hidden + " disabled=" + b.disabled + " " + b.w + "x" + b.h);
    });
  }

  // ---- 5. 面板标题与提示是否挤在一起 ----
  const panel = await ev(`
    const h = document.querySelector(".stream-panel .panel-head");
    if (!h) return "null";
    const hb = h.getBoundingClientRect();
    const title = h.querySelector("h3").getBoundingClientRect();
    const hint = h.querySelector(".hint");
    const hr = hint.getBoundingClientRect();
    return JSON.stringify({
      titleW: Math.round(title.width), hintW: Math.round(hr.width),
      overlap: title.right > hr.left + 1,
      gap: Math.round(hr.left - title.right)
    });
  `);
  const p = JSON.parse(panel);
  if (p !== "null") {
    check("面板标题与右侧提示不重叠", !p.overlap, "间距 " + p.gap + "px");
  }

  // ---- 6. 进度条与百分比 ----
  const prog = await ev(`
    const s = document.querySelector(".sec-title b");
    if (!s) return "null";
    const b = s.getBoundingClientRect();
    const cs = getComputedStyle(s);
    return JSON.stringify({ text: s.textContent, w: Math.round(b.width), color: cs.color, weight: cs.fontWeight });
  `);
  const pr = JSON.parse(prog);
  check("进度百分比有可见宽度", pr !== "null" && pr.w > 20, pr === "null" ? "没找到" : pr.text + " " + pr.w + "px");

  const errs = events.filter(e => e.method === "Log.entryAdded" && e.params.entry.level === "error")
    .map(e => e.params.entry.text);
  check("页面无控制台错误", errs.length === 0, errs.join(" | "));

  console.log("\\n通过 " + pass + " / 失败 " + fail);
  if (bad.length) { console.log("失败项:"); bad.forEach(b => console.log("  - " + b)); }
  ws.close();
  proc.kill();
  try { fs.rmSync(userDir, { recursive: true, force: true }); } catch (e) {}
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error("失败: " + e.message); process.exit(1); });
