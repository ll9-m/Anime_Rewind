/* 播放源台账 · 勾选场景出图（供人眼过一遍）。
   求值器直接照抄 verify-ledger-pick.js 那套已验证的：
   判定「要不要包一层函数」而不是无条件包 —— 无条件包会把 IIFE 变成函数本身，
   拿到 undefined，而这个undefined 看起来像「功能没生效」，极易误判成产品 bug。
   出图脚本和断言脚本共用一个求值器，是这次踩坑换来的。 */
const { spawn } = require("child_process");
const fs = require("fs"), path = require("path"), os = require("os");
const EDGE_CANDIDATES = [
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe"
];
const EDGE = EDGE_CANDIDATES.find(p => fs.existsSync(p));
if (!EDGE) { console.log("SKIP:找不到 Edge"); process.exit(0); }
const ROOT = path.join(__dirname, "..");
const OUT = path.join(ROOT, "_shot");
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const PORT = 9671;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "ar-pk-"));
  const proc = spawn(EDGE, ["--headless=new", "--disable-gpu", "--no-sandbox",
    "--remote-debugging-port=" + PORT, "--user-data-dir=" + profile, "about:blank"], { stdio: "ignore" });
  try {
    let list = null;
    for (let i = 0; i < 40; i++) {
      await sleep(500);
      try {
        const r = await fetch("http://127.0.0.1:" + PORT + "/json/list");
        list = await r.json();
        if (list && list.some(t => t.type === "page")) break;
      } catch (e) { }
    }
    const page = (list || []).find(t => t.type === "page");
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    let id = 0; const pending = new Map();
    await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
    ws.onmessage = e => {
      const m = JSON.parse(e.data);
      if (m.id && pending.has(m.id)) {
        const h = pending.get(m.id); pending.delete(m.id);
        m.error ? h.rej(new Error(JSON.stringify(m.error))) : h.res(m.result);
      }
    };
    const send = (m, p) => new Promise((res, rej) => {
      const i = ++id;
      const t = setTimeout(() => { pending.delete(i); rej(new Error("timeout " + m)); }, 25000);
      pending.set(i, { res: v => { clearTimeout(t); res(v); }, rej: e => { clearTimeout(t); rej(e); } });
      ws.send(JSON.stringify({ id: i, method: m, params: p || {} }));
    });
    const ev = async expr => {
      const t = expr.trim();
      const isIIFE = /^\(?\s*(async\s*)?(\(\s*\)|function\s*)\s*(=>|\()/.test(t);
      const hasTopReturn = /(^|[\s;{}])return[\s(]/.test(expr) && !isIIFE;
      const hasAwait = /(^|[\s;{(])await[\s)]/.test(expr);
      const body = (hasTopReturn || (hasAwait && !isIIFE))
        ? "(async()=>{" + expr + "})()" : expr;
      const r = await send("Runtime.evaluate", { expression: body, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) {
        throw new Error(r.exceptionDetails.exception
          ? r.exceptionDetails.exception.description : r.exceptionDetails.text);
      }
      return r.result.value;
    };
    const shot = async name => {
      const r = await send("Page.captureScreenshot", { format: "png" });
      fs.writeFileSync(path.join(OUT, name), Buffer.from(r.data, "base64"));
      console.log("  " + name);
    };

    await send("Page.enable"); await send("Runtime.enable");
    await send("Emulation.setDeviceMetricsOverride", { width: 1500, height: 1000, deviceScaleFactor: 1, mobile: false });
    await send("Page.navigate", { url: "file:///" + path.join(ROOT, "anime-rewind.html").split(path.sep).join("/") });
    await sleep(2800);

    /* 复刻用户截图：一部作品三条线路 + 一部作品一条，跨四个站点 */
    await ev(`
      settings.stream_url = "";
      const mk = (id, cn, sources, active) => ({
        id, titleCn: cn, titleOriginal: "O", seriesId: "", statusId: "st_watch",
        watchedEpisodes: 11, totalEpisodes: 12, coverUrl: "",
        airDate: "2026-01-01", summary: "x",
        createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
        sources, activeSourceId: active || "", aliases: [], genres: [], studios: [],
        personalTags: [], reviews: []
      });
      state.anime = [
        mk("K1", "漆黑的子弹", [
          { id: "k1", url: "https://embey.tv/player/xt3c7c57164", name: "线路 1 · embey.tv 独播", ep: 1, resolution: "1080P", note: "弹幕全" },
          { id: "k2", url: "https://www.agedm.io/play/2014012/1", name: "线路 2 · agedm.io", ep: 1, resolution: "1080P" },
          { id: "k3", url: "https://www.yinghuo.com/index.php/vod/play/id/346", name: "线路 3 · yinghuo.com 独播", ep: 1, resolution: "1080P" }
        ], "k1"),
        mk("K2", "黄金神威", [
          { id: "g1", url: "https://embey.tv/player/yy17", name: "线路 1 · embey.tv", ep: 1, resolution: "1080P" }
        ], "g1")
      ];
      state.anime.forEach(a => migrateSources(a));
      go("sources");
      await new Promise(r => setTimeout(r, 700));
      const a1 = state.anime[0];
      await updateSource({ anime: a1, source: a1.sources[0] }, {
        health: { state: "alive", at: "2026-10-05T10:00:00.000Z", detail: "服务器有响应" }
      });
      ledgerState.picked = [];
      rerenderLedger();
      await new Promise(r => setTimeout(r, 500));
    `);

    /* 勾前两行 —— 每轮都重新查询：整表重渲会让旧引用当场作废 */
    const st = JSON.parse(await ev(`
      (async () => {
        for (const i of [0, 1]){
          const b = document.querySelectorAll('.ledger-table [data-act="pick"]')[i];
          b.checked = true;
          b.dispatchEvent(new Event("change", { bubbles: true }));
          await new Promise(r => setTimeout(r, 350));
        }
        return JSON.stringify({
          picked: ledgerState.picked.length,
          checked: [...document.querySelectorAll('.ledger-table [data-act="pick"]')].filter(x => x.checked).length
        });
      })()
    `));
    console.log("  勾选状态: " + JSON.stringify(st));
    await shot("ledger-picked.png");

    /* 勾号特写 */
    const zc = JSON.parse(await ev(`
      const b = document.querySelector('.ledger-table [data-act="pick"]');
      const r = b.getBoundingClientRect();
      return JSON.stringify({ x: Math.max(0, r.x - 8), y: Math.max(0, r.y - 8),
        w: r.width + 16, h: r.height * 3 + 20 });
    `));
    const zoom = await send("Page.captureScreenshot", {
      format: "png", clip: { x: zc.x, y: zc.y, width: zc.w, height: zc.h, scale: 5 }
    });
    fs.writeFileSync(path.join(OUT, "ledger-pick-zoom.png"), Buffer.from(zoom.data, "base64"));
    console.log("  ledger-pick-zoom.png");

    /* 批量操作后的吐司：验证只弹一个 */
    await ev(`
      (async () => {
        document.getElementById("toast-root").innerHTML = "";
        document.querySelector('[data-act="bulk-disable"]').click();
        await new Promise(r => setTimeout(r, 800));
      })()
    `);
    await shot("ledger-pick-toast.png");

    /* 筛选「使用中」 */
    await ev(`
      (async () => {
        ledgerState.picked = [];
        const sel = document.getElementById("led-filter");
        sel.value = "active";
        sel.dispatchEvent(new Event("change", { bubbles: true }));
        await new Promise(r => setTimeout(r, 600));
      })()
    `);
    await shot("ledger-filter-active.png");
    console.log("完成");
  } catch (e) {
    console.log("失败：" + e.message);
  } finally {
    try { proc.kill(); fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { }
  }
})();