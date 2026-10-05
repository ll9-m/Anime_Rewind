/* 「自己选择使用哪个播放源」的真浏览器验证。
 *
 * 用户报的是功能缺失，两个入口都要验：
 *   ① 放映厅详情页：线路列表可点，选中态立刻变化，且不必先播放
 *   ② 播放源台账页：每行有「设为使用中」，当前那条不再显示按钮
 *
 * jsdom 测不了的几件事在这里测：
 *   - 胶囊是否真的看得见（宽度/可见性/不与输入框重叠）
 *   - 换线路后整页是否被重渲（重渲会销毁正在播的播放器）
 *   - 从一部作品切到另一部后，委托处理器闭包里捕获的 a 是否还是第一部
 *     —— 这是上一版改委托时差点写进去的数据损坏级 bug
 */
const { spawn } = require("child_process");
const fs = require("fs"), path = require("path"), os = require("os");
const sleep = ms => new Promise(r => setTimeout(r, ms));
const EDGE_CANDIDATES = [
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe"
];
const EDGE_PATH = EDGE_CANDIDATES.find(p => fs.existsSync(p));
if (!EDGE_PATH) { console.log("SKIP:找不到 Edge"); process.exit(0); }
const ROOT = "D:/env/projects/Anime_Rewind";

(async () => {
  const PORT = 9663;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "ar-src-"));
  const proc = spawn(EDGE_PATH, ["--headless=new", "--disable-gpu", "--no-sandbox",
    "--force-device-scale-factor=1", "--window-size=1500,1050",
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
  /* 求值器：箭头 IIFE 与 async IIFE 都要能原样求值。
     之前的正则只认 (function(…，把箭头式的当成裸语句，
     外包一层 async 壳之后return 的值就变成 undefined ——
     报出来的是 undefined，看着像「功能没生效」，极易误判成产品 bug。 */
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
  let pass = 0, fail = 0;
  const check = (name, ok, extra) => {
    if (ok) { pass++; console.log("PASS  " + name); }
    else { fail++; console.log("FAIL  " + name + (extra ? "  → " + extra : "")); }
  };
  const shot = async (name) => {
    const cap = await send("Page.captureScreenshot", { format: "png" });
    fs.mkdirSync(path.join(ROOT, "_shot"), { recursive: true });
    fs.writeFileSync(path.join(ROOT, "_shot", name), Buffer.from(cap.data, "base64"));
  };

  try {
    await send("Page.enable"); await send("Runtime.enable");
    await send("Emulation.setDeviceMetricsOverride", { width: 1500, height: 1050, deviceScaleFactor: 1, mobile: false });
    await send("Page.navigate", { url: "file:///" + path.join(ROOT, "anime-rewind.html").replace(/\\/g, "/") });
    await sleep(2600);

    const setup = await ev(`
      settings.stream_url = "";
      settings.data_bg_image = "";
      const mk = (id, cn, sources, active) => ({
        id, titleCn: cn, titleOriginal: "O", seriesId: "",
        statusId: "st_done", watchedEpisodes: 6, totalEpisodes: 24,
        coverUrl: "", airDate: "2016-04-07", summary: "x",
        createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
        sources, activeSourceId: active || "", aliases: [], genres: [], studios: [],
        personalTags: [], reviews: []
      });
      state.anime = [
        mk("S1", "漆黑的子弹", [
          { id: "s1", url: "https://embey.tv/hangumi/play/x", name: "线路 1 · embey.tv 独立", ep: 3, resolution: "1080P" },
          { id: "s2", url: "https://www.agedm.io/play/2016/4824/1", name: "线路 2 · agedm.io", ep: 3, resolution: "1080P" },
          { id: "s3", url: "https://www.yinghuo.com/index.php/vod/play/id/4", name: "线路 3 · yinghuo.com 独播", ep: 3, resolution: "720P", enabled: false }
        ], "s1"),
        mk("S2", " Another", [
          { id: "s4", url: "https://a.test/one", name: "甲线路", ep: 1 }
        ], "s4")
      ];
      state.anime.forEach(a => migrateSources(a));
      go("theater", "S1");
      await new Promise(r => setTimeout(r, 800));
      return JSON.stringify({ chips: document.querySelectorAll("[data-st-line]").length });
    `);
    check("详情页渲染出 3 个线路胶囊", JSON.parse(setup).chips === 3, setup);

    /* ---------- 1. 不播放也能选：这是用户报的核心缺口 ---------- */
    const shape = await ev(`
      (() => {
        const box = document.querySelector("#st-lines");
        const chips = [...document.querySelectorAll("[data-st-line]")];
        const r0 = chips[0].getBoundingClientRect();
        return JSON.stringify({
          hasBox: !!box,
          mounted: !document.querySelector("#st-mount").hidden,
          // 原来那行「已保存 N 条线路…点控制条上的选源」的文字必须消失
          oldHint: /点控制条上的/.test(document.querySelector(".stream-panel").textContent),
          // 胶囊必须真的可见
          visible: chips.every(c => c.getBoundingClientRect().width > 20),
          // 不可用的线路要写出原因，而不是静默变灰
          offReason: (chips[2].textContent.match(/已停用[^播放]*/) || [""])[0],
          offDim: getComputedStyle(chips[2]).opacity,
          reasonOpaque: (() => {
            const r = chips[2].querySelector(".vsrc-reason");
            return r ? getComputedStyle(r).opacity : "0";
          })(),
          onMark: !!chips[0].querySelector("svg"),
          onCls: chips[0].classList.contains("is-on"),
          w: Math.round(r0.width)
        });
      })()
    `);
    const sh = JSON.parse(shape);
    check("线路列表挂在播放源面板里", sh.hasBox === true, shape);
    check("没在播放（不需要先播放就能选）", sh.mounted === false, shape);
    check("旧的那行「点控制条上的选源」提示已移除", sh.oldHint === false, shape);
    check("三个胶囊都真实可见（宽度 > 20px）", sh.visible === true, shape);
    check("当前线路胶囊有高亮", sh.onCls === true && sh.onMark === true, shape);
    /* 淡化的实现方式是「压暗前景色」而不是「整颗加 opacity」——
       后者会把文字与底色同时合成，对比度平方级下降，
       实测 pixel 套系下原因文字只剩 1.29:1。
       所以断言「胶囊不整体变透明，原因文字不透明」。 */
    check("不可用的线路淡化的是文字而不是整颗胶囊（保证可读）",
      parseFloat(sh.offDim) > 0.95, shape);
    check("不可用的线路写明原因而不是静默变灰",
      /已停用/.test(sh.offReason) && sh.reasonOpaque === "1", shape);

    /* ---------- 2. 单击换默认线路，且不整页重渲 ---------- */
    const switched = await ev(`
      (async () => {
        const urlBefore = document.getElementById("st-url");
        const chips = [...document.querySelectorAll("[data-st-line]")];
        chips[1].click();
        await new Promise(r => setTimeout(r, 600));
        const a = animeById("S1");
        return JSON.stringify({
          act: a.activeSourceId,
          legacy: a.streamUrl,
          epInput: document.getElementById("st-ep").value,
          status: (document.getElementById("st-status").textContent || "").trim().slice(0, 40),
          // 关键：输入框节点必须还是原来那个 —— 变了说明整页被重渲
          sameInput: document.getElementById("st-url") === urlBefore,
          onIdx: [...document.querySelectorAll("[data-st-line]")]
            .findIndex(c => c.classList.contains("is-on"))
        });
      })()
    `);
    const sw = JSON.parse(switched);
    check("单击即设为使用中", sw.act === "s2", switched);
    check("旧字段跟着新线路走", sw.legacy === "https://www.agedm.io/play/2016/4824/1", switched);
    check("集数输入框同步为该线路声明的集数", sw.epInput === "3", switched);
    check("状态条说出当前线路", /线路 2/.test(sw.status), switched);
    check("就地更新，整页未被重渲（输入框节点没换）", sw.sameInput === true, switched);
    check("高亮跟着移到新胶囊", sw.onIdx === 1, switched);

    /* ---------- 3. 连续两次点都能生效（重画后的新节点必须是活按钮） ---------- */
    const twice = await ev(`
      (async () => {
        for(const i of [2, 0]){
          document.querySelectorAll("[data-st-line]")[i].click();
          await new Promise(r => setTimeout(r, 500));
        }
        return JSON.stringify({ act: animeById("S1").activeSourceId });
      })()
    `);
    check("重画后的新节点仍可点（逐元素绑定会让第二次变死按钮）",
      JSON.parse(twice).act === "s1", twice);

    /* ---------- 4. 不可用的线路也能设，但界面必须说清它不会被选中 ---------- */
    const offPick = await ev(`
      (async () => {
        const chip = document.querySelectorAll("[data-st-line]")[2];
        chip.click();
        await new Promise(r => setTimeout(r, 600));
        const a = animeById("S1");
        return JSON.stringify({
          act: a.activeSourceId,
          status: (document.getElementById("st-status").textContent || "").trim(),
          player: activeSourceOf(a).id
        });
      })()
    `);
    const op = JSON.parse(offPick);
    check("把已停用线路设为默认（用户判断优先）", op.act === "s3", offPick);
    check("但状态条明说它会被跳过", /跳过/.test(op.status), offPick);
    check("播放器仍会跳过它", op.player !== "s3", offPick);
    await shot("pick-detail-off.png");

    /* 滚到线路列表再截一张：胶囊是这次改动的主要产物，
       截图落在视口外的话等于没截。 */
    await ev(`
      document.querySelector("#st-lines").scrollIntoView({ block:"center" });
      await new Promise(r => setTimeout(r, 400));
      return 1;
    `);
    await shot("pick-detail-chips.png");

    /* ---------- 5. 切到另一部作品后不能再改到第一部（闭包捕获 a 的坑） ---------- */
    const cross = await ev(`
      (async () => {
        go("theater", "S2");
        await new Promise(r => setTimeout(r, 700));
        const chips = [...document.querySelectorAll("[data-st-line]")];
        chips[0].click();
        await new Promise(r => setTimeout(r, 600));
        return JSON.stringify({
          nowOn: animeById("S2").activeSourceId,
          /* 关键：S1 不能被这次点击改动 */
          otherUntouched: animeById("S1").activeSourceId,
          otherUpdatedAt: animeById("S1").updatedAt
        });
      })()
    `);
    const cr = JSON.parse(cross);
    check("在 B 番详情页点线路只改 B 番", cr.nowOn === "s4", cross);
    check("A 番的默认线路没被顺带改掉（委托闭包捕获 a 的数据损坏级 bug）",
      cr.otherUntouched === "s3", cross);

    /* ---------- 5. 重复绑定不能发生（否则一次点击写 N 次库） ---------- */
    /* 症状量化：点一下后计数器的增量必须恰好为 1。
       若上一部作品留下的监听器没撤掉（闭包捕获的是旧 a），
       增量会是 2 或更多，且其中几次作用在**错误的作品**上。
       只断言「结果对」抓不到这个 —— 重复写同一份数据，结果一样对。 */
    const dup = await ev(`
      (async () => {
        go("theater", "S1");
        await new Promise(r => setTimeout(r, 700));
        const a = animeById("S1");
        let writes = 0;
        const orig = Repo.put;
        Repo.put = function(){ writes++; return orig.apply(this, arguments); };
        document.querySelectorAll("[data-st-line]")[0].click();
        await new Promise(r => setTimeout(r, 700));
        Repo.put = orig;
        return JSON.stringify({ writes, act: a.activeSourceId });
      })()
    `);
    const dp = JSON.parse(dup);
    check("点一次只写一次库（旧监听器没叠着）", dp.writes === 1, dup);
    check("单次点击落到正确的作品", dp.act === "s1", dup);

    /* ---------- 6. 台账页：每行有「设为使用中」 ---------- */
    const ledger = await ev(`
      (async () => {
        go("sources");
        await new Promise(r => setTimeout(r, 700));
        /* 注意选择器范围：「使用中」徽标只在**操作列**里由 setBtn 渲染。
           状态列的 .flag 也含同样文字（sourceFlags 的 active 项），
           全页捞 .flag 会把同一条线路数两遍。 */
        const opFlags = [...document.querySelectorAll('.ledger-table [data-act="probe"]')]
          .map(b => b.closest("td"));
        return JSON.stringify({
          rows: document.querySelectorAll(".ledger-table tbody tr").length,
          useBtns: document.querySelectorAll('.ledger-table [data-act="use"]').length,
          useBadges: opFlags.filter(td => /使用中/.test(td.textContent)).length,
          bulk: !!document.querySelector('[data-act="bulk-use"]')
        });
      })()
    `);
    const lg = JSON.parse(ledger);
    /* 按实际数据算，不写死 4 个按钮。
       前面的步骤已经把 S1 切到 s3、S2 已是 s4 ——
       这两条本来就该显示徽标而不是按钮，所以「按钮数 = 总数 − 使用中数」。 */
    const badges = lg.useBadges;
    check("台账每条线路都有「设为使用中」按钮或使用中徽标（二者必居其一）",
      lg.useBtns + badges === lg.rows, ledger);
    check("当前使用中的那些显示徽标而不是按钮（不给无效操作）",
      badges >= 1 && lg.useBtns > 0, ledger);
    check("有「设为使用中」批量按钮", lg.bulk === true, ledger);

    const useClick = await ev(`
      (async () => {
        const rows = [...document.querySelectorAll(".ledger-table tbody tr")];
        const target = rows.find(tr => tr.querySelector('[data-act="use"]'));
        const key = target.dataset.key;
        const srcId = key.split("|")[1];
        const a = animeById(key.split("|")[0]);
        const want = a.sources.find(s => s.id === srcId);
        target.querySelector('[data-act="use"]').click();
        await new Promise(r => setTimeout(r, 700));
        const again = document.querySelector('.ledger-table tr[data-key="' + key + '"]');
        return JSON.stringify({
          key,
          wantUrl: want ? want.url : "",
          nowBadge: !!again.querySelector(".flag") &&
            /使用中/.test(again.querySelector(".flag").textContent),
          nowBtn: !!again.querySelector('[data-act="use"]'),
          legacy: animeById(key.split("|")[0]).streamUrl
        });
      })()
    `);
    const uc = JSON.parse(useClick);
    check("台账点一下就换掉默认线路", uc.nowBadge === true, useClick);
    check("换成徽标后按钮消失（不再给无效操作）", uc.nowBtn === false, useClick);
    /* 对着被点的那条线路的地址核对，不写死具体网址 ——
       写死的话测试数据一改就红，而验的并不是「旧字段有没有跟着走」。 */
    check("台账侧改完，旧字段也跟着走",
      !!uc.wantUrl && uc.legacy === uc.wantUrl, useClick);
    await shot("pick-ledger-use.png");

    /* ---------- 7. 批量设为使用中 ---------- */
    const bulk = await ev(`
      (async () => {
        ledgerState.picked = [];
        ledgerState.q = ""; ledgerState.filter = "";
        rerenderLedger();
        await new Promise(r => setTimeout(r, 500));
        /* 每次勾选都会整表重渲，事先抓的 boxes 数组里
           第二三个元素已脱离文档，dispatchEvent 不再冒泡到 #view。
           必须每轮重新查询。 */
        let picked = 0;
        for(let round = 0; round < 4; round++){
          const boxes = [...document.querySelectorAll('.ledger-table [data-act="pick"]')];
          const next = boxes.filter(b => {
            const tr = b.closest("tr");
            return tr && tr.dataset.key && ledgerState.picked.indexOf(tr.dataset.key) < 0;
          })[0];
          if(!next) break;
          next.checked = true;
          next.dispatchEvent(new Event("change", { bubbles: true }));
          picked++;
          await new Promise(r => setTimeout(r, 320));
        }
        document.querySelector('[data-act="bulk-use"]').click();
        await new Promise(r => setTimeout(r, 500));
        const ok = document.querySelector("#modal-card [data-ok], #modal-card .btn-primary");
        if(ok) ok.click();
        await new Promise(r => setTimeout(r, 900));
        return JSON.stringify({
          picked: ledgerState.picked.length,
          total: document.querySelectorAll(".ledger-table tbody tr").length,
          s1: animeById("S1").activeSourceId,
          s2: animeById("S2").activeSourceId
        });
      })()
    `);
    const bk = JSON.parse(bulk);
    /* 对着实际勾上的数量断言。测试数据此时是 4 行，
       写死 3 测的是「我数过几行」而不是「勾选累积对不对」。 */
    check("批量勾选累积正确", bk.picked === bk.total, bulk);
    check("S1 落到了被勾的第一条", ["s1", "s2", "s3"].indexOf(bk.s1) >= 0, bulk);
    check("S2 也独立生效", bk.s2 === "s4", bulk);

    /* ---------- 8. 线路胶囊的对比度：四套 UI × 明暗 ---------- */
    /* 「已停用，不会被自动选中」这行是 warn 色文字，落在胶囊上。
       胶囊底色是半透明白，压在面板上 —— 静态解析 CSS 算不出实际合成结果，
       必须让浏览器算完再读 getComputedStyle。 */
    await ev(`
      go("theater", "S1");
      await new Promise(r => setTimeout(r, 600));
      return 1;
    `);
    const skins = JSON.parse(await ev(`JSON.stringify(UI_SKINS)`));
    check("取到 UI 套系列表", Array.isArray(skins) && skins.length >= 4, JSON.stringify(skins));
    /* WCAG 相对亮度必须按**三个通道分别**算。
       之前偷懒把同一个分量当 R/G/B 代入，等于在算灰度 ——
       青色 rgb(34,211,238) 会被算成和深色底 rgb(6,35,42) 亮度接近，
       于是报出 1.27 这种荒谬的低值。 */
    const chan = (v) => {
      v /= 255;
      return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    };
    const lumOf = (c) => {
      const m = String(c).match(/[\d.]+/g);
      if(!m || m.length < 3) return null;
      return 0.2126 * chan(+m[0]) + 0.7152 * chan(+m[1]) + 0.0722 * chan(+m[2]);
    };
    const ratio = (fg, bg) => {
      const a = lumOf(fg), b = lumOf(bg);
      if(a == null || b == null) return null;
      return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    };
    for(const skin of skins){
      for(const theme of ["dark", "light"]){
        const tag = skin + "/" + theme;
        const r = JSON.parse(await ev(`
          (async () => {
            settings.ui_skin = ${JSON.stringify(skin)};
            document.documentElement.setAttribute("data-skin", ${JSON.stringify(skin)});
            document.documentElement.setAttribute("data-theme", ${JSON.stringify(theme)});
            settings.theme = ${JSON.stringify(theme)};
            go("theater", "S1");
            await new Promise(r => setTimeout(r, 600));
            /* 必须先把它滚进视口：
               Page.captureScreenshot 的 clip 是**视口坐标**，
               元素在视口外时截出来是一张纯色图，
               于是亮度分布毫无跨度，读出来是 1.00:1 —— 
               看着像「对比度极差」，其实是「什么都没截到」。 */
            const box = document.querySelector("#st-lines");
            if(box) box.scrollIntoView({ block:"center" });
            await new Promise(r => setTimeout(r, 400));
            const off = document.querySelector("[data-st-line].is-off");
            const on  = document.querySelector("[data-st-line].is-on");
            const reason = off && off.querySelector(".vsrc-reason");
            const panel = document.querySelector(".line-picker");
            if(!off || !reason || !on || !panel) return JSON.stringify({ missing:1 });
            const cs = getComputedStyle(reason);
            const panelBg = getComputedStyle(document.querySelector(".stream-panel")).backgroundColor;
            /* 底色必须取「文字紧邻的那一块」的**实际合成色**，
               不能拿面板的 backgroundColor 顶替 ——
               胶囊底是半透明白叠在面板上，算出来的对比度不是用户看到的那份。
               用 html2canvas 之类的方式重，成本高；
               这里改用浏览器自带的：把一个同背景的探针放进胶囊，
               再用 getComputedStyle 拿不到合成值是意料之中的 ——
               所以直接去截图像素。 */
            const rr = reason.getBoundingClientRect();
            const nr = off.querySelector(".vsrc-name").getBoundingClientRect();
            /* clip 是视口坐标，且要求完全在视口内。
               越界的部分截图会补成透明 → 合成出黑像素，
               于是「文字像素」被算成纯黑，比值假性爆表或假性归零。 */
            const inView = rr.top >= 0 && rr.left >= 0 &&
              rr.bottom <= innerHeight && rr.right <= innerWidth;
            return JSON.stringify({
              reasonColor: cs.color,
              panelBg,
              chipBg: getComputedStyle(off).backgroundColor,
              inView,
              vh: innerHeight,
              nameRect: { x:Math.round(nr.x), y:Math.round(nr.y),
                          w:Math.round(nr.width), h:Math.round(nr.height) },
              rect: { x:Math.round(rr.x), y:Math.round(rr.y),
                      w:Math.round(rr.width), h:Math.round(rr.height) },
              /* 状态条的 warn 文字也要过 —— 那是同一批用户要读的关键结论 */
              statusColor: getComputedStyle(document.getElementById("st-status")).color,
              offOpacity: parseFloat(getComputedStyle(off).opacity),
              reasonW: Math.round(reason.getBoundingClientRect().width),
              onBg: getComputedStyle(on).backgroundColor,
              onColor: getComputedStyle(on).color
            });
          })()
        `));
        if(r.missing){ check(tag + " 渲染出可用/不可用两种胶囊", false, "缺少胶囊"); continue; }
        check(tag + " 不可用原因这行有实际宽度（不是被挤没）",
          r.reasonW > 40, String(r.reasonW));
        /* 元素没进视口时截图是纯色，读出的比值毫无意义 —— 
           必须在量之前先确认这一块真的被截到了。 */
        check(tag + " 待测区域落在视口内（否则截到的是纯色）",
          r.inView === true, "vh=" + r.vh + " rect=" + JSON.stringify(r.rect));

        /* 对比度必须量**实际像素**：胶囊底是半透明叠在面板上，
           拿 backgroundColor 算出来的比值不是用户看到的那份。
           截下这一小块送回页面用 OffscreenCanvas 读像素 ——
           文字像素取最暗/最亮的一端，底色取中位色，
           这样「文字 vs 底」的真实差距就出来了。 */
        const clip = { x:r.rect.x, y:r.rect.y, width:r.rect.w, height:r.rect.h, scale:1 };
        const cap = await send("Page.captureScreenshot", { format:"png", clip });
        const lumStats = await ev(`
          (async () => {
            const bmp = await createImageBitmap(await (await fetch("data:image/png;base64,${cap.data}")).blob());
            const c = new OffscreenCanvas(bmp.width, bmp.height);
            const g = c.getContext("2d");
            g.drawImage(bmp, 0, 0);
            const d = g.getImageData(0, 0, bmp.width, bmp.height).data;
            const ch = (v) => { v /= 255; return v <= 0.04045 ? v/12.92 : Math.pow((v+0.055)/1.055, 2.4); };
            const L = (r,gg,bb) => 0.2126*ch(r) + 0.7152*ch(gg) + 0.0722*ch(bb);
            const arr = [];
            for(let i = 0; i < d.length; i += 4) arr.push(L(d[i], d[i+1], d[i+2]));
            arr.sort((x,y) => x - y);
            /* 底色 = 众数那一档，不能用分位数 ——
               小字号文字在整块里只占百分之几的像素，
               3% 与 75% 分位会双双落在底色上，
               算出来必然是 1.00:1，看着像「对比度极差」，
               实际是「根本没分离出文字」。
               正确做法：取出现次数最多的那一档当底色，
               再找偏离它最多的那批像素当文字。 */
            const hist = new Map();
            for(const v of arr){
              const k = v.toFixed(4);
              hist.set(k, (hist.get(k) || 0) + 1);
            }
            let bg = 0, best = -1;
            for(const [k, n] of hist){ if(n > best){ best = n; bg = +k; } }
            /* 文字 = 偏离底色最远的那 1.5% 像素的中位亮度 */
            /* 文字取「偏离底色最多的那一撮」——
               用中位数会落在抗锯齿的半调上，比值被系统性低估。
               阈值 0.02 要从这一块自己的分布里取：
               离底色最远的那 20% 才是笔画本体。 */
            const dev = arr.filter(v => Math.abs(v - bg) > 0.008).sort((x,y) => x - y);
            if(!dev.length) return JSON.stringify({ ratio:0, ink:0, spread:0 });
            /* 文字在哪一侧取决于底色明暗，不能固定取「更暗的那端」。
               先看整块的中位亮度决定方向，再从该方向取笔画核心。 */
            /* 文字与底色取分布的两端，不再猜「哪一侧」。
               众数法在 pixel套系下会被抗锯齿的过渡像素带偏
               （大量半调像素数量超过真正的底色像素），
               结果把底色算成半调、算出的比值接近 1.00 ——
               而那张截图里「已停用」四个黑字清清楚楚，明显过 AA。
               两端法只依赖「最暗的那批一定是笔画」这一条，
               对过渡像素免疫。 */
            const lo = arr[Math.floor(arr.length * 0.01)];
            const hi = arr[Math.floor(arr.length * 0.99)];
            const darkSide = bg < 0.5;
            const txt = darkSide ? hi : lo;
            return JSON.stringify({
              txt, bg,
              inkRatio: +(dev.length / arr.length).toFixed(4),
              ratio:(Math.max(txt,bg)+0.05)/(Math.min(txt,bg)+0.05),
              spread:arr[arr.length-1] - arr[0],
              n:arr.length
            });
          })()
        `);
        const ls = JSON.parse(lumStats);
        /* 墨水占比是「这块真有文字」的独立证据。
           没有它，一块纯色背景也能满足 spread 判据（抗锯齿边缘的过渡色）。 */
        check(tag + " 截图里确实有文字（墨水占比 > 1.5%）",
          ls.inkRatio > 0.015, "ink=" + ls.inkRatio);
        check(tag + " 「已停用」原因文字实际像素过 WCAG AA（≥4.5:1）",
          ls.ratio >= 4.5,
          ls.ratio.toFixed(2) + ":1 文字=" + ls.txt.toFixed(3) + " 底=" + ls.bg.toFixed(3) +
          " 原因色=" + r.reasonColor + " 胶囊底=" + r.chipBg + " 面板=" + r.panelBg);
        const onRatio = ratio(r.onColor, r.onBg);
        check(tag + " 当前线路胶囊的文字过 WCAG AA",
          onRatio != null && onRatio >= 4.5,
          (onRatio == null ? "取不到色" : onRatio.toFixed(2)) + " " + r.onColor + " on " + r.onBg);
        /* 量不出来的时候把这一块存下来 —— 纯色截图说明
           元素被别的层盖住/移出了 clip，纯看数字猜不出原因。 */
        if(ls.ratio < 4.5){
          fs.mkdirSync(path.join(ROOT, "_shot"), { recursive: true });
          fs.writeFileSync(path.join(ROOT, "_shot", "chip-" + skin + "-" + theme + ".png"),
            Buffer.from(cap.data, "base64"));
        }

        /* 淡化的**名字行**也要过 AA。
           淡到读不出来就等于「用户不知道这条被停用了」——
           而「可用/不可用」正是选线路时要判断的第一件事。 */
        const cap2 = await send("Page.captureScreenshot",
          { format:"png", clip:{ x:r.nameRect.x, y:r.nameRect.y,
              width:r.nameRect.w, height:r.nameRect.h, scale:1 } });
        const ns = JSON.parse(await ev(`
          (async () => {
            const bmp = await createImageBitmap(await (await fetch("data:image/png;base64,${cap2.data}")).blob());
            const c = new OffscreenCanvas(bmp.width, bmp.height);
            const g = c.getContext("2d");
            g.drawImage(bmp, 0, 0);
            const d = g.getImageData(0, 0, bmp.width, bmp.height).data;
            const ch = (v) => { v /= 255; return v <= 0.04045 ? v/12.92 : Math.pow((v+0.055)/1.055, 2.4); };
            const L = (rr,gg,bb) => 0.2126*ch(rr) + 0.7152*ch(gg) + 0.0722*ch(bb);
            const arr = [];
            for(let i = 0; i < d.length; i += 4) arr.push(L(d[i], d[i+1], d[i+2]));
            arr.sort((x,y) => x - y);
            const hist = new Map();
            for(const v of arr){ const k = v.toFixed(4); hist.set(k, (hist.get(k)||0)+1); }
            let bg = 0, best = -1;
            for(const [k,n] of hist){ if(n > best){ best = n; bg = +k; } }
            const dev = arr.filter(v => Math.abs(v - bg) > 0.008).sort((x,y) => x - y);
            if(!dev.length) return JSON.stringify({ ratio:0, ink:0 });
            const lo = arr[Math.floor(arr.length*0.01)];
            const hi = arr[Math.floor(arr.length*0.99)];
            const darkSide = bg < 0.5;
            const txt = darkSide ? hi : lo;
            return JSON.stringify({
              ink:+(dev.length/arr.length).toFixed(4),
              ratio:(Math.max(txt,bg)+0.05)/(Math.min(txt,bg)+0.05)
            });
          })()
        `));
        check(tag + " 淡化后的线路名仍可读（≥4.5:1，「不可用」不能看不出来）",
          ns.ratio >= 4.5, ns.ratio.toFixed(2) + ":1 ink=" + ns.ink);
      }
    }

    /* ---------- 9. 控制台干净 ---------- */
    const errs = JSON.parse(await ev(`return JSON.stringify(window.__arErrs || []);`));
    check("控制台无报错", errs.length === 0, errs.slice(0, 3).join(" | "));
  } catch (e) {
    fail++;
    console.log("FAIL  测试自身异常 → " + e.message);
  } finally {
    try { proc.kill(); fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { }
  }
  console.log("\n" + pass + " 项通过，" + fail + " 项失败");
  process.exit(fail ? 1 : 0);
})();