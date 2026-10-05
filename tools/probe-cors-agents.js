/* 多轮取样：区分「稳定可用」「偶尔能通」「完全不通」。
   单次探测会骗人 —— 实测里 allorigins /get 超时而 /raw 成功，
   同一分钟内同一个服务给出相反的结论。
   只测一次就把它推荐给用户，等于让用户自己当探测器。

   每个候选跑 3 轮，算可用率。目标是能给用户一个诚实的表：
   哪些真能填、哪些别浪费时间。 */
const https = require("https");
const { URL } = require("url");

/* 目标用 graphql.anilist.co 的根路径：它会返回 400（要求 POST），
   但只要有 HTTP 响应就说明「代理把请求转出去了」——
   用一个 200 的 POST 目标会让「代理成功」与「目标成功」两件事缠在一起，
   分不开就归因不了。 */
const TARGET = "https://graphql.anilist.co";
const ROUNDS = 3;

const CANDIDATES = [
  ["allorigins /raw",  "https://api.allorigins.win/raw?url="],
  ["allorigins /get",  "https://api.allorigins.win/get?url="],
  ["corsproxy.io",     "https://corsproxy.io/?url="],
  ["codetabs",         "https://api.codetabs.com/v1/proxy?quest="],
  ["cors.lol",         "https://api.cors.lol/?url="],
  ["corsproxy.xyz",    "https://corsproxy.xyz/?url="],
  ["cors-anywhere.cf", "https://cors-anywhere.herokuapp.com/"],
  ["test.cors.workers.dev", "https://test.cors.workers.dev/?"],
  ["thingproxy",       "https://thingproxy.freeboard.io/fetch/"],
  /* 下面几个是「服务器可能在国内」的候选。判断依据不是宣传而是实测 ——
     国内做的服务才可能不用梯子，而绝大多数免费 CORS 代理是欧美裸机。 */
  ["corsproxy.garmeeh", "https://corsproxy.garmeeh.workers.dev/?url="],
  ["proxy.cors.sh",     "https://proxy.cors.sh/"],
  ["corsfix",           "https://proxy.corsfix.com/?"],
  ["cors.iamnd.eu.org", "https://cors.iamnd.eu.org/"],
  ["cdn.jsdelivr(对照)", "https://cdn.jsdelivr.net/"],
];

function once(url) {
  return new Promise(res => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname, port: 443, path: u.pathname + u.search,
      method: "GET", timeout: 9000,
      headers: { "User-Agent": "Mozilla/5.0", Origin: "https://local.test", Accept: "*/*" }
    }, r => {
      let n = 0; const cs = [];
      r.on("data", d => { n += d.length; if (cs.length < 3) cs.push(d); });
      r.on("end", () => res({
        ok: true, s: r.statusCode,
        acao: !!r.headers["access-control-allow-origin"],
        n, head: Buffer.concat(cs).toString("utf8").replace(/\s+/g, " ").slice(0, 46)
      }));
    });
    req.on("error", e => res({ ok: false, why: e.code || e.message }));
    req.on("timeout", () => { req.destroy(); res({ ok: false, why: "TIMEOUT" }); });
    req.end();
  });
}

(async () => {
  console.log("目标 " + TARGET + "（GET 应回 400/404，说明请求确实转发了；超时 = 代理没打通）");
  console.log("每候选 " + ROUNDS + " 轮\n");
  console.log("判据说明：401/403/429 一律算「不可用」——");
  console.log("  401 要 API Key（用户没Key 就填不进来），403 是被墙，429 是限流。");
  console.log("  只有 2xx 才算真可用。上一轮把 401 判成「稳定」是错的。\n");
  const enc = encodeURIComponent(TARGET);
  const rows = [];
  for (const [name, prefix] of CANDIDATES) {
    const got = [];
    for (let i = 0; i < ROUNDS; i++) got.push(await once(prefix + enc));
    /* 「可用」=2xx 且带 CORS 头。带不带 CORS 头决定浏览器能不能读到 ——
       缺头的代理在 curl 里看着正常，在页面里照样失败。
       第一版把 401 也算进可用，于是把「稳定要 Key 的服务」推荐给了
       用户：测的时候是通的，用户填进去就401 —— 探测骗了人。 */
    const usable = got.filter(g => g.ok && g.acao && g.s >= 200 && g.s < 300).length;
    const reached = got.filter(g => g.ok).length;
    const mark = usable === ROUNDS ? "✔ 稳定" : usable > 0 ? "◐ 抖动" : "✘ 不可用";
    console.log(mark + "  " + name.padEnd(24) +
      "可用 " + usable + "/" + ROUNDS + "｜有响应 " + reached + "/" + ROUNDS +
      "｜" + got.map(g => g.ok ? (g.s + (g.acao ? "" : "-cors")) : g.why).join(" "));
    rows.push({ name, prefix, usable });
  }
  console.log("\n填进设置 → 数据源 → CORS 代理地址 的候选（需 2xx 且带 CORS 头）");
  const good = rows.filter(r => r.usable === ROUNDS);
  if (!good.length) console.log("  （无：这一轮没有任何公共代理稳定可用）");
  else good.forEach(r => console.log("  " + r.prefix + "    ← " + r.name));
})();
