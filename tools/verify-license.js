/* 版权与许可声明的浏览器验证
 *
 * 重点是三件 jsdom 测不出来的事：
 *  1. 「关于」页的许可块排版是否真的成立（details/summary 在面板里嵌面板）
 *  2. 三套主题下许可文字的对比度是否达标（法律声明读不清等于没写）
 *  3. 单文件被单独转发时，署名信息是否还看得见（不依赖仓库）
 */
const { spawn } = require("child_process");
const fs = require("fs"), path = require("path"), os = require("os");

const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const PORT = 9622;
const HTML = path.join(__dirname, "..", "anime-rewind.html");
const SHOT = path.join(__dirname, "_shot");
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function run(){
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "ar-lic-"));
  const proc = spawn(EDGE, ["--headless=new", "--disable-gpu", "--no-sandbox",
    "--remote-debugging-port=" + PORT, "--user-data-dir=" + profile, "about:blank"], { stdio: "ignore" });
  let ws = null, out = { errors: [] };
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
    const send = (m, p) => new Promise((res, rej) => {
      const i = ++id;
      const timer = setTimeout(() => { pending.delete(i); rej(new Error("CDP 超时: " + m)); }, 15000);
      pending.set(i, { res: v => { clearTimeout(timer); res(v); }, rej: e => { clearTimeout(timer); rej(e); } });
      ws.send(JSON.stringify({ id: i, method: m, params: p || {} }));
    });
    await new Promise(r => ws.onopen = r);
    ws.onmessage = e => {
      const m = JSON.parse(e.data);
      if (m.id && pending.has(m.id)){
        const { res, rej } = pending.get(m.id); pending.delete(m.id);
        m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
      }
      if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error")
        out.errors.push(m.params.args.map(a => a.value || a.description || "").join(" "));
      if (m.method === "Runtime.exceptionThrown")
        out.errors.push("EXC " + (m.params.exceptionDetails.text || ""));
    };
    const ev = async x => {
      const r = await send("Runtime.evaluate", { expression: x, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails){
        const msg = r.exceptionDetails.exception?.description || r.exceptionDetails.text;
        /* 页面里报错必须让脚本失败，不能把 "ERR:..." 当结果返回。
           否则选择器写错这类问题会伪装成「检查通过」——
           实测就踩过：meta[name=dcterms.rights] 少了引号抛 SyntaxError，
           输出一片看起来正常。 */
        out.errors.push("EVAL " + String(msg).split("\n")[0]);
        return null;
      }
      return r.result.value;
    };
    const shot = async n => {
      const r = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
      fs.writeFileSync(path.join(SHOT, n), Buffer.from(r.data, "base64"));
    };

    await send("Page.enable");
    await send("Runtime.enable");
    /* --window-size 在 headless=new 下会被忽略，视口只有 500x450，
       许可块会被挤到视口外导致测出的对比度与溢出判断全是假的。 */
    await send("Emulation.setDeviceMetricsOverride", { width: 1500, height: 1200, deviceScaleFactor: 1, mobile: false });
    await send("Page.navigate", { url: "file:///" + HTML.replace(/\\/g, "/") });
    await sleep(2500);

    // ---- meta 声明（机器可读，是转发后唯一还在的东西）----
    /* 属性选择器里的值必须带引号：dcterms.rights 含点号，
       `meta[name=dcterms.rights]` 会被解析成「name 为 dcterms 且有 rights 类」，
       直接抛 SyntaxError —— 这类错会让整段检查静默失效（拿到 ERR 字符串而不报警）。 */
    out.meta = await ev(`JSON.stringify({
      author: document.querySelector('meta[name="author"]')?.content || null,
      copyright: document.querySelector('meta[name="copyright"]')?.content || null,
      license: document.querySelector('meta[name="license"]')?.content || null,
      rights: document.querySelector('meta[name="dcterms.rights"]')?.content || null
    })`);

    // ---- 关于页 ----
    await ev("settingsState.tab = 'about'; go('settings')");
    await sleep(900);
    out.about = await ev(`(() => {
      const box = document.querySelector('#view');
      const panel = Array.from(box.querySelectorAll('.panel-head h4'))
        .find(h => /版权与许可/.test(h.textContent));
      if (!panel) return JSON.stringify({ found: false });
      const p = panel.closest('.panel');
      const r = p.getBoundingClientRect();
      const links = Array.from(p.querySelectorAll('a')).map(a => ({
        href: a.getAttribute('href'), rel: a.rel, target: a.target
      }));
      return JSON.stringify({
        found: true,
        text: p.textContent.replace(/\\s+/g, ' ').trim().slice(0, 400),
        w: Math.round(r.width), h: Math.round(r.height),
        detailsOpen: !!p.querySelector('details'),
        summary: (p.querySelector('summary')?.textContent || '').trim(),
        links
      });
    })()`);

    // 展开 details 后测排版：嵌套面板 + 折叠块容易挤爆
    await ev("document.querySelector('#view details').open = true");
    await sleep(500);
    out.detailsOpen = await ev(`(() => {
      const d = document.querySelector('#view details');
      const r = d.getBoundingClientRect();
      const box = document.querySelector('#view');
      return JSON.stringify({
        h: Math.round(r.height),
        overflowX: box.scrollWidth > box.clientWidth ? 1 : 0,
        overflowPage: document.documentElement.scrollWidth > window.innerWidth ? 1 : 0
      });
    })()`);
    await shot("1-关于-许可块.png");

    // ---- 三主题对比度：法律声明读不清等于没写 ----
    await ev("document.querySelector('#view details').open = false");
    const themes = ["dark", "light", "glass"];
    out.contrast = {};
    for (const t of themes){
      await ev(`document.documentElement.setAttribute('data-theme', '${t}')`);
      await sleep(320);
      out.contrast[t] = await ev(`(() => {
        const p = Array.from(document.querySelectorAll('#view .panel-head h4'))
          .find(h => /版权与许可/.test(h.textContent));
        if (!p) return null;
        const panel = p.closest('.panel');
        const lum = c => {
          const m = c.match(/[\\d.]+/g).map(Number);
          const f = m.slice(0,3).map(v => { v /= 255; return v <= 0.03928 ? v/12.92 : Math.pow((v+0.055)/1.055, 2.4); });
          return 0.2126*f[0] + 0.7152*f[1] + 0.0722*f[2];
        };
        const ratio = (a,b) => { const L1 = lum(a), L2 = lum(b);
          return ((Math.max(L1,L2)+0.05)/(Math.min(L1,L2)+0.05)); };
        const bgOf = el => { let n = el;
          while (n && n !== document.documentElement){
            const bg = getComputedStyle(n).backgroundColor;
            if (bg && !/rgba\\(0, 0, 0, 0\\)|transparent/.test(bg)) return bg;
            n = n.parentElement;
          }
          return getComputedStyle(document.body).backgroundColor; };
        // 采样三类文字：正文、小字说明、details 折叠标题
        const cells = Array.from(panel.querySelectorAll('div.small'))
          .filter(d => d.textContent.trim().length > 4).slice(0, 4);
        return JSON.stringify(cells.map(d => {
          const cs = getComputedStyle(d);
          return { fg: cs.color, bg: bgOf(d), size: cs.fontSize,
                   ratio: +ratio(cs.color, bgOf(d)).toFixed(2) };
        }));
      })()`);
    }
    await ev("document.documentElement.setAttribute('data-theme','dark')");

    // ---- 结论：把关键项判成通过/不通过，而不是只dump 数据 ----
    const meta = out.meta ? JSON.parse(out.meta) : {};
    const about = out.about ? JSON.parse(out.about) : {};
    const det = out.detailsOpen ? JSON.parse(out.detailsOpen) : {};
    const checks = [
      ["meta 声明齐全（author/copyright/license/rights）",
        !!(meta.author && meta.copyright && meta.license && meta.rights)],
      ["署名人为 ll9-m", meta.author === "ll9-m"],
      ["许可标识为 CC BY-NC 4.0", meta.license === "CC BY-NC 4.0"],
      ["关于页渲染出许可块", about.found === true],
      ["关于页含不可商用声明", /不可用于任何商业用途/.test(about.text || "")],
      ["关于页含第三方素材声明", /第三方素材/.test(about.text || "")],
      ["所有外链带 rel=noopener noreferrer",
        Array.isArray(about.links) && about.links.length > 0
        && about.links.every(l => /noopener/.test(l.rel) && /noreferrer/.test(l.rel))],
      ["展开 details 后无横向溢出", det.overflowX === 0 && det.overflowPage === 0],
      ["页面无脚本报错", out.errors.length === 0]
    ];
    Object.entries(out.contrast).forEach(([th, raw]) => {
      if (!raw) return checks.push([`${th} 主题对比度可测`, false]);
      const arr = JSON.parse(raw);
      const min = Math.min.apply(null, arr.map(a => a.ratio));
      checks.push([`${th} 主题许可文字对比度 ≥ 4.5:1（实测最低 ${min}）`, min >= 4.5]);
    });

    out.checks = checks;
    out.verdict = { pass: checks.filter(c => c[1]).length, total: checks.length };
    console.log(JSON.stringify(out, null, 1));
    if (out.verdict.pass < out.verdict.total || out.errors.length){
      console.log("\n--- 未通过 ---");
      checks.filter(c => !c[1]).forEach(c => console.log("  FAIL " + c[0]));
      process.exitCode = 1;
    }
  } finally {
    if (ws) try{ ws.close(); }catch(e){}
    try{ proc.kill(); }catch(e){}
    await sleep(300);
    try{ fs.rmSync(profile, { recursive: true, force: true }); }catch(e){}
  }
}
run().then(() => process.exit(0)).catch(e => { console.error("验证脚本异常:", e); process.exit(1); });
