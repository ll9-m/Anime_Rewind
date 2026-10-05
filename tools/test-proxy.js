/* CORS 代理相关测试。
 *
 * 背景：用户反馈「数据源里的 CORS 代理地址有没有国内的，不开梯子就无法用」。
 * 实测 15 个公共代理在国内 0 个可用（见 tools/probe-cors-agents.js），
 * 所以产品侧不能继续把「填个代理地址」当成万能解法 —— 至少要能自检。
 *
 * 重点防四类回归：
 *  1. 不解包 → 用 allorigins /get 这类会包一层 { contents } 的代理时，
 *     res.json() 拿到壳对象，下游读 data.data 全是 undefined，
 *     表现成「搜索到 0 条」。用户会以为是自己关键词的问题。
 *  2. 乱解包 → 把代理的错误页（HTML 字符串）也解析成「空结果」，
 *     于是代理故障被伪装成「没搜到」，这是最难查的一类假象。
 *  3. 自检只看「有没有响应」→ 缺 CORS 头的代理在 curl 里完全正常，
 *     页面上照样被浏览器拦。必须单独查 ACAO。
 *  4. AniList 写死不代理 → 用户填了代理，AniList 被墙时依然用不上。 */
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const html = fs.readFileSync(path.join(__dirname, "..", "anime-rewind.html"), "utf8");
let pass = 0, fail = 0;
const fails = [];
function check(name, cond, extra){
  if(cond){ pass++; console.log("PASS " + name); }
  else { fail++; fails.push(name); console.log("FAIL " + name + (extra != null ? "   → " + extra : "")); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const dom = new JSDOM(html, { runScripts:"dangerously", url:"https://local.test/", pretendToBeVisual:true });
  const win = dom.window;
  await sleep(1100);
  const ev = async expr => {
    const raw = await win.eval("(async()=>{" + expr + "})()");
    if(raw === undefined) throw new Error("表达式未返回结果（需显式 return）：" + expr.slice(0, 80));
    return typeof raw === "string" ? JSON.parse(raw) : raw;
  };

  /* ---------- 1. 解包：allorigins /get 这类壳 ---------- */
  const unwrap = (await ev(`
    const t = s => unwrapProxyPayload(s);
    return JSON.stringify({
      // 标准壳：contents 里是 JSON 字符串
      shell: t({ contents: JSON.stringify({ data:{ Page:{ media:[{id:1}] } } }) }),
      // 目标本身就是裸 JSON：不能动
      bare: t({ data:{ Page:{ media:[{id:2}] } } }),
      // 目标自己有一个字符串字段叫 contents（合法业务数据）：不能误拆
      realContents: t({ contents:"这是一段正文", data:{ x:1 } }),
      // 壳里是 HTML 错误页：原样返回，让下游报错而不是显示「0 条」
      htmlShell: t({ contents:"<!DOCTYPE html><html>502</html>" }),
      // 壳里是错误对象：原样返回
      errShell: t({ contents: JSON.stringify({ error:"rate limited" }) }),
      // 非对象 / null / 数组：原样
      nul: t(null), str: t("x"), arr: t([1,2])
    });
  `));
  /* 断言不许抛异常。
     写成 unwrap.shell.data.Page.media[0].id 的链式取值，一旦解包逻辑被破坏
     就变成「Cannot read properties of undefined」——整份测试在第一条停住，
     后面 29 条全部没跑，破坏被「抓住」了但看不出是哪条，
     而且其他用例的通过/失败完全未知。
     改成先取再判：破坏时得到明确的 false +实际值。 */
  const firstId = (o) => {
    try{
      const arr = o && o.data && o.data.Page && o.data.Page.media;
      return arr && arr[0] ? arr[0].id : null;
    }catch(e){ return null; }
  };
  check("解包标准壳并取到内层数据", firstId(unwrap.shell) === 1,
    "第一项 id=" + firstId(unwrap.shell) + " 实际=" + JSON.stringify(unwrap.shell).slice(0, 80));
  check("裸 JSON 原样返回（不误解包）", firstId(unwrap.bare) === 2,
    "第一项 id=" + firstId(unwrap.bare) + " 实际=" + JSON.stringify(unwrap.bare).slice(0, 80));
  check("目标自带 contents 字段时不误拆",
    unwrap.realContents && unwrap.realContents.contents === "这是一段正文"
      && unwrap.realContents.data && unwrap.realContents.data.x === 1,
    JSON.stringify(unwrap.realContents).slice(0, 80));
  check("壳里是 HTML 错误页时原样返回（不伪装成空结果）",
    typeof unwrap.htmlShell.contents === "string"
      && unwrap.htmlShell.contents.indexOf("<html>") >= 0,
    JSON.stringify(unwrap.htmlShell).slice(0, 80));
  /* 上一条只看「contents 还在」会被绕过：把解包逻辑换成「无脑返回
     { data:{ media:[] } }」时，contents 确实还在（因为它整个替换了返回体，
     不，替换后 contents 也会没）——实测该破坏会让本条的 contents 变成 undefined，
     所以上一条能挂。但另一种破坏「解包时忽略内容是否为 JSON，
     直接造一个空壳」不会让 contents 消失。
     显式断言：HTML 壳解包后绝不能变成「看起来像成功但没有数据」的对象。 */
  check("HTML 壳解包后不会被伪造成「成功但无数据」",
    unwrap.htmlShell && unwrap.htmlShell.data === undefined,
    "解包结果里出现了 data 字段：" + JSON.stringify(unwrap.htmlShell).slice(0, 80));
  check("壳里是 error 对象时原样返回",
    unwrap.errShell && unwrap.errShell.contents && unwrap.errShell.contents.indexOf("rate") >= 0,
    JSON.stringify(unwrap.errShell).slice(0, 80));
  check("null / 字符串 / 数组都原样返回",
    unwrap.nul === null && unwrap.str === "x" && Array.isArray(unwrap.arr),
    JSON.stringify([unwrap.nul, unwrap.str, unwrap.arr]));

  /* 关键：没有 contents 字段的响应，代理前后必须完全一致。
     解包是「有壳才拆」，不是「无脑 JSON.parse 一次」。 */
  const noShell = (await ev(`
    const before = { data:{ Page:{ media:[{id:7}] } } };
    const after = unwrapProxyPayload(before);
    return JSON.stringify({ same: JSON.stringify(before) === JSON.stringify(after) });
  `));
  check("无壳响应解包前后字节级一致", noShell.same === true, JSON.stringify(noShell));

  /* ---------- 2. fetchJSON 接了代理解包 ---------- */
  /* 用一个假代理验证 fetchJSON 真的走了 unwrapProxyPayload。
     只测 unwrapProxyPayload 本身不够：万一它写对了但没接进 fetchJSON，
     单元测试照样全绿，而用户填了代理照样搜到 0 条。 */
  const wired = (await ev(`
    let lastUrl = null;
    /* 替换全局 fetch：直连抛网络错误（模拟被墙），代理返回一个壳。
       用 window 而不是外层的 win —— 表达式是在页面里求值的，
       拿不到 Node 作用域的变量（写成 win 会 ReferenceError）。 */
    const realFetch = window.fetch;
    window.fetch = async (url, opts) => {
      lastUrl = String(url);
      if(String(url).indexOf("proxy.example") < 0){
        const e = new Error("Failed to fetch"); e.name = "TypeError"; throw e;
      }
      const text = JSON.stringify({ contents: JSON.stringify({ data:[{id:5}] }) });
      /* 鸭子类型，理由同上：jsdom 没有 Response 构造器。 */
      return { status:200, ok:true,
               headers:{ get:(k) => (/^content-type$/i.test(k) ? "application/json" : null) },
               json: async () => JSON.parse(text) };
    };
    const saved = settings.data_proxy_url;
    settings.data_proxy_url = "https://proxy.example/?url=";
    let got = null, failed = null;
    try{
      got = await fetchJSON("https://api.bgm.tv/v0/search/subjects", { method:"POST" }, true);
    }catch(e){ failed = e.message; }
    settings.data_proxy_url = saved;
    window.fetch = realFetch;
    return JSON.stringify({ got, failed, lastUrl });
  `));
  /* 同样不许抛异常：链式取值在破坏时会把整份测试截断在这里。 */
  let wiredFirstId = null;
  try{
    const arr = wired.got && wired.got.data;
    wiredFirstId = (arr && arr[0]) ? arr[0].id : null;
  }catch(e){ wiredFirstId = null; }
  check("fetchJSON 经代理后拿到的是解包后的数据", wiredFirstId === 5,
    "第一项 id=" + wiredFirstId + " 实际=" + JSON.stringify(wired.got).slice(0, 90));
  check("代理失败时的错误信息不误导（不装作「没搜到」）",
    wired.failed == null || !/0 条|无结果/.test(wired.failed), wired.failed);

  /* ---------- 3. 自检：缺 CORS 头必须判为不可用 ---------- */
  /* 先在页面里备份真实 fetch。每个场景替换一次、跑完统一还原 ——
     漏还原的话后面所有发请求的用例都会拿到假响应，
     表现为一片与被测逻辑无关的 FAIL（jsdom 单例状态污染）。 */
  await ev(`
    window.__realFetch = window.fetch;
    return JSON.stringify(1);
  `);
  const diag = (await ev(`
    /* jsdom 没实现 Response 构造器（typeof Response === "undefined"），
       用 new Response(...) 做 mock 会在每个场景里抛 ReferenceError，
       表现为「全部判成网络层失败」—— 那是在测环境而不是测产品。
       自己拼一个只含被用到那三个成员的鸭子类型：
       status / headers.get() / json()。 */
    const mk = (status, acao, body) => {
      const text = body || "{}";
      const headers = { get:(k) => (/^access-control-allow-origin$/i.test(k) && acao) ? "*" : null };
      return { status, headers, ok: status >= 200 && status < 300, json: async () => JSON.parse(text) };
    };
    const out = {};
    /* 场景A：2xx/4xx + 有 CORS 头 → 可用（探测目标拒绝 GET，4xx 也算转发成功） */
    window.fetch = async () => mk(404, true);
    let r = await diagnoseProxy("https://p.example/?url=");
    out.okWithCors = { ok:r.ok, stage:r.stage, status:r.status, cors:r.cors };
    /* 场景 B：2xx + 无 CORS 头 → 不可用，且 stage 精确指出是 CORS 头那层。
       这是最容易漏的一层：curl 看着完全正常，页面上照样失败。 */
    window.fetch = async () => mk(200, false);
    r = await diagnoseProxy("https://p.example/?url=");
    out.noCors = { ok:r.ok, stage:r.stage, cors:r.cors };
    /* 场景 C：401 → 要 Key */
    window.fetch = async () => mk(401, true);
    r = await diagnoseProxy("https://p.example/?url=");
    out.unauth = { ok:r.ok, stage:r.stage };
    /* 场景 D：429 → 限流 */
    window.fetch = async () => mk(429, true);
    r = await diagnoseProxy("https://p.example/?url=");
    out.rate = { ok:r.ok, stage:r.stage };
    /* 场景 E：网络超时 */
    window.fetch = async () => { const e = new Error("t"); e.name = "AbortError"; throw e; };
    r = await diagnoseProxy("https://p.example/?url=");
    out.timeout = { ok:r.ok, stage:r.stage };
    /* 场景 F：地址格式错误（不是合法 URL）—— 不发请求就该判失败 */
    r = await diagnoseProxy("随便写点什么");
    out.badUrl = { ok:r.ok, stage:r.stage };
    /* 场景 G：5xx 是代理自己出错，不能算可用 */
    window.fetch = async () => mk(502, true);
    r = await diagnoseProxy("https://p.example/?url=");
    out.serverErr = { ok:r.ok, stage:r.stage };    window.fetch = window.__realFetch;
    return JSON.stringify(out);
  `));

  check("2xx/4xx + 有 CORS 头 → 判为可用（转发成功即算通）",
    diag.okWithCors.ok === true && diag.okWithCors.cors === true, JSON.stringify(diag.okWithCors));
  check("探测目标返回 4xx 也算转发成功（它本就不接受 GET）",
    diag.okWithCors.status === 404, diag.okWithCors.status);
  check("有响应但无 CORS 头 → 判为不可用",
    diag.noCors.ok === false, JSON.stringify(diag.noCors));
  check("无 CORS 头时 stage 精确指出是CORS 头这层",
    diag.noCors.stage === "CORS 头", diag.noCors.stage);
  check("401 → 报「需要授权」而不是笼统的失败",
    diag.unauth.ok === false && diag.unauth.stage === "需要授权", JSON.stringify(diag.unauth));
  check("429 → 报「被限流」",
    diag.rate.ok === false && diag.rate.stage === "被限流", JSON.stringify(diag.rate));
  check("超时 → 报「网络」层",
    diag.timeout.ok === false && diag.timeout.stage === "网络", JSON.stringify(diag.timeout));
  check("地址不是合法 URL → 不发请求直接判格式错",
    diag.badUrl.ok === false && diag.badUrl.stage === "地址格式", JSON.stringify(diag.badUrl));
  /* 5xx 单独一条：代理自己有错时如果放行，用户点了「测试」看到「可用」，
     一去搜索就失败 —— 自检就成了误导。 */
  check("5xx → 判为不可用（代理自己出错）",
    diag.serverErr.ok === false, JSON.stringify(diag.serverErr));
  check("5xx 时 stage 指向代理侧",
    diag.serverErr.stage === "代理侧错误", diag.serverErr.stage);

  /* ---------- 4. AniList 也要能走代理 ---------- */
  /* 直接读源文件文本验「第三参传了什么」。
     不用 eval 去读 DOM 里的 script：标签上没有 id，getElementById 恒为 null，
     而「找不到 script」这个失败会和「没传 true」混在一起，看不出是哪个问题。
     正则从文件读反而更直接 —— 验的本来就是「源码里写的是什么」。 */
  const srcText = fs.readFileSync(path.join(__dirname, "..", "anime-rewind.html"), "utf8");
  check("源文件里能定位到AniList 的 fetchJSON 调用（否则下面两条是空跑）",
    /fetchJSON\(\s*"https:\/\/graphql\.anilist\.co"/.test(srcText));
  const anilistCall = srcText.match(/fetchJSON\(\s*"https:\/\/graphql\.anilist\.co"\s*,\s*opts\s*,\s*(\w+)\s*\)/);
  check("AniList 的fetchJSON 允许走代理（不再写死 false）",
    anilistCall !== null && anilistCall[1] !== "false",
    anilistCall ? "第三参=" + anilistCall[1] : "未匹配到调用");

  /* 反向：不能两个源都写死 false，否则代理配置完全没用 */
  const bgmCall = srcText.match(/fetchJSON\(target,\s*opts,\s*(\w+)\)/);
  check("Bangumi 的 fetchJSON 第三参存在", bgmCall !== null, bgmCall ? bgmCall[1] : "未匹配");

  /* ---------- 5. 设置页：自检按钮存在且文案不误导 ---------- */
  check("设置页有「测试代理」按钮",
    /data-act="test-proxy"/.test(srcText), "未找到 data-act=\"test-proxy\"");
  check("代理输入框仍是 data-set 绑定（填了会被保存）",
    /data-set="data_proxy_url"/.test(srcText));
  check("设置页有代理自检结果容器",
    /data-proxy-report/.test(srcText));
  check("设置页说明里点明公共代理多数不可用（不再暗示填了就行）",
    /连不上|被限流|要 API Key/.test(srcText), "缺少实测结论提示");
  check("设置页说明里点明 AniList 通常不需要代理",
    /AniList.{0,40}直连/.test(srcText), "缺少 AniList 可直连的说明");

  /* badge 类名必须真实存在，否则报告区显示成无样式的裸文字 */
  check("自检结果用的 badge-fav 类已定义",
    /\.badge-fav\{/.test(srcText));
  check("自检结果用的 badge-master 类已定义",
    /\.badge-master\{/.test(srcText));

  console.log("\n" + (fail === 0 ? "全部通过 " : "") + pass + " 项通过" + (fail ? "，" + fail + " 项失败" : ""));
  if(fail){ console.log("失败项：\n - " + fails.join("\n - ")); process.exit(1); }
})().catch(e => { console.error("测试自身异常：", e); process.exit(2); });
