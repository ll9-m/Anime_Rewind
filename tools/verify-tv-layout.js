/* 真实浏览器验证：TV 套系的侧栏折叠与卡片翻面。
 *
 * 这两件事 jsdom 测不了 —— 它不做布局，所有 getBoundingClientRect 返回 0，
 * 也不渲染 3D。所以「图标被推出左缘」「翻面后两个面同时不可见」这类
 * 问题在单测里永远是绿的，只能上真浏览器量像素。
 *
 * 量什么（都是「截图能看出来但很难量化」的东西）：
 *  1. 收起态侧栏：图标是否完整落在 48px 内、有没有被裁掉一半
 *  2. 收起态侧栏：有没有元素横向溢出容器（scrollWidth > clientWidth）
 *  3. 展开态：hover 后 flex-basis 是否真的放开（这是 flex-basis
 *     覆盖 width 的坑，只改 width 的话永远不会展开）
 *  4. 翻面：翻转后背面是否真的有内容（背面的 rotateY 被 scale 覆盖
 *     时，正面和背面会同时被 backface-visibility:hidden 干掉）
 *  5. 翻面：截图像素统计 —— 不能只看 DOM 在不在，3D 不可见时
 *     DOM 完好但画面空白
 *
 * 已知环境坑（沿用 verify-flip.js 的结论，别再踩）：
 *   --window-size 在 headless=new 下被忽略，必须用
 *   Emulation.setDeviceMetricsOverride 显式覆盖视口。
 *   CDP 无法模拟 hover 媒体特性，但可以真发鼠标移动事件，
 *   所以 :hover 用 Input.dispatchMouseEvent 触发。
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

/* 解 PNG 取像素统计：数「非背景色」像素占比。
   3D 不可见的表现是「DOM 在但画面空白」——只看 DOM 永远发现不了，
   必须看画面上到底有没有像素。 */
function pngStats(buf){
  /* 只解析 IHDR + IDAT 需要的调色板无关信息：
     用 sharp 之类太重，这里手写最小 PNG 解码（8bit RGBA/RGB，
     带 filter 反向）。 */
  let p = 8, w = 0, h = 0, bitDepth = 0, colorType = 0;
  const idat = [];
  while(p < buf.length){
    const len = buf.readUInt32BE(p);
    const type = buf.toString("ascii", p + 4, p + 8);
    const data = buf.slice(p + 8, p + 8 + len);
    if(type === "IHDR"){
      w = data.readUInt32BE(0); h = data.readUInt32BE(4);
      bitDepth = data[8]; colorType = data[9];
    }else if(type === "IDAT"){
      idat.push(data);
    }else if(type === "IEND") break;
    p += 12 + len;
  }
  if(bitDepth !== 8) return { w, h, decoded: false, reason: "bitDepth=" + bitDepth };
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 0 ? 1 : 0;
  if(!channels) return { w, h, decoded: false, reason: "colorType=" + colorType };
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * channels;
  const out = Buffer.alloc(h * stride);
  let prev = Buffer.alloc(stride);
  let ri = 0;
  for(let y = 0; y < h; y++){
    const filter = raw[ri++];
    const line = raw.slice(ri, ri + stride); ri += stride;
    const cur = Buffer.alloc(stride);
    for(let x = 0; x < stride; x++){
      const a = x >= channels ? cur[x - channels] : 0;
      const b = prev[x];
      const c = x >= channels ? prev[x - channels] : 0;
      let v = line[x];
      if(filter === 1) v += a;
      else if(filter === 2) v += b;
      else if(filter === 3) v += (a + b) >> 1;
      else if(filter === 4){
        const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      }
      cur[x] = v & 0xff;
    }
    cur.copy(out, y * stride);
    prev = cur;
  }
  return { w, h, channels, data: out, decoded: true };
}

/* 数「明显亮于底色」的像素占比。
   阈值必须由调用方从实际底色亮度推出：写死一个绝对值，
   换主题/换皮肤就会假红或假绿 —— 这类统计口径错我踩过一次
   （把 var(--panel) 的 52 亮度当内容阈值，收起态侧栏恒为 ink=1）。 */
function inkRatio(img, x0, y0, x1, y1, threshold){
  if(!img.decoded) return null;
  const { w, h, channels, data } = img;
  const th = threshold == null ? 46 : threshold;
  let ink = 0, total = 0;
  for(let y = y0; y < y1; y++){
    for(let x = x0; x < x1; x++){
      const i = (y * w + x) * channels;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      if(0.2126 * r + 0.7152 * g + 0.0722 * b > th) ink++;
      total++;
    }
  }
  return total ? +(ink / total).toFixed(4) : 0;
}

async function main(){
  if(!fs.existsSync(EDGE)) throw new Error("找不到 Edge: " + EDGE);
  fs.mkdirSync(OUT, { recursive: true });
  const PORT = 9540;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "ar-tv-"));
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
      const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
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
    const mouseTo = async (x, y) => {
      await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: Math.round(x), y: Math.round(y) });
      await sleep(500);
    };

    await send("Page.enable");
    await send("Runtime.enable");
    await send("Emulation.setDeviceMetricsOverride", {
      width: 1500, height: 1000, deviceScaleFactor: 1, mobile: false
    });
    await send("Page.navigate", {
      url: "file:///" + path.join(ROOT, "anime-rewind.html").replace(/\\/g, "/")
    });
    await sleep(2800);

    /* 灌入测试数据：切到 TV 套系 + 有几部作品 */
    await ev(`
      (async () => {
        const mk = (id, cn, ep, tot) => ({
          id, titleCn: cn, titleOriginal: "Original " + id, seriesId: "",
          statusId: "st_want", watchedEpisodes: ep, totalEpisodes: tot,
          coverUrl: "", airDate: "2016-04-07", summary: "简介测试",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          sources: [], activeSourceId: "", aliases: [], genres: ["奇幻"],
          studios: ["A-1 Pictures"], personalTags: [], reviews: [], series: []
        });
        state.anime = [mk("v1","七人魔法使",3,24), mk("v2","葬送的芙莉莲",5,13),
                       mk("v3","孤独摇滚",0,12), mk("v4","进击的巨人",10,25)];
        settings.ui_skin = "tv";
        settings.theme = "dark";
        applyAppearance();
        libState.view = "wall";
        go("library");
        return 1;
      })()
    `);
    await sleep(900);

    /* ---------- 1. 收起态侧栏：图标必须完整落在容器内 ---------- */
    const rail = await ev(`
      (() => {
        const sb = document.getElementById("sidebar");
        const r = sb.getBoundingClientRect();
        const marks = [...sb.querySelectorAll(".nav-item svg")].map(n => {
          const b = n.getBoundingClientRect();
          return { l: Math.round(b.left), r: Math.round(b.right), w: Math.round(b.width) };
        });
        const brandMark = sb.querySelector(".brand-mark").getBoundingClientRect();
        return JSON.stringify({
          rail: [Math.round(r.left), Math.round(r.right), Math.round(r.width)],
          overflowX: sb.scrollWidth - sb.clientWidth,
          marks, brandMark: [Math.round(brandMark.left), Math.round(brandMark.right)],
          navW: Math.round(sb.querySelector(".nav-item").getBoundingClientRect().width)
        });
      })()
    `);
    const railObj = JSON.parse(rail);
    check("收起态侧栏宽度是 48px", railObj.rail[2] === 48, railObj.rail[2] + "px");
    check("收起态侧栏无横向溢出（内容没被裁）",
      railObj.overflowX <= 1, "scrollWidth-clientWidth=" + railObj.overflowX);
    check("收起态每个导航图标都完整落在 48px 内",
      railObj.marks.every(m => m.l >= railObj.rail[0] && m.r <= railObj.rail[0] + 48 && m.w > 0),
      JSON.stringify(railObj.marks.slice(0, 2)));
    check("收起态品牌图标未被推出左缘",
      railObj.brandMark[0] >= railObj.rail[0] - 1 && railObj.brandMark[1] <= railObj.rail[0] + 48,
      JSON.stringify(railObj.brandMark));
    check("收起态导航项是 32px 方块", railObj.navW === 32, railObj.navW + "px");

    /* 收起态截图 + 像素统计：侧栏区域应该只有图标，不该有被拦腰截断的文字。
       注意取样口径：侧栏面板底色 var(--panel) 在 dark 主题下亮度约 52，
       阈值 46 会把整块底色算成「有内容」——这属于统计口径错，
       不是产品问题。要比的是「底色之上多出了多少笔画」，
       所以阈值必须明显高于底色亮度，取 70。
       截断文字是多层笔画叠在渐变上，亮度远高于底色；图标同理。 */
    const bufCollapsed = await shot("tv-rail-collapsed.png");
    const imgCollapsed = pngStats(bufCollapsed);
    check("截图可解码（否则后面的像素统计是空跑）",
      imgCollapsed.decoded, imgCollapsed.reason);
    /* 先量侧栏面板本身的底色亮度，阈值从它上面推 ——
       写死一个绝对阈值，换个主题就会假红或假绿。 */
    const panelLum = (() => {
      if(!imgCollapsed.decoded) return null;
      const { w, h, channels, data } = imgCollapsed;
      const i = (500 * w + 30) * channels;   /* 侧栏中部空白处 */
      return Math.round(0.2126 * data[i] + 0.7152 * data[i+1] + 0.0722 * data[i+2]);
    })();
    check("能取到侧栏底色亮度（否则下面的阈值无从谈起）",
      panelLum !== null && panelLum >= 0, panelLum);
    const railInk = inkRatio(imgCollapsed, 4, 8, 44, 992, panelLum + 18);
    check("收起态侧栏只有图标（没有溢出文字）",
      railInk !== null && railInk < 0.30,
      "ink=" + railInk + " 底色亮度=" + panelLum);

    /* ---------- 2. 展开态：hover 真的放开了 ---------- */
    await mouseTo(24, 300);
    /* 过渡完成再量：宽度动画 --dur，中途量到的是中间值。
       上一轮就是在这里截了张动画中间态的图，
       差点把「遮罩把文字洗成残影」当成布局问题。 */
    await sleep(1200);
    const open = JSON.parse(await ev(`
      (() => {
        const sb = document.getElementById("sidebar");
        const r = sb.getBoundingClientRect();
        const nav = sb.querySelector(".nav-item").getBoundingClientRect();
        const bt = sb.querySelector(".brand-text");
        return JSON.stringify({
          w: Math.round(r.width),
          navW: Math.round(nav.width),
          brandText: bt ? getComputedStyle(bt).display : null,
          overflowX: sb.scrollWidth - sb.clientWidth
        });
      })()
    `));
    /* 底部信息行：标签与数值必须分居两侧。
       .side-stat 是 display:flex + justify-content:space-between，
       收起态整块 display:none，展开态用 display:revert 恢复。
       revert 回滚到「作者样式」——而基础 .side-stat 没给子元素设display，
       于是 span/b 落到 UA 默认的 inline。inline 子元素在 flex 容器里
       会被包成匿名 flex item，space-between 失效、两者挤在左边。
       表现为「只看得见『收录总数』，数值 0 不见了」。
       只看 display 值不够：得确认数值真的落在行的右侧。 */
    const stat = JSON.parse(await ev(`
      (() => {
        const sb = document.getElementById("sidebar");
        const st = sb.querySelector(".side-stat");
        const sp = st.querySelector("span").getBoundingClientRect();
        const b  = st.querySelector("b").getBoundingClientRect();
        const line = st.getBoundingClientRect();
        return JSON.stringify({
          statDisplay: getComputedStyle(st).display,
          bText: st.querySelector("b").textContent,
          labelRight: Math.round(sp.right), valLeft: Math.round(b.left),
          lineL: Math.round(line.left), lineR: Math.round(line.right),
          gap: Math.round(b.left - sp.right)
        });
      })()
    `));
    check("展开态 .side-stat 恢复成 flex 容器",
      stat.statDisplay === "flex", stat.statDisplay);
    check("展开态底部数值有内容（不是空标签）",
      stat.bText && stat.bText.length > 0, "b.textContent=" + JSON.stringify(stat.bText));
    check("展开态底部数值落在行的右端（space-between 生效）",
      stat.gap > 8 && stat.valLeft > (stat.lineL + stat.lineR) / 2,
      "gap=" + stat.gap + " valLeft=" + stat.valLeft + " 行=[" + stat.lineL + "," + stat.lineR + "]");

    /* 荣誉块是同一类问题的另一个容器：收起态居中成图标方块，
       展开态要放回 padding 并让文字行恢复。 */
    const honor = JSON.parse(await ev(`
      (() => {
        const h = document.querySelector(".side-honor");
        const sp = h.querySelector("span");
        const r = h.getBoundingClientRect();
        return JSON.stringify({
          justify: getComputedStyle(h).justifyContent,
          padL: getComputedStyle(h).paddingLeft,
          spanDisplay: getComputedStyle(sp).display,
          spanText: sp.querySelector("b").textContent,
          w: Math.round(r.width)
        });
      })()
    `));
    check("展开态荣誉块恢复左对齐（收起态是 center）",
      honor.justify === "flex-start", honor.justify);
    check("展开态荣誉块恢复内边距（不是收起态的 0）",
      parseFloat(honor.padL) > 4, "padding-left=" + honor.padL);
    check("展开态荣誉块称号文字重新参与布局",
      honor.spanDisplay !== "none" && honor.spanText.length > 0,
      honor.spanDisplay + " / " + JSON.stringify(honor.spanText));
    check("hover 后侧栏展开到 216px（flex-basis 也要放开）",
      open.w === 216, open.w + "px");
    check("展开后导航项回到全宽（不是 32px 方块里塞文字）",
      open.navW > 180, open.navW + "px");
    check("展开后品牌文字重新参与布局",
      open.brandText && open.brandText !== "none", open.brandText);
    check("展开后侧栏仍无横向溢出",
      open.overflowX <= 1, "overflow=" + open.overflowX);
    /* 羽化遮罩已整块删除（原先的 ::after 作为最后一个子元素 z 序在内容之上，
       展开动画期间那层渐变会把自己的文字洗成残影）。
       这里改成反向断言：别再加回来。 */
    const scrim = JSON.parse(await ev(`
      (() => {
        const sb = document.getElementById("sidebar");
        const cs = getComputedStyle(sb, "::after");
        return JSON.stringify({
          content: cs.content,
          bg: cs.backgroundImage || "none"
        });
      })()
    `));
    check("侧栏没有 ::after 遮罩层（会盖住自己的文字）",
      scrim.content === "none" || scrim.content === "normal", scrim.content);
    check("侧栏 ::after 没有渐变背景",
      scrim.bg === "none", scrim.bg);

    /* 展开态文字必须真的画出来了。上一轮遮罩盖在内容之上时，
       这里截到的是「文字只剩残影」，而所有几何断言都通过 ——
       几何对不等于看得见。所以要量展开态侧栏里的文字笔画。 */
    const bufOpen = await shot("tv-rail-expanded.png");
    const imgOpen = pngStats(bufOpen);
    /* 展开态取名/类型一段（那里有密集文字），阈值沿用底色+18 */
    const openInk = inkRatio(imgOpen, 20, 60, 190, 200, panelLum + 18);
    check("展开态侧栏文字可见（笔画确实画出来了）",
      openInk !== null && openInk > 0.02, "ink=" + openInk + " 底色=" + panelLum);

    /* ---------- 3. 卡片翻面：背面必须真的可见 ---------- */
    /* 移开鼠标让卡片回到正面态 */
    await mouseTo(1400, 900);
    await sleep(500);
    const cardRect = JSON.parse(await ev(`
      (() => { const c = document.querySelector(".card");
        const r = c.getBoundingClientRect();
        return JSON.stringify([Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)]); })()
    `));
    const frontShot = await shot("tv-card-front.png");
    const frontImg = pngStats(frontShot);
    /* 正面 ink 的判据不能是「比底色亮多少」：测试数据没有封面Url，
       正面是 coverImg 的深色占位层 + 半透明字幕块，整体本来就是暗的，
       用绝对阈值去卡它会假红。
       有意义的判据是相对值 —— 翻面后画面应当明显比翻面前「有东西」：
       背面有资料行和亮色按钮，笔画密度必然高于正面。
       这也正是这次 bug 的形态（翻面后两面被 backface 干掉 → 画面变空），
       相对判据对它敏感。 */
    const frontInk = inkRatio(frontImg, cardRect[0] + 6, cardRect[1] + 6,
      cardRect[0] + cardRect[2] - 6, cardRect[1] + cardRect[3] - 6, 70);
    check("能测到正面卡区（否则下面的对比是空跑）",
      frontInk !== null, frontInk);

    /* hover 卡片 → 翻面 */
    await mouseTo(cardRect[0] + cardRect[2] / 2, cardRect[1] + cardRect[3] / 2);
    await sleep(900);
    const backShot = await shot("tv-card-back.png");
    const backImg = pngStats(backShot);
    const backInk = inkRatio(backImg, cardRect[0] + 6, cardRect[1] + 6,
      cardRect[0] + cardRect[2] - 6, cardRect[1] + cardRect[3] - 6, 70);
    const backTf = await ev(`
      (() => { const c = document.querySelector(".card");
        return getComputedStyle(c.querySelector(".fc-back")).transform; })()
    `);
    check("翻面后背面保留了 rotateY(180deg)",
      /matrix3d|matrix/.test(backTf) && backTf !== "none", backTf);
    /* 核心断言：背面的 rotateY 被 scale 覆盖时，正反两面同时被
       backface-visibility:hidden 干掉 ——画面变空，而 DOM 里两个面都还在、
       样式检查全过。必须看画面像素，只看 DOM 会漏。 */
    check("翻面后画面非空（两面没同时被 backface 干掉）",
      backInk !== null && backInk > 0.10, "ink=" + backInk);
    check("翻面后画面明显比正面「有东西」（背面有资料行与亮色按钮）",
      frontInk !== null && backInk !== null && backInk > frontInk * 2,
      "front=" + frontInk + " back=" + backInk);

    check("控制台无报错", errors.length === 0, errors.slice(0, 2).join(" | "));
  } finally {
    try{ proc.kill(); }catch(e){}
    try{ fs.rmSync(profile, { recursive:true, force:true }); }catch(e){}
  }

  console.log("\n" + (fail === 0 ? "全部通过 " : "") + pass + " 项通过" + (fail ? "，" + fail + " 项失败" : ""));
  if(fail){ console.log("失败项：\n - " + fails.join("\n - ")); process.exit(1); }
}

main().catch(e => { console.error("验证自身异常：", e); process.exit(2); });
