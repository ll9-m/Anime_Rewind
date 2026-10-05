/* 四套UI 套系 × 明暗主题下的勾选标记可见性。
   台账的勾选框用的是全局 input[type=checkbox] 样式，
   而各套系都会覆写 --accent / --panel-2 —— 勾号颜色取的是 --accent-ink，
   一旦某套系把 accent-ink 设成与accent 接近的颜色，勾号就消失了。
   像素判据：勾选框内必须同时存在「底色」与「勾」两类颜色。 */
const { spawn } = require("child_process");
const fs = require("fs"), path = require("path"), os = require("os");
const EDGE_CANDIDATES = [
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe"
];
const EDGE = EDGE_CANDIDATES.find(p => fs.existsSync(p));
if (!EDGE) { console.log("SKIP:找不到 Edge"); process.exit(0); }
const ROOT = path.join(__dirname, "..");
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* 像素判据需要解码 PNG。优先用 pngjs；没装就退回 Edge 自己解码 ——
   把base64 塞进页面用 createImageBitmap + OffscreenCanvas 读回像素。
   不为一个断言新增依赖：这个仓库的 node_modules 只装了 jsdom。 */
let PNG = null;
try { PNG = require("pngjs").PNG; } catch (e) { }

(async () => {
  const PORT = 9681;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "ar-skin-"));
  const proc = spawn(EDGE, ["--headless=new", "--disable-gpu", "--no-sandbox",
    "--force-device-scale-factor=1", "--window-size=1500,1000",
    "--remote-debugging-port=" + PORT, "--user-data-dir=" + profile, "about:blank"], { stdio: "ignore" });
  let pass = 0, fail = 0;
  const check = (n, ok, x) => {
    if (ok) { pass++; console.log("PASS  " + n); }
    else { fail++; console.log("FAIL  " + n + (x ? "  → " + x : "")); }
  };
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

    await send("Page.enable"); await send("Runtime.enable");
    await send("Emulation.setDeviceMetricsOverride", { width: 1500, height: 1000, deviceScaleFactor: 1, mobile: false });
    await send("Page.navigate", { url: "file:///" + path.join(ROOT, "anime-rewind.html").split(path.sep).join("/") });
    await sleep(2600);

    await ev(`
      (async () => {
        settings.stream_url = "";
        state.anime = [{
          id: "S1", titleCn: "漆黑的子弹", titleOriginal: "O", seriesId: "", statusId: "st_done",
          watchedEpisodes: 12, totalEpisodes: 12, coverUrl: "", airDate: "2026-01-01", summary: "x",
          createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
          sources: [{ id: "s1", url: "https://embey.tv/1", name: "线路 1", ep: 1, resolution: "1080P" }],
          activeSourceId: "s1", aliases: [], genres: [], studios: [], personalTags: [], reviews: []
        }];
        state.anime.forEach(a => migrateSources(a));
      })()
    `);

    const skinNames = JSON.parse(await ev(`JSON.stringify(UI_SKINS)`));
    check("取到 UI 套系列表", Array.isArray(skinNames) && skinNames.length >= 4, JSON.stringify(skinNames));

    for (const skin of skinNames) {
      for (const theme of ["dark", "light"]) {
        const r = JSON.parse(await ev(`
          (async () => {
            settings.ui_skin = ${JSON.stringify(skin)};
            settings.theme = ${JSON.stringify(theme)};
            applyAppearance();
            go("sources");
            await new Promise(r => setTimeout(r, 600));
            ledgerState.picked = [];
            rerenderLedger();
            await new Promise(r => setTimeout(r, 500));
            const b = document.querySelector('.ledger-table [data-act="pick"]');
            b.checked = true;
            b.dispatchEvent(new Event("change", { bubbles: true }));
            await new Promise(r => setTimeout(r, 500));
            const nb = document.querySelector('.ledger-table [data-act="pick"]');
            const cs = getComputedStyle(nb);
            const acs = getComputedStyle(nb, "::after");
            const rect = nb.getBoundingClientRect();
            return JSON.stringify({
              checked: nb.checked,
              accent: cs.backgroundColor,
              ink: acs.borderRightColor,
              w: acs.width, h: acs.height, borderW: acs.borderRightWidth,
              x: rect.x, y: rect.y, bw: rect.width, bh: rect.height
            });
          })()
        `));
        const tag = skin + "/" + theme;
        check(tag + " 勾选态生效", r.checked === true, JSON.stringify(r));
        check(tag + " 勾号有尺寸", parseFloat(r.w) > 0 && parseFloat(r.h) > 0, JSON.stringify(r));
        check(tag + " 勾号有描边", parseFloat(r.borderW) > 0, JSON.stringify(r));
        /* 勾与底色必须不同，否则勾画出来也看不见 */
        check(tag + " 勾色与底色可区分", r.ink !== r.accent,
          "ink=" + r.ink + " bg=" + r.accent);

        if (PNG) {
          const cap = await send("Page.captureScreenshot", {
            format: "png",
            clip: { x: r.x - 2, y: r.y - 2, width: r.bw + 4, height: r.bh + 4, scale: 4 }
          });
          const png = PNG.sync.read(Buffer.from(cap.data, "base64"));
          const set = new Set();
          for (let i = 0; i < png.data.length; i += 4) {
            set.add(png.data[i] + "," + png.data[i + 1] + "," + png.data[i + 2]);
          }
          check(tag + " 像素上勾号确实画出来了（≥3 种颜色）", set.size >= 3,
            "唯一色数 " + set.size);
        } else {
          /* 让 Edge 自己解码：读回像素的唯一色数。
             判据取「≥3 种」：抗锯齿的斜边勾会渲出过渡色，
             只有 2 种色说明勾压根没画（纯底色 + 边框）。 */
          const cap = await send("Page.captureScreenshot", {
            format: "png",
            clip: { x: r.x - 2, y: r.y - 2, width: r.bw + 4, height: r.bh + 4, scale: 4 }
          });
          const b64 = cap.data;
          const colors = JSON.parse(await ev(`
            (async () => {
              const img = new Image();
              img.src = "data:image/png;base64,${b64}";
              await img.decode();
              const c = new OffscreenCanvas(img.width, img.height);
              const g = c.getContext("2d");
              g.drawImage(img, 0, 0);
              const d = g.getImageData(0, 0, img.width, img.height).data;
              const set = new Set();
              for (let i = 0; i < d.length; i += 4){
                set.add((d[i] >> 3) + "," + (d[i+1] >> 3) + "," + (d[i+2] >> 3));
              }
              return JSON.stringify(set.size);
            })()
          `));
          check(tag + " 像素上勾号确实画出来了（量化后≥3 种颜色）", colors >= 3,
            "量化色数 " + colors);
        }
      }
    }
  } catch (e) {
    fail++;
    console.log("FAIL  测试自身异常 → " + e.message);
  } finally {
    try { proc.kill(); fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { }
  }
  console.log("\n" + pass + " 项通过，" + fail + " 项失败");
  process.exit(fail ? 1 : 0);
})();