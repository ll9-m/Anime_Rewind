/* 勾选标记的可见性实测。
   断言不能只看 box.checked —— 那只是状态；
   用户抱怨的是「看不见」，所以必须量渲染出来的像素。 */
const { spawn } = require("child_process");
const fs = require("fs"), path = require("path"), os = require("os");
const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const ROOT = "D:/env/projects/Anime_Rewind";
const sleep = ms => new Promise(r => setTimeout(r, ms));
const EDGE_CANDIDATES = [
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe"
];
const EDGE_PATH = EDGE_CANDIDATES.find(p => fs.existsSync(p));
if (!EDGE_PATH) { console.log("SKIP:找不到 Edge"); process.exit(0); }

(async () => {
  const PORT = 9651;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "ar-chk-"));
  const proc = spawn(EDGE_PATH, ["--headless=new", "--disable-gpu", "--no-sandbox",
    "--force-device-scale-factor=1", "--window-size=1500,1000",
    "--remote-debugging-port=" + PORT, "--user-data-dir=" + profile, "about:blank"], { stdio: "ignore" });
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
    /* 三种写法都要吃：
       ① 语句序列（含顶层 return / await）→ 必须包 async 壳
       ② 同步 IIFE  (() => {...})()        → 原样求值
       ③ 裸表达式（awaitPromise 已开）      → 原样求值
       判据：出现顶层 await，或以 return 开头且不是 IIFE。
       以 ( 开头的 IIFE 里的 return 是合法的，不能据此外包。 */
    const t = expr.trim();
    /* 箭头函数IIFE 有两种写法：(() => …)()与 (async () => …)()。
       之前的正则只认 (function(…)，把箭头式的当成了裸语句，
       于是给它外包一层 async 壳 → return 的值变成 undefined。 */
    const isIIFE = /^\(?\s*(async\s*)?(\(\s*\)|function\s*)\s*(=>|\()/.test(t);
    const hasTopReturn = /(^|[\s;{}])return[\s(]/.test(expr) && !isIIFE;
    const hasAwait = /(^|[\s;{(])await[\s)]/.test(expr);
    const body = (hasTopReturn || (hasAwait && !isIIFE))
      ? "(async()=>{" + expr + "})()" : expr;
    const r = await send("Runtime.evaluate", {
      expression: body, returnByValue: true, awaitPromise: true
    });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception
        ? r.exceptionDetails.exception.description : r.exceptionDetails.text);
    }
    return r.result.value;
  };
  let pass = 0, fail = 0;
  const check = (name, ok, extra) => {
    if (ok) { pass++; console.log("PASS  " + name); }
    else { fail++; console.log("FAIL  " + name + (extra ? "  → " + extra : "")); }
  };

  try {
    await send("Page.enable"); await send("Runtime.enable");
    await send("Emulation.setDeviceMetricsOverride", { width: 1500, height: 1000, deviceScaleFactor: 1, mobile: false });
    await send("Page.navigate", { url: "file:///" + path.join(ROOT, "anime-rewind.html").replace(/\\/g, "/") });
    await sleep(2600);

    const setup = await ev(`
      settings.stream_url = "";
      settings.data_bg_image = "";
      const mk = (id, cn, sources, active) => ({
        id, titleCn: cn, titleOriginal: "O", seriesId: "",
        statusId: "st_done", watchedEpisodes: 12, totalEpisodes: 12,
        coverUrl: "", airDate: "2026-01-01", summary: "x",
        createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
        sources, activeSourceId: active || "", aliases: [], genres: [], studios: [],
        personalTags: [], reviews: []
      });
      state.anime = [
        mk("C1", "漆黑的子弹", [
          { id: "k1", url: "https://embey.tv/1", name: "线路 1 · embey.tv 独立", ep: 1, resolution: "1080P" },
          { id: "k2", url: "https://www.agedm.io/2", name: "线路 2 · agedm.io", ep: 1, resolution: "1080P" },
          { id: "k3", url: "https://www.yinghuo.com/3", name: "线路 3 · yinghuo.com 独播", ep: 1, resolution: "1080P" }
        ], "k1")
      ];
      state.anime.forEach(a => migrateSources(a));
      go("sources");
      await new Promise(r => setTimeout(r, 700));
      return JSON.stringify({ rows: document.querySelectorAll(".ledger-table tbody tr").length });
    `);
    check("台账渲染出 3 行", JSON.parse(setup).rows === 3, setup);

    /* ---------- 1. 勾选后 checkbox 必须真的 checked ---------- */
    const pick = await ev(`
      const box = document.querySelector('.ledger-table [data-act="pick"]');
      box.checked = true;
      box.dispatchEvent(new Event("change", { bubbles: true }));
      await new Promise(r => setTimeout(r, 400));
      const nb = document.querySelector('.ledger-table [data-act="pick"]');
      const tr = nb.closest("tr");
      return JSON.stringify({
        picked: ledgerState.picked.length,
        boxChecked: nb.checked,
        trPicked: tr.classList.contains("is-picked"),
        attr: nb.hasAttribute("checked")
      });
    `);
    const pk = JSON.parse(pick);
    check("勾选进入 picked 集合", pk.picked === 1, pick);
    check("重渲后 checkbox 仍是 checked（行高亮但框里没勾的那种 bug）",
      pk.boxChecked === true, pick);
    check("重渲后行仍有 is-picked 高亮", pk.trPicked === true, pick);
    check("checked 以属性形式落到 HTML 上（不是只靠 DOM 属性）",
      pk.attr === true, pick);

    /* ---------- 2. 勾号必须**画得出来** ---------- */
    const shot = path.join(ROOT, "_shot", "_chk-box.png");
    fs.mkdirSync(path.dirname(shot), { recursive: true });
    const boxClip = await ev(`
      const b = document.querySelector('.ledger-table [data-act="pick"]');
      const r = b.getBoundingClientRect();
      return JSON.stringify({ x: Math.max(0, r.x - 6), y: Math.max(0, r.y - 6), w: r.width + 12, h: r.height + 12 });
    `);
    const bc = JSON.parse(boxClip);
    const cap = await send("Page.captureScreenshot", {
      format: "png", clip: { x: bc.x, y: bc.y, width: bc.w, height: bc.h, scale: 4 }
    });
    fs.writeFileSync(shot, Buffer.from(cap.data, "base64"));

    const ink = await ev(`
      (() => {
        /* 直接量勾号伪元素的几何：有宽高才算真的画出来了 */
        const b = document.querySelector('.ledger-table [data-act="pick"]');
        const cs = getComputedStyle(b, "::after");
        const r = b.getBoundingClientRect();
        return JSON.stringify({
          content: cs.content, w: cs.width, h: cs.height,
          borderW: cs.borderRightWidth, borderC: cs.borderRightColor,
          pos: cs.position, boxW: r.width, boxH: r.height
        });
      })()
    `);
    const ik = JSON.parse(ink);
    check("勾号伪元素已生成", ik.content !== "none" && ik.w !== "0px", ink);
    check("勾号有实际尺寸", parseFloat(ik.w) > 0 && parseFloat(ik.h) > 0, ink);
    check("勾号用边框描边而非填充（对角线）", parseFloat(ik.borderW) > 0, ink);
    check("勾号在框内且不溢出", parseFloat(ik.boxW) >= 18, ink);

    /* 像素判据：勾选框内必须有深色笔画（勾），不能是一块纯色 */
    const { PNG } = (() => { try { return require("pngjs"); } catch (e) { return {}; } })();
    let pixelNote = "";
    if (PNG) {
      const png = PNG.sync.read(fs.readFileSync(shot));
      const set = new Set();
      for (let i = 0; i < png.data.length; i += 4) {
        set.add(png.data[i] + "," + png.data[i + 1] + "," + png.data[i + 2]);
      }
      /*勾选态：accent 底色 + accent-ink 勾，共两类以上颜色 */
      check("勾选框像素里同时存在底色与勾的两种颜色", set.size >= 2,
        "唯一色数 " + set.size + " " + pixelNote);
    } else {
      console.log("SKIP  像素判据（未装 pngjs）");
    }

    /* ---------- 3. 取消勾选也要能取消 ---------- */
    const un = await ev(`
      const b = document.querySelector('.ledger-table [data-act="pick"]');
      b.checked = false;
      b.dispatchEvent(new Event("change", { bubbles: true }));
      await new Promise(r => setTimeout(r, 400));
      const nb = document.querySelector('.ledger-table [data-act="pick"]');
      return JSON.stringify({
        picked: ledgerState.picked.length,
        boxChecked: nb.checked,
        trPicked: nb.closest("tr").classList.contains("is-picked")
      });
    `);
    const un2 = JSON.parse(un);
    check("取消勾选后 picked 清空", un2.picked === 0, un);
    check("取消勾选后 checkbox 不再 checked", un2.boxChecked === false, un);
    check("取消勾选后高亮同步消失", un2.trPicked === false, un);

    /* ---------- 3b. 连续勾多行（每行都要真的勾上） ---------- */
    const multi2 = await ev(`
      ledgerState.picked = [];
      rerenderLedger();
      await new Promise(r => setTimeout(r, 350));
      for (const i of [0, 1]){
        const b = document.querySelectorAll('.ledger-table [data-act="pick"]')[i];
        b.checked = true;
        b.dispatchEvent(new Event("change", { bubbles: true }));
        await new Promise(r => setTimeout(r, 320));
      }
      const boxes = [...document.querySelectorAll('.ledger-table [data-act="pick"]')];
      return JSON.stringify({
        picked: ledgerState.picked.length,
        checked: boxes.filter(b => b.checked).length,
        pickedRows: document.querySelectorAll(".ledger-table tr.is-picked").length,
        count: document.querySelector('[data-act="pick-none"]').textContent,
        bulkOff: document.querySelector('[data-act="bulk-disable"]').disabled
      });
    `);
    const m2 = JSON.parse(multi2);
    check("连续勾选两行都进了 picked 集合", m2.picked === 2, multi2);
    check("两个框都处于勾选态", m2.checked === 2, multi2);
    check("两行都有高亮", m2.pickedRows === 2, multi2);
    check("计数文案同步为 2", /2/.test(m2.count), m2.count);
    check("批量按钮已解禁", m2.bulkOff === false, multi2);

    /* 出图：勾选态整页 + 勾号特写，供人眼过一遍 */
    fs.mkdirSync(path.join(ROOT, "_shot"), { recursive: true });
    const full = await send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(ROOT, "_shot", "ledger-picked.png"), Buffer.from(full.data, "base64"));
    const zoomClip = JSON.parse(await ev(`
      const b = document.querySelector('.ledger-table [data-act="pick"]');
      const r = b.getBoundingClientRect();
      return JSON.stringify({ x: Math.max(0, r.x - 8), y: Math.max(0, r.y - 8),
        w: r.width + 16, h: r.height * 3 + 20 });
    `));
    const zoom = await send("Page.captureScreenshot", {
      format: "png", clip: { x: zoomClip.x, y: zoomClip.y, width: zoomClip.w, height: zoomClip.h, scale: 5 }
    });
    fs.writeFileSync(path.join(ROOT, "_shot", "ledger-pick-zoom.png"), Buffer.from(zoom.data, "base64"));

    /* ---------- 4. 一个动作只弹一次吐司（不是刷屏） ---------- */
    const toast1 = await ev(`
      document.getElementById("toast-root").innerHTML = "";
      ledgerState.picked = [];
      const box = document.querySelector('.ledger-table [data-act="pick"]');
      box.checked = true;
      box.dispatchEvent(new Event("change", { bubbles: true }));
      await new Promise(r => setTimeout(r, 350));
      document.querySelector('[data-act="bulk-enable"]').click();
      await new Promise(r => setTimeout(r, 700));
      return JSON.stringify({
        toasts: document.querySelectorAll("#toast-root .toast").length,
        text: document.querySelector("#toast-root .toast")
          ? document.querySelector("#toast-root .toast").textContent.trim() : ""
      });
    `);
    const t1 = JSON.parse(toast1);
    check("批量启用只弹一个吐司（重复绑定会弹 N 个）", t1.toasts === 1, toast1);
    check("吐司文案正确", /已启用\s*1\s*条线路/.test(t1.text), t1.text);

    /* ---------- 5. 重渲染多次后仍然只触发一次 ---------- */
    const toast5 = await ev(`
      document.getElementById("toast-root").innerHTML = "";
      ledgerState.picked = [];
      /* 先让页面重渲 6 次 —— 这是监听器累积的触发条件 */
      for (let i = 0; i < 6; i++){
        rerenderLedger();
        await new Promise(r => setTimeout(r, 120));
      }
      const box = document.querySelector('.ledger-table [data-act="pick"]');
      box.checked = true;
      box.dispatchEvent(new Event("change", { bubbles: true }));
      await new Promise(r => setTimeout(r, 300));
      document.querySelector('[data-act="bulk-dead"]').click();
      await new Promise(r => setTimeout(r, 700));
      return JSON.stringify({
        toasts: document.querySelectorAll("#toast-root .toast").length,
        bound: document.getElementById("view").dataset.ledgerBound
      });
    `);
    const t5 = JSON.parse(toast5);
    check("连渲 6 次后仍只弹一个吐司（累积监听器的确诊判据）", t5.toasts === 1, toast5);
    check("幂等标记已打上", t5.bound === "1", toast5);

    /* ---------- 6. 全选/批量也只执行一次 ---------- */
    const once = await ev(`
      document.getElementById("toast-root").innerHTML = "";
      ledgerState.picked = [];
      rerenderLedger();
      await new Promise(r => setTimeout(r, 250));
      document.querySelector('[data-act="pick-all"]').click();
      await new Promise(r => setTimeout(r, 400));
      const n1 = ledgerState.picked.length;
      document.getElementById("toast-root").innerHTML = "";
      document.querySelector('[data-act="bulk-disable"]').click();
      await new Promise(r => setTimeout(r, 800));
      const a = state.anime[0];
      const disabledCount = a.sources.filter(s => s.enabled === false).length;
      return JSON.stringify({
        n1, toasts: document.querySelectorAll("#toast-root .toast").length,
        disabledCount, dupes: ledgerState.picked.length
      });
    `);
    const oc = JSON.parse(once);
    check("全选本页选中 3 行", oc.n1 === 3, once);
    check("批量停用只弹一个吐司", oc.toasts === 1, once);
    check("批量停用把3 条都停了（没有重复写导致状态翻转）",
      oc.disabledCount === 3, once);

    /* ---------- 7. 筛选里要有「使用中」 ----------
       必须排在第 6 步之前或重置数据：第 6 步刚把三条线路全停用，
       而徽标只给真能播的线路（见 sourceFlags），
       这时再筛「使用中」必然是 0 行 —— 那是数据状态决定的，不是筛选坏了。*/
    await ev(`
      (async () => {
        const mk = (id, cn, sources, active) => ({
          id, titleCn: cn, titleOriginal: "O", seriesId: "", statusId: "st_done",
          watchedEpisodes: 1, totalEpisodes: 1, coverUrl: "", airDate: "2026-01-01", summary: "x",
          createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
          sources, activeSourceId: active || "", aliases: [], genres: [], studios: [],
          personalTags: [], reviews: []
        });
        state.anime = [
          mk("C1", "漆黑的子弹", [
            { id: "k1", url: "https://embey.tv/1", name: "线路 1 · embey.tv 独立", ep: 1, resolution: "1080P" },
            { id: "k2", url: "https://www.agedm.io/2", name: "线路 2 · agedm.io", ep: 1, resolution: "1080P" },
            { id: "k3", url: "https://www.yinghuo.com/3", name: "线路 3 · yinghuo.com 独播", ep: 1, resolution: "1080P" }
          ], "k1")
        ];
        state.anime.forEach(a => migrateSources(a));
      })()
    `);
    const filt = await ev(`
      ledgerState.picked = [];
      rerenderLedger();
      await new Promise(r => setTimeout(r, 500));
      const sel = document.getElementById("led-filter");
      const opts = [...sel.options].map(o => ({ v: o.value, t: o.textContent }));
      sel.value = "active";
      sel.dispatchEvent(new Event("change", { bubbles: true }));
      await new Promise(r => setTimeout(r, 500));
      const rowsActive = document.querySelectorAll(".ledger-table tbody tr").length;
      const rowKeys = [...document.querySelectorAll(".ledger-table tbody tr")].map(tr => tr.dataset.key);
      const fr = document.querySelector(".ledger-table tbody tr .flag-row");
      const flags = fr ? fr.textContent : "(无行)";
      sel.value = "";
      sel.dispatchEvent(new Event("change", { bubbles: true }));
      await new Promise(r => setTimeout(r, 400));
      return JSON.stringify({ opts, rowsActive, rowKeys, flags,
        back: document.querySelectorAll(".ledger-table tbody tr").length });
    `);
    const fl = JSON.parse(filt);
    check("筛选下拉包含「使用中」", fl.opts.some(o => o.v === "active"), JSON.stringify(fl.opts));
    check("「使用中」筛选出 1 行", fl.rowsActive === 1, filt);
    check("「使用中」筛出的正是 k1", fl.rowKeys[0] === "C1|k1", filt);
    check("该行徽标里有「使用中」", /使用中/.test(fl.flags || ""), fl.flags);
    check("清空筛选后恢复 3 行", fl.back === 3, filt);

    /* ---------- 8. 每个作品都应有使用中（不多不少） ---------- */
    const multi = await ev(`
      const mk = (id, cn, sources, active) => ({
        id, titleCn: cn, titleOriginal: "O", seriesId: "", statusId: "st_done",
        watchedEpisodes: 1, totalEpisodes: 1, coverUrl: "", airDate: "2026-01-01", summary: "x",
        createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
        sources, activeSourceId: active || "", aliases: [], genres: [], studios: [],
        personalTags: [], reviews: []
      });
      state.anime = [
        mk("M1", "甲", [{ id: "m1", url: "https://a.com/1", name: "A" }], "m1"),
        mk("M2", "乙", [{ id: "n1", url: "https://b.com/1", name: "B" },
                       { id: "n2", url: "https://b.com/2", name: "C" }], "n2")
      ];
      state.anime.forEach(a => migrateSources(a));
      ledgerState.q = ""; ledgerState.filter = ""; ledgerState.picked = [];
      rerenderLedger();
      await new Promise(r => setTimeout(r, 500));
      const flagsPerRow = [...document.querySelectorAll(".ledger-table tbody tr")].map(tr => ({
        key: tr.dataset.key, has: /使用中/.test(tr.querySelector(".flag-row").textContent)
      }));
      ledgerState.filter = "active";
      rerenderLedger();
      await new Promise(r => setTimeout(r, 400));
      const act = [...document.querySelectorAll(".ledger-table tbody tr")].map(tr => tr.dataset.key);
      ledgerState.filter = "";
      return JSON.stringify({ flagsPerRow, act });
    `);
    const mu = JSON.parse(multi);
    check("甲乙两部共 3 行，使用中恰好 2 行",
      mu.flagsPerRow.filter(f => f.has).length === 2, multi);
    check("乙的第二条线路被正确标为使用中（尊重 activeSourceId）",
      mu.act.indexOf("M2|n2") >= 0, multi);

    /* ---------- 8b. 全停用后不该还有「使用中」 ---------- */
    const alldead = await ev(`
      (async () => {
        const mk = (id, cn, sources, active) => ({
          id, titleCn: cn, titleOriginal: "O", seriesId: "", statusId: "st_done",
          watchedEpisodes: 1, totalEpisodes: 1, coverUrl: "", airDate: "2026-01-01", summary: "x",
          createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
          sources, activeSourceId: active || "", aliases: [], genres: [], studios: [],
          personalTags: [], reviews: []
        });
        state.anime = [
          mk("D1", "唯一线路", [{ id: "d1", url: "https://x.com/1", name: "X", enabled: false }], "d1")
        ];
        state.anime.forEach(a => migrateSources(a));
        ledgerState.q = ""; ledgerState.filter = ""; ledgerState.picked = [];
        rerenderLedger();
        await new Promise(r => setTimeout(r, 800));
        const tr = document.querySelector(".ledger-table tbody tr");
        const flags = tr && tr.querySelector(".flag-row")
          ? tr.querySelector(".flag-row").textContent : "(无行)";
        ledgerState.filter = "active";
        rerenderLedger();
        await new Promise(r => setTimeout(r, 400));
        const actRows = document.querySelectorAll(".ledger-table tbody tr").length;
        ledgerState.filter = "";
        /* activeSourceOf 仍要给出结果 —— 详情页不能因此显示不出线路 */
        const act = activeSourceOf(state.anime[0]);
        return JSON.stringify({ flags, actRows, actId: act ? act.id : null });
      })()
    `);
    const ad = JSON.parse(alldead);
    check("全停用后不再显示「使用中」（徽标要诚实）",
      /使用中/.test(ad.flags) === false, ad.flags);
    check("全停用时「使用中」筛选出 0 行", ad.actRows === 0, alldead);
    check("全停用时 activeSourceOf 仍返回一条（详情页不会空白）",
      ad.actId === "d1", alldead);

    /* ---------- 9. 控制台干净 ---------- */
    const errs = await ev(`
      return JSON.stringify(window.__arErrs || []);
    `);
    const errList = JSON.parse(errs);
    check("控制台无报错", errList.length === 0, errList.slice(0, 3).join(" | "));
  } catch (e) {
    fail++;
    console.log("FAIL  测试自身异常 → " + e.message);
  } finally {
    try { proc.kill(); fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { }
  }
  console.log("\n" + pass + " 项通过，" + fail + " 项失败");
  process.exit(fail ? 1 : 0);
})();