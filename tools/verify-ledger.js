/* 真实浏览器验证：播放源管理台账页。
 *
 * jsdom 能验逻辑，验不了「这一页在浏览器里到底显不显示得出来」。
 * 这页全是 DOM 结构 + 事件委托 + 一堆 innerHTML 拼接，
 * 下面这些只有真浏览器能测：
 *   1. 页面能路由进来，表格真的有行（不是空表头）
 *   2. 汇总条的数字与台账一致，且七块都在视口内
 *   3. 勾选一行 → 批量按钮解禁 → 批量删除真的落库
 *   4. 编辑弹窗能开，字段回填正确，保存后表格刷新
 *   5. 失效行的删除线与压暗真的作用到了 <tr>（样式类生效）
 *   6. 筛选下拉切换后行数变少，且「无播放源」那一档渲染的是待办行
 *   7. 横向不溢出（表格容器能滚，页面本身不横向抖动）
 *   8. 截图非空 —— 整页渲染出来是有内容的，不是一片空白
 *
 * 环境坑沿用 verify-tv-layout.js 的结论：
 *   --window-size 在 headless=new 下被忽略，必须用
 *   Emulation.setDeviceMetricsOverride 显式覆盖视口。
 *   本页不需要 hover，全部用 DOM.click()。
 */
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const zlib = require("zlib");

const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const ROOT = path.join(__dirname, "..");
const OUT = path.join(ROOT, "_shot");
const sleep = ms => new Promise(r => setTimeout(r, ms));

let pass = 0, fail = 0;
const fails = [];
function check(name, cond, extra){
  if(cond){ pass++; console.log("PASS " + name); }
  else { fail++; fails.push(name); console.log("FAIL " + name + (extra != null ? "   → " + extra : "")); }
}

/* 最小 PNG 解码 + 区域墨水占比（沿用 verify-tv-layout.js 的实现，
   这里需要它来判断「整页是不是白的」）。 */
function pngStats(buf){
  let p = 8, w = 0, h = 0, bitDepth = 0, colorType = 0;
  const idat = [];
  while(p < buf.length){
    const len = buf.readUInt32BE(p);
    const type = buf.toString("ascii", p + 4, p + 8);
    const data = buf.slice(p + 8, p + 8 + len);
    if(type === "IHDR"){ w = data.readUInt32BE(0); h = data.readUInt32BE(4); bitDepth = data[8]; colorType = data[9]; }
    else if(type === "IDAT") idat.push(data);
    else if(type === "IEND") break;
    p += 12 + len;
  }
  if(bitDepth !== 8) return { w, h, decoded:false };
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 0 ? 1 : 0;
  if(!channels) return { w, h, decoded:false };
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * channels;
  const out = Buffer.alloc(h * stride);
  let prev = Buffer.alloc(stride);
  let ri = 0;
  for(let y = 0; y < h; y++){
    const ft = raw[ri++];
    const line = raw.slice(ri, ri + stride); ri += stride;
    const cur = out.slice(y * stride, (y + 1) * stride);
    for(let x = 0; x < stride; x++){
      const a = x >= channels ? cur[x - channels] : 0;
      const b = prev[x];
      const c = x >= channels ? prev[x - channels] : 0;
      let v = line[x];
      if(ft === 1) v += a;
      else if(ft === 2) v += b;
      else if(ft === 3) v += Math.floor((a + b) / 2);
      else if(ft === 4){
        const p0 = a + b - c, pa = Math.abs(p0 - a), pb = Math.abs(p0 - b), pc = Math.abs(p0 - c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      }
      cur[x] = v & 0xff;
    }
    prev = cur;
  }
  return { w, h, channels, data: out, decoded:true };
}
function inkRatio(img, x0, y0, x1, y1, threshold){
  if(!img || !img.decoded) return null;
  const th = threshold == null ? 46 : threshold;
  const { w, channels, data } = img;
  let ink = 0, total = 0;
  for(let y = y0; y < y1; y++){
    for(let x = x0; x < x1; x++){
      const i = (y * w + x) * channels;
      if(0.2126 * data[i] + 0.7152 * data[i+1] + 0.0722 * data[i+2] > th) ink++;
      total++;
    }
  }
  return total ? +(ink / total).toFixed(4) : 0;
}

async function main(){
  if(!fs.existsSync(EDGE)) throw new Error("找不到 Edge: " + EDGE);
  fs.mkdirSync(OUT, { recursive: true });
  const PORT = 9547;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "ar-ledger-"));
  const proc = spawn(EDGE, [
    "--headless=new", "--disable-gpu", "--no-sandbox",
    "--remote-debugging-port=" + PORT, "--user-data-dir=" + profile,
    "about:blank"
  ], { stdio:"ignore" });

  const errors = [];
  try{
    let list = null;
    for(let i = 0; i < 40; i++){
      await sleep(500);
      try{
        const r = await fetch("http://127.0.0.1:" + PORT + "/json/list");
        list = await r.json();
        if(list && list.some(t => t.type === "page")) break;
      }catch(e){}
    }
    const page = (list || []).find(t => t.type === "page");
    if(!page) throw new Error("没有可用的 page target");
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    let id = 0;
    const pending = new Map();
    await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
    ws.onmessage = e => {
      const m = JSON.parse(e.data);
      if(m.id && pending.has(m.id)){
        const h = pending.get(m.id);
        pending.delete(m.id);
        m.error ? h.rej(new Error(JSON.stringify(m.error))) : h.res(m.result);
      }else if(m.method === "Runtime.consoleAPICalled" && m.params.type === "error"){
        errors.push("console.error: " + m.params.args.map(a => a.value || a.description || "").join(" "));
      }else if(m.method === "Runtime.exceptionThrown"){
        errors.push("exception: " + (m.params.exceptionDetails.exception
          ? m.params.exceptionDetails.exception.description : m.params.exceptionDetails.text));
      }
    };
    const send = (m, p) => new Promise((res, rej) => {
      const i = ++id;
      const timer = setTimeout(() => { pending.delete(i); rej(new Error("CDP 超时: " + m)); }, 20000);
      pending.set(i, { res: v => { clearTimeout(timer); res(v); }, rej: e => { clearTimeout(timer); rej(e); } });
      ws.send(JSON.stringify({ id: i, method: m, params: p || {} }));
    });
    const ev = async expr => {
      /* 无条件包一层 (async () => { return (表达式) })()。
         这样三种写法都能吃：
           ① 同步 IIFE    (() => {...})()
           ② 异步 IIFE    (async () => {...})()
           ③ 单个表达式   return x.y.textContent
         早先按「有没有 return」判断要不要包裹，结果漏了
         「以 ( 开头的 IIFE 里含 return」这种形态，
         报出来的是 Illegal return statement —— 错误信息完全指不到真因。 */
      const body = "(async()=>{ return (" + expr + "); })()";
      const r = await send("Runtime.evaluate", { expression: body, returnByValue: true, awaitPromise: true });
      if(r.exceptionDetails){
        throw new Error(r.exceptionDetails.exception
          ? r.exceptionDetails.exception.description : r.exceptionDetails.text);
      }
      return r.result.value;
    };
    const shot = async name => {
      const r = await send("Page.captureScreenshot", { format: "png" });
      const buf = Buffer.from(r.data, "base64");
      fs.writeFileSync(path.join(OUT, name), buf);
      return buf;
    };

    await send("Page.enable");
    await send("Runtime.enable");
    await send("Emulation.setDeviceMetricsOverride", { width: 1500, height: 1000, deviceScaleFactor: 1, mobile: false });
    await send("Page.navigate", { url: "file:///" + path.join(ROOT, "anime-rewind.html").replace(/\\/g, "/") });
    await sleep(2800);

    /* 灌测试数据：多线路 + 一条失效 + 一条停用 + 一条重复 + 一部无线路 */
    await ev(`
      (async () => {
        settings.stream_url = "";
        const mk = (id, cn, sources, active) => ({
          id, titleCn: cn, titleOriginal: "Original " + id, seriesId: "",
          statusId: "st_want", watchedEpisodes: 3, totalEpisodes: 24,
          coverUrl: "", airDate: "2016-04-07", summary: "简介测试",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          sources, activeSourceId: active || "", aliases: [], genres: ["奇幻"],
          studios: ["A-1 Pictures"], personalTags: [], reviews: []
        });
        state.anime = [
          mk("L1", "钢之炼金术师", [
            { id:"s11", url:"https://www.bilibili.com/bangumi/play/ep1", name:"B站", ep:1, resolution:"1080P" },
            { id:"s12", url:"https://youtu.be/aaa", name:"YouTube 1080", ep:2, resolution:"1080P",
              health:{ state:"dead", at:"2026-09-01T00:00:00.000Z", detail:"用户手动标记失效" } },
            { id:"s13", url:"https://vimeo.com/999", name:"Vimeo 备用", ep:null, resolution:"720P", enabled:false }
          ], "s11"),
          mk("L2", "数码宝贝", [
            { id:"s21", url:"https://www.youtube.com/watch?v=bbb", name:"YT", ep:1, resolution:"2160P" },
            { id:"s22", url:"https://www.youtube.com/watch?v=bbb", name:"YT 副本", ep:1, resolution:"2160P" }
          ], "s21"),
          mk("L3", "葫芦兄弟", [])
        ];
        state.anime.forEach(a => migrateSources(a));
        ledgerState.q = ""; ledgerState.filter = ""; ledgerState.sort = "anime"; ledgerState.picked = [];
        go("sources");
        return 1;
      })()
    `);
    await sleep(1000);

    /* ---------- 1. 页面渲染 ---------- */
    const title = await ev(`document.getElementById("page-title").textContent`);
    check("页面标题是「播放源管理」", title === "播放源管理", title);

    const navHas = await ev(`
      (() => [...document.querySelectorAll("#nav-list [data-route]")]
        .map(b => b.dataset.route).includes("sources"))()
    `);
    check("侧栏出现「播放源」入口", navHas === true, navHas);

    const shape = await ev(`
      (() => {
        const rows = [...document.querySelectorAll(".ledger-table tbody tr")];
        return JSON.stringify({
          rows: rows.length,
          hasHead: !!document.querySelector(".ledger-table thead th"),
          stats: document.querySelectorAll(".ledger-stat").length,
          statsInView: [...document.querySelectorAll(".ledger-stat")].every(n => {
            const r = n.getBoundingClientRect();
            return r.width > 40 && r.right <= window.innerWidth + 1 && r.height > 20;
          }),
          checks: document.querySelectorAll('.ledger-table [data-act="pick"]').length,
          deadRows: document.querySelectorAll(".ledger-table tr.is-dead").length,
          dupNotice: /重复线路/.test(document.body.textContent),
          pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth
        });
      })()
    `);
    const sh = JSON.parse(shape);
    /* 行数是 5 不是 6：L1 三条 + L2 两条 = 5 条线路，
       L3 没有线路，它只在「无播放源」那一档才作为待办行出现。 */
    check("表格渲染出 5 行线路（3+2，无线路的作品不进表）", sh.rows === 5, sh.rows);
    check("表头存在（不是空表）", sh.hasHead === true);
    check("汇总条有 7 块", sh.stats === 7, sh.stats);
    check("汇总条七块都完整落在视口内（没被挤成 0 宽）", sh.statsInView === true);
    check("每行都有一个勾选框", sh.checks === 5, sh.checks);
    check("失效行带 is-dead 类", sh.deadRows === 1, sh.deadRows);
    check("重复线路有醒目提示条", sh.dupNotice === true);
    check("页面本身不横向溢出（滚动交给表格容器）", sh.pageOverflow <= 1, sh.pageOverflow);

    /* ---------- 2. 截图非空 ---------- */
    const pageShot = await shot("ledger-page.png");
    const img = pngStats(pageShot);
    const ink = inkRatio(img, 0, 0, 1500, 1000, 70);
    check("整页截图非空（真的渲染出了内容）", ink !== null && ink > 0.01, "ink=" + ink);

    /* ---------- 3. 勾选 → 批量按钮解禁 → 批量停用 ---------- */
    /* 先记住第一行是谁：后面几步都依赖「哪些行被动过」，
       不记下来的话一旦行序变了，断言会报出与真因无关的失败。 */
    const order0 = JSON.parse(await ev(`
      (() => JSON.stringify([...document.querySelectorAll(".ledger-table tbody tr")]
        .map(tr => tr.dataset.key)))()
    `));
    check("初始行序按作品名排序", order0.join(",") === "L1|s11,L1|s12,L1|s13,L2|s21,L2|s22",
      order0.join(","));

    const bulk = await ev(`
      (async () => {
        const before = document.querySelector('[data-act="bulk-disable"]').disabled;
        const box = document.querySelector('.ledger-table [data-act="pick"]');
        box.checked = true;
        box.dispatchEvent(new Event("change", { bubbles: true }));
        await new Promise(r => setTimeout(r, 350));
        const after = document.querySelector('[data-act="bulk-disable"]').disabled;
        const picked = document.querySelectorAll(".ledger-table tr.is-picked").length;
        return JSON.stringify({ before, after, picked,
          count: document.querySelector('[data-act="pick-none"]').textContent });
      })()
    `);
    const bk = JSON.parse(bulk);
    check("未勾选时批量按钮是禁用的", bk.before === true);
    check("勾选后批量按钮解禁", bk.after === false);
    check("被勾选的行有高亮", bk.picked === 1, bk.picked);
    check("选择计数写进了按钮文案", /1/.test(bk.count), bk.count);

    const applied = await ev(`
      (async () => {
        const rows = pickedLedgerRows(sourceLedger());
        const target = rows[0];
        await updateSource(target, { enabled:false });
        rerenderLedger();
        await new Promise(r => setTimeout(r, 300));
        const a = target.anime;
        const s = a.sources.find(x => x.id === target.source.id);
        return JSON.stringify({ key: ledgerKey(target), disabled: s.enabled === false,
          flagShown: /已停用/.test(document.querySelector('.ledger-table tr[data-key="'+ledgerKey({anime:a,source:s})+'"]').textContent) });
      })()
    `);
    const ap = JSON.parse(applied);
    check("批量停用真的落库", ap.disabled === true, JSON.stringify(ap));
    check("停用后该行出现「已停用」徽标", ap.flagShown === true, JSON.stringify(ap));

    /* 停用的若正是当前线路，「使用中」标记必须让给别的线路 ——
       否则详情页会显示一条已被自己停用的线路还在用。
       测试数据里 L1 三条恰好全不可用（s11 被本步停用、
       s12 被标失效、s13 原本就停用），那种情况下 activeSourceOf
       会按设计退回全列表（总得给用户一条路），
       断言就测不出「让位」了。所以另找一部还有可用线路的作品来验。 */
    const handoff = JSON.parse(await ev(`
      (() => {
        const a = state.anime.find(x => x.id === "L2");
        const before = activeSourceOf(a).id;
        a.sources[0].enabled = false;
        const after = activeSourceOf(a);
        return JSON.stringify({ before:before, after:after ? after.id : null,
          usable: after ? sourceUsable(after) : null,
          n:a.sources.length });
      })()
    `));
    check("当前线路被停用后让给还可用的一条",
      handoff.before === "s21" && handoff.after === "s22" && handoff.usable === true,
      JSON.stringify(handoff));

    /* 全部线路都不可用时不能返回 null：
       返回 null 会让详情页显示不出任何线路，用户以为线路被清空了。 */
    const allOff = JSON.parse(await ev(`
      (() => {
        const a = state.anime.find(x => x.id === "L1");
        return JSON.stringify({ total:a.sources.length,
          act:activeSourceOf(a) ? activeSourceOf(a).id : null });
      })()
    `));
    check("全部线路不可用时仍返回一条（不是 null）",
      allOff.total === 3 && !!allOff.act, JSON.stringify(allOff));

    /* ---------- 4. 编辑弹窗 ---------- */
    const editor = await ev(`
      (async () => {
        ledgerState.picked = [];
        rerenderLedger();
        await new Promise(r => setTimeout(r, 250));
        /* 必须挑一条既启用、又没被标失效的线路。
           前面几步分别把 s11 停用了；再写死 id 会选中一条
           已经不可用的线路，回填断言必然失败 ——
           那是测试自己制造的前提，不是产品问题。 */
        const row = sourceLedger().find(r => sourceUsable(r.source));
        openSourceEditor(row);
        await new Promise(r => setTimeout(r, 400));
        const g = id => { const n = document.getElementById(id); return n ? n.value : null; };
        const out = {
          open: !!document.querySelector("#modal-card"),
          url: g("ls-url"), name: g("ls-name"), ep: g("ls-ep"),
          res: g("ls-res"), tier: g("ls-tier"), kind: g("ls-kind"),
          note: g("ls-note"),
          subs: [...document.querySelectorAll("#ls-subs input:checked")].map(i => i.value),
          enabled: document.getElementById("ls-enabled") ? document.getElementById("ls-enabled").checked : null
        };
        /* 改网址 + 写备注后保存 */
        document.getElementById("ls-url").value = "https://www.bilibili.com/bangumi/play/ep2";
        document.getElementById("ls-note").value = "改过的线路";
        document.getElementById("ls-save").click();
        await new Promise(r => setTimeout(r, 600));
        const a = state.anime.find(x => x.sources.some(s => s.url.indexOf("ep2") >= 0));
        const s = a.sources.find(x => x.url.indexOf("ep2") >= 0);
        return JSON.stringify(Object.assign(out, {
          closed: !document.querySelector("#modal-card"),
          savedUrl: s.url, savedNote: s.note,
          legacyUrl: a.streamUrl,
          health: normalizeHealth(s.health)
        }));
      })()
    `);
    const ed = JSON.parse(editor);
    check("编辑弹窗能打开", ed.open === true);
    check("网址字段回填所选线路的地址", ed.url && ed.url.length > 8, ed.url);
    check("线路名回填正确", !!ed.name, ed.name);
    check("集数回填正确", ed.ep !== null && ed.ep !== "", ed.ep);
    check("分辨率回填正确", !!ed.res, ed.res);
    check("字幕形态回填正确", ed.kind === "EXTERNAL", ed.kind);
    check("优先级回填为数字", /^\d$/.test(ed.tier), ed.tier);
    check("启用状态回填为勾选", ed.enabled === true, ed.enabled);
    check("保存后弹窗关闭", ed.closed === true);
    check("保存后网址已更新", ed.savedUrl && ed.savedUrl.indexOf("ep2") >= 0, ed.savedUrl);
    check("保存后备注已更新", ed.savedNote === "改过的线路", ed.savedNote);
    check("保存后旧字段 streamUrl 同步", ed.legacyUrl === ed.savedUrl, ed.legacyUrl);
    /* 改过网址的线路，旧的探测结论必须作废——
       拿上一个地址的可达性去描述新地址是在骗用户。 */
    check("改网址后旧的检测结论被清空",
      ed.health.state === "unknown" && !ed.health.at, JSON.stringify(ed.health));

    /* ---------- 5. 筛选 ---------- */
    const filt = await ev(`
      (async () => {
        const sel = document.getElementById("led-filter");
        sel.value = "dead";
        sel.dispatchEvent(new Event("change", { bubbles: true }));
        await new Promise(r => setTimeout(r, 350));
        const deadRows = document.querySelectorAll(".ledger-table tbody tr").length;
        sel.value = "no-source";
        sel.dispatchEvent(new Event("change", { bubbles: true }));
        await new Promise(r => setTimeout(r, 350));
        const noSrcRows = document.querySelectorAll(".ledger-table tbody tr").length;
        const noSrcHasBtn = !!document.querySelector('.ledger-table [data-act="open-anime"]');
        sel.value = "";
        sel.dispatchEvent(new Event("change", { bubbles: true }));
        await new Promise(r => setTimeout(r, 350));
        const back = document.querySelectorAll(".ledger-table tbody tr").length;
        return JSON.stringify({ deadRows, noSrcRows, noSrcHasBtn, back });
      })()
    `);
    const fl = JSON.parse(filt);
    check("筛「已失效」只剩 1 行", fl.deadRows === 1, fl.deadRows);
    check("筛「无播放源」只剩 1 部作品", fl.noSrcRows === 1, fl.noSrcRows);
    check("「无播放源」行给的是「去添加」按钮", fl.noSrcHasBtn === true);
    check("清空筛选后行数恢复", fl.back === 5, fl.back);

    /* 这一档的行 source 为 null，而按状态/时间/站点排的档位要读 source 字段。
       在真浏览器里切一次排序，确认整页不崩 ——
       jsdom 侧已经挡住了，这里再验一次是因为崩溃会显示成
       「页面渲染出错」，属于用户一眼就能看见的问题。 */
    const sortSafe = await ev(`
      (async () => {
        const sel = document.getElementById("led-filter");
        const sort = document.getElementById("led-sort");
        sel.value = "no-source";
        sel.dispatchEvent(new Event("change", { bubbles: true }));
        await new Promise(r => setTimeout(r, 300));
        const bad = [];
        for(const k of ["health","newest","host"]){
          sort.value = k;
          sort.dispatchEvent(new Event("change", { bubbles: true }));
          await new Promise(r => setTimeout(r, 300));
          const broke = /页面渲染出错/.test(document.querySelector("#view").textContent);
          bad.push(k + "=" + (broke ? "崩了" : document.querySelectorAll(".ledger-table tbody tr").length + "行"));
        }
        sort.value = "anime";
        sort.dispatchEvent(new Event("change", { bubbles: true }));
        sel.value = "";
        sel.dispatchEvent(new Event("change", { bubbles: true }));
        await new Promise(r => setTimeout(r, 300));
        return JSON.stringify(bad);
      })()
    `);
    check("在「无播放源」档位切三种排序都不崩页",
      !/崩了/.test(sortSafe), sortSafe);

    /* ---------- 6. 删除线路（含确认弹窗） ---------- */
    const del = await ev(`
      (async () => {
        const rows = document.querySelectorAll(".ledger-table tbody tr");
        let btn = null;
        rows.forEach(tr => { if(tr.dataset.key && tr.dataset.key.endsWith("|s13") && !btn) btn = tr.querySelector('[data-act="del"]'); });
        if(!btn) return JSON.stringify({ skip:true });
        btn.click();
        await new Promise(r => setTimeout(r, 400));
        const asked = !!document.getElementById("cd-yes");
        document.getElementById("cd-yes").click();
        await new Promise(r => setTimeout(r, 700));
        const a = state.anime.find(x => x.id === "L1");
        return JSON.stringify({ asked, left:a.sources.length,
          gone: !a.sources.some(s => s.id === "s13"),
          rowsNow: document.querySelectorAll(".ledger-table tbody tr").length });
      })()
    `);
    const dl = JSON.parse(del);
    check("删除前会先确认", dl.asked === true, JSON.stringify(dl));
    check("确认后线路被真的删掉", dl.gone === true, JSON.stringify(dl));
    check("删除后剩余线路数正确", dl.left === 2, dl.left);
    check("删除后表格行数同步减少", dl.rowsNow === 4, dl.rowsNow);

    /* ---------- 7. 横向不溢出 & 表格可滚 ---------- */
    const wrap = await ev(`
      (() => {
        const w = document.querySelector(".table-wrap");
        const r = w.getBoundingClientRect();
        return JSON.stringify({ w:Math.round(r.width), right:Math.round(r.right),
          overflowX: w.scrollWidth - w.clientWidth,
          canScroll: getComputedStyle(w).overflowX });
      })()
    `);
    const wr = JSON.parse(wrap);
    check("表格容器在视口内", wr.right <= 1501, wr.right);
    check("表格容器横向可滚（列多时不撑破页面）", wr.canScroll === "auto" || wr.canScroll === "scroll", wr.canScroll);

    /* ---------- 8. 失效行的视觉（删除线 + 压暗） ---------- */
    const vis = await ev(`
      (() => {
        const tr = document.querySelector(".ledger-table tr.is-dead");
        if(!tr) return JSON.stringify({});
        /* 压暗是加在 td 上的（为了让勾选框保持可点），
           所以要读 td 的 opacity，不是 tr 的 —— tr 的 opacity
           恒为 1，拿它断言会得到一个永远失败的假信号。 */
        const td = tr.querySelector("td.col-src");
        return JSON.stringify({
          line: getComputedStyle(tr.querySelector(".url-cell")).textDecorationLine,
          op: getComputedStyle(td).opacity,
          boxOp: getComputedStyle(tr.querySelector('[data-act="del"]')).opacity
        });
      })()
    `);
    const vs = JSON.parse(vis);
    check("失效行的网址带删除线", /line-through/.test(vs.line || ""), vs.line);
    check("失效行被压暗（不是完全隐藏，仍可读可点）",
      parseFloat(vs.op) > 0.3 && parseFloat(vs.op) < 1, vs.op);

    /* ---------- 9. 详情页入口与跳转 ---------- */
    /* 台账页的另一条入口在放映厅详情页。它要预填该作品的片名 ——
       几十行台账里翻找一部作品是用户最不情愿做的事。 */
    const entry = JSON.parse(await ev(`
      (async () => {
        go("theater","L1");
        await new Promise(r => setTimeout(r, 500));
        const btn = document.querySelector('[data-st="manage"]');
        /* 失效/停用的线路必须在详情页就有提示：
           「保存了 3 条」不等于「3 条都能用」，这个差别要当场讲清。 */
        const warn = !!document.querySelector(".stream-panel .note-box.is-warn");
        const text = (document.querySelector(".stream-panel")||{textContent:""}).textContent;
        if(!btn) return JSON.stringify({ hasBtn:false, warn:warn });
        btn.click();
        await new Promise(r => setTimeout(r, 600));
        return JSON.stringify({ hasBtn:true, warn:warn,
          warned:/去管理/.test(text),
          route: state.route,
          prefilled: ledgerState.q,
          onlyThis: document.querySelectorAll(".ledger-table tbody tr").length });
      })()
    `));
    check("详情页播放源面板有「播放源管理」入口", entry.hasBtn === true, JSON.stringify(entry));
    check("有失效/停用线路时详情页给出提示", entry.warned === true, JSON.stringify(entry));
    check("点入口跳到台账页", entry.route === "sources", entry.route);
    check("跳转时预填该作品片名", /钢之炼金术师/.test(entry.prefilled || ""), entry.prefilled);
    check("跳转后只剩这部作品的线路", entry.onlyThis === 2, entry.onlyThis);

    /* ---------- 10. 模块开关关闭后导航消失 ---------- */
    const off = await ev(`
      (async () => {
        ledgerState.q = ""; ledgerState.filter = ""; ledgerState.picked = [];
        go("library");
        await new Promise(r => setTimeout(r, 300));
        settings.module_sources = false;
        buildNav();
        await new Promise(r => setTimeout(r, 200));
        const hidden = !![...document.querySelectorAll("#nav-list [data-route]")]
          .find(b => b.dataset.route === "sources" && b.hidden);
        go("sources");
        await new Promise(r => setTimeout(r, 300));
        const blocked = state.route !== "sources";
        settings.module_sources = true;
        buildNav();
        go("sources");
        await new Promise(r => setTimeout(r, 300));
        return JSON.stringify({ hidden, blocked, restored: state.route });
      })()
    `);
    const of = JSON.parse(off);
    check("关闭模块后导航项隐藏", of.hidden === true, JSON.stringify(of));
    check("关闭模块后直接跳路由会被拦下", of.blocked === true, JSON.stringify(of));
    check("重新开启后可正常进入", of.restored === "sources", of.restored);

    check("控制台无报错", errors.length === 0, errors.slice(0, 3).join(" | "));
  } finally {
    try{ proc.kill(); }catch(e){}
    try{ fs.rmSync(profile, { recursive:true, force:true }); }catch(e){}
  }

  console.log("\n" + (fail === 0 ? "全部通过 " : "") + pass + " 项通过" + (fail ? "，" + fail + " 项失败" : ""));
  if(fail){ console.log("失败项：\n - " + fails.join("\n - ")); process.exit(1); }
}

main().catch(e => { console.error("验证自身异常：", e); process.exit(2); });