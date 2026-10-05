/* 放映厅外部播放器专项测试
 *
 * 重点不在「iframe 能不能显示」（jsdom 里永远显示不出来），
 * 而在 URL 解析的正确性与安全性 —— 这是唯一能真正测的部分，
 * 也是出错代价最高的部分：解析错 → 用户粘什么都是白屏；
 * 安全性失守 → javascript: 伪协议能进 iframe。
 */
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const HTML = path.join(__dirname, "..", "anime-rewind.html");
const html = fs.readFileSync(HTML, "utf8");

let pass = 0, fail = 0;
const errs = [];
function check(name, cond, detail){
  if(cond){ pass++; console.log("PASS " + name); }
  else { fail++; errs.push(name + (detail ? " — " + detail : "")); console.log("FAIL " + name + (detail ? "  → " + detail : "")); }
}

(async () => {
  const dom = new JSDOM(html, { runScripts:"dangerously", url:"https://x.test/", pretendToBeVisual:true });
  const win = dom.window, doc = win.document;
  await new Promise(r => setTimeout(r, 900));
  const ev = code => win.eval(`(async () => { ${code} })()`);
  const evSync = code => win.eval(code);

  // ---------- 1. YouTube 各形态 ----------
  const cases = [
    ["https://www.youtube.com/watch?v=dQw4w9WgXcQ",            "dQw4w9WgXcQ", "youtube-nocookie.com/embed/dQw4w9WgXcQ"],
    ["https://youtu.be/dQw4w9WgXcQ",                            "dQw4w9WgXcQ", "youtube-nocookie.com/embed/dQw4w9WgXcQ"],
    ["https://www.youtube.com/embed/dQw4w9WgXcQ",               "dQw4w9WgXcQ", "youtube-nocookie.com/embed/dQw4w9WgXcQ"],
    ["https://www.youtube.com/shorts/dQw4w9WgXcQ",              "dQw4w9WgXcQ", "youtube-nocookie.com/embed/dQw4w9WgXcQ"],
    ["https://m.youtube.com/watch?v=dQw4w9WgXcQ&t=30s",        "dQw4w9WgXcQ", "youtube-nocookie.com/embed/dQw4w9WgXcQ"]
  ];
  for (const [input, vid, mustContain] of cases) {
    const r = evSync(`resolveEmbed(${JSON.stringify(input)})`);
    check("YouTube 解析: " + input.slice(0, 52),
      r.ok && r.src.includes(mustContain), JSON.stringify(r.src || r.reason));
  }
  // 播放列表要保留
  const pl = evSync('resolveEmbed("https://www.youtube.com/watch?v=abc12345678&list=PL1234567890")');
  check("YouTube 播放列表参数被保留", pl.ok && pl.src.includes("list=PL1234567890"), pl.src);

  // ---------- 2. Bilibili 各形态 ----------
  const bili = [
    ["https://www.bilibili.com/video/BV1GJ411x7h7", "BV1GJ411x7h7", null],
    ["https://www.bilibili.com/video/BV1GJ411x7h7/?p=3", "BV1GJ411x7h7", "p=3"],
    ["https://www.bilibili.com/video/av170001", "170001", null],
    ["https://player.bilibili.com/player.html?bvid=BV1GJ411x7h7", "BV1GJ411x7h7", null]
  ];
  for (const [input, id, extra] of bili) {
    const r = evSync(`resolveEmbed(${JSON.stringify(input)})`);
    check("Bilibili 解析: " + input.slice(0, 50),
      r.ok && r.src.startsWith("https://player.bilibili.com/player.html") && r.src.includes(id)
      && (!extra || r.src.includes(extra)),
      r.src || r.reason);
  }

  // ---------- 3. 通用网页原样透传 ----------
  const g = evSync('resolveEmbed("https://example.com/watch/abc")');
  check("未知站点原样透传", g.ok && g.src === "https://example.com/watch/abc" && g.changed === false, JSON.stringify(g));

  // ---------- 4. 缺协议头自动补 ----------
  const np = evSync('resolveEmbed("www.bilibili.com/video/BV1GJ411x7h7")');
  check("缺 https:// 自动补全并正确解析", np.ok && np.src.includes("BV1GJ411x7h7"), np.src || np.reason);

  // ---------- 5. 安全：伪协议必须被拒 ----------
  for (const evil of ["javascript:alert(1)", "JavaScript:alert(1)", "  javascript:alert(1)  ", "data:text/html,<script>alert(1)</script>"]) {
    const r = evSync(`normalizeStreamURL(${JSON.stringify(evil)})`);
    check("伪协议被拒: " + JSON.stringify(evil).slice(0, 44), r === "", "返回 " + JSON.stringify(r));
  }
  const evilEmbed = evSync('resolveEmbed("javascript:alert(1)")');
  check("resolveEmbed 拒绝 javascript:", evilEmbed.ok === false, JSON.stringify(evilEmbed));

  // ---------- 6. 空值与垃圾输入不抛异常 ----------
  for (const junk of ["", "   ", "not a url", "://", "https://", "http://%%%"]) {
    const r = evSync(`resolveEmbed(${JSON.stringify(junk)})`);
    check("垃圾输入安全失败: " + JSON.stringify(junk).slice(0, 30), r.ok === false, JSON.stringify(r));
  }

  // ---------- 7. changed 标记正确（告知用户链接被转换过） ----------
  const yc = evSync('resolveEmbed("https://youtu.be/dQw4w9WgXcQ")');
  check("YouTube 链接标记为已转换 changed=true", yc.ok && yc.changed === true, JSON.stringify({ ok: yc.ok, changed: yc.changed }));
  const bc = evSync('resolveEmbed("https://www.bilibili.com/video/BV1GJ411x7h7")');
  check("Bilibili 分享链接标记为已转换", bc.ok && bc.changed === true, JSON.stringify({ ok: bc.ok, changed: bc.changed }));
  const vc = evSync('resolveEmbed("https://vimeo.com/123456789")');
  check("Vimeo 转为 player.vimeo.com", vc.ok && vc.src === "https://player.vimeo.com/video/123456789" && vc.changed === true,
    JSON.stringify({ ok: vc.ok, src: vc.src, changed: vc.changed }));
  // 已经就是播放器地址时不应再改
  const vc2 = evSync('resolveEmbed("https://player.vimeo.com/video/123456789")');
  check("Vimeo 播放器地址原样透传", vc2.ok && vc2.changed === false, JSON.stringify({ ok: vc2.ok, src: vc2.src, changed: vc2.changed }));

  // ---------- 8. 页面 UI 真的渲染出来了 ----------
  await ev('settings.module_theater = true; go("theater");');
  await new Promise(r => setTimeout(r, 300));
  check("放映厅有片源输入框", !!doc.querySelector("#st-url"));
  /* 无片源时「播放」「新标签打开」整个按钮不渲染，而不是渲染出来禁用。
     禁用按钮仍可聚焦、仍占位，读起来像「有但不能按」；
     不渲染则明确表达「先存一条线路」。这轮改多线路时一并改了这里的形态。 */
  check("无片源时不渲染播放按钮", !doc.querySelector('[data-st="play"]'));
  check("无片源时不渲染「新标签打开」按钮", !doc.querySelector('[data-st="open"]'));
  check("无片源时仍有「添加线路」按钮", !!doc.querySelector('[data-st="add"]'));
  check("放映厅有状态诊断条", !!doc.querySelector("#st-status"));
  check("播放器容器默认隐藏", doc.querySelector("#st-mount").hidden === true);
  check("状态条说明了嵌入限制（不是空白）",
    /禁止被第三方网站嵌入/.test(doc.querySelector("#st-status").textContent),
    doc.querySelector("#st-status").textContent.slice(0, 60));

  // ---------- 9. 真实点击：输入非法网址 → 报错，不崩 ----------
  const input = doc.querySelector("#st-url");
  const addBtn = () => doc.querySelector('[data-st="add"]');
  input.value = "javascript:alert(1)";
  addBtn().click();
  await new Promise(r => setTimeout(r, 200));
  check("输入 javascript: 后点添加 → 报错且不创建 iframe",
    /无效|无法识别/.test(doc.querySelector("#st-status").textContent) && !doc.querySelector(".stream-frame"),
    doc.querySelector("#st-status").textContent.slice(0, 60));

  // ---------- 10. 真实点击：添加合法 B 站网址 → 成为一条线路 ----------
  /* 流程在本轮改成「填 → 添加线路 → 播放」：播放按钮只在有线路时渲染。
     播放本身不再隐式落盘 —— 点错了也写进库不是用户想要的。 */
  input.value = "https://www.bilibili.com/video/BV1GJ411x7h7";
  /* 未选作品时添加线路必须被拒绝：播放源是「按作品保存」的，
     没有归属的线路存到哪里都是错的。所以先建一部作品再测。 */
  addBtn().click();
  await new Promise(r => setTimeout(r, 150));
  check("未选作品时添加线路被拒绝",
    /请先从片库打开一部作品/.test(doc.querySelector("#st-status").textContent),
    doc.querySelector("#st-status").textContent.slice(0, 60));

  await ev('state.anime.push(draftFromCandidate({ id:"an_src1", titleCn:"线路测试用", totalEpisodes:12 })); saveAnime(state.anime[state.anime.length-1]); go("theater", "an_src1");');
  await new Promise(r => setTimeout(r, 300));
  const input2 = doc.querySelector("#st-url");
  check("进入作品详情后有播放源面板", !!input2);
  input2.value = "https://www.bilibili.com/video/BV1GJ411x7h7";
  doc.querySelector('[data-st="add"]').click();
  await new Promise(r => setTimeout(r, 300));
  const lineCount = await ev('return String(state.anime.filter(function(x){return x.id==="an_src1";})[0].sources.length)');
  check("点击添加后线路数变为 1", lineCount === "1", lineCount);
  const legacyUrl = await ev('return String(state.anime.filter(function(x){return x.id==="an_src1";})[0].streamUrl)');
  check("添加线路同时兼容写回旧字段 streamUrl",
    legacyUrl === "https://www.bilibili.com/video/BV1GJ411x7h7", legacyUrl);

  /* 再加一条同名地址：必须去重而不是攒出两条一模一样的线路。 */
  doc.querySelector("#st-url").value = "https://www.bilibili.com/video/BV1GJ411x7h7";
  doc.querySelector('[data-st="add"]').click();
  await new Promise(r => setTimeout(r, 250));
  const lineCount2 = await ev('return String(state.anime.filter(function(x){return x.id==="an_src1";})[0].sources.length)');
  check("重复添加同址不会攒出重复线路", lineCount2 === "1", lineCount2);

  /* iframe 属性断言改用 Vimeo 直链：B 站番剧页要联网换算 bvid+cid，
     测试环境无外网必然换不出来，于是 iframe 根本建不出来，
     后面每一条iframe 断言都会连带变成「实际 0」——
     那是环境限制被误读成回归。Vimeo 的规则是纯本地 URL 改写，
     换不成与成不成只取决于 resolveEmbed 本身，适合做断言靶子。 */
  doc.querySelector("#st-url").value = "https://vimeo.com/123456789";
  doc.querySelector('[data-st="add"]').click();
  await new Promise(r => setTimeout(r, 250));
  check("可加入第二条线路（Vimeo）",
    evSync('state.anime.filter(function(x){return x.id==="an_src1";})[0].sources.length') === 2,
    String(evSync('state.anime.filter(function(x){return x.id==="an_src1";})[0].sources.length')));

  doc.querySelector('[data-st="play"]').click();
  await new Promise(r => setTimeout(r, 400));
  const frame = doc.querySelector(".stream-frame");
  check("点击播放后创建了 iframe", !!frame);
  check("iframe 指向 Vimeo 播放器", frame && frame.src.includes("player.vimeo.com"), frame ? frame.src : "无");
  check("播放器容器已显示", doc.querySelector("#st-mount").hidden === false);
  check("播放本身不额外写全局库（线路已在添加时落盘）", evSync("settings.stream_url") === "",
    String(evSync("settings.stream_url")));
  check("iframe 带 allowfullscreen", frame && frame.hasAttribute("allowfullscreen"));
  check("iframe 带 sandbox（隔离第三方脚本）", frame && frame.hasAttribute("sandbox"), frame ? frame.getAttribute("sandbox") : "");
  check("iframe referrerpolicy 为 no-referrer", frame && frame.getAttribute("referrerpolicy") === "no-referrer");

  // ---------- 11. 重复点击不叠加 iframe ----------
  doc.querySelector('[data-st="play"]').click();
  await new Promise(r => setTimeout(r, 200));
  doc.querySelector('[data-st="play"]').click();
  await new Promise(r => setTimeout(r, 200));
  check("连点播放后页面中只有 1 个 iframe", doc.querySelectorAll(".stream-frame").length === 1,
    "实际 " + doc.querySelectorAll(".stream-frame").length);

  // ---------- 12. 多线路时的清除入口 ----------
  /* 只有一条线路时不给「清除当前线路」：清完就没了，
     与其给一个清完就空的按钮，不如不给。 */
  const clearOne = doc.querySelector('[data-st="clear-one"]');
  const clearAll = doc.querySelector('[data-st="clear"]');
  check("两条线路时提供「清除当前线路」", !!clearOne);
  check("两条线路时提供「清除全部」", !!clearAll);

  // ---------- 13. 未选作品时不能添加（否则写去哪？） ----------
  /* 上面已验证过一次未选作品被拒绝；这里补一条「线路不会凭空出现」。 */
  const beforeCount = evSync('state.anime.filter(function(x){return x.id==="an_src1";})[0].sources.length');
  check("未选作品的添加没有污染任何作品", beforeCount === 2, "线路数=" + beforeCount);

  // ================= 以下为「按作品保存片源与进度」 =================
  // 这部分是本轮的核心需求：片源不能再是全局一份。
  await ev(`
    state.anime = [draftFromCandidate({ id:"an_test1", titleCn:"漆黑的子弹", totalEpisodes:13 })];
    saveSettings();
    go("theater", "an_test1");
  `);
  await new Promise(r => setTimeout(r, 400));

  check("详情页渲染出片名", /漆黑的子弹/.test(doc.querySelector("#view").textContent));
  check("详情页含外部播放器面板", !!doc.querySelector(".stream-panel"));
  check("详情页有集数输入框", !!doc.querySelector("#st-ep"));
  check("详情页结构：详情在上、播放器在下",
    (() => {
      const wrap = doc.querySelector(".detail-wrap"), panel = doc.querySelector(".stream-panel");
      if (!wrap || !panel) return "缺元素";
      // 同一父容器内，详情块的 DOM 位置必须在前
      return wrap.compareDocumentPosition(panel) & win.Node.DOCUMENT_POSITION_FOLLOWING ? true : "顺序相反";
    })(),
    "详情与播放器的先后顺序");
  check("详情页不再有语录待机屏保", !doc.querySelector(".crt-quote") && !doc.querySelector(".modern-quote"));
  check("详情页不再有 CRT 外框", !doc.querySelector(".crt-frame") && !doc.querySelector(".modern-frame"));

  /* 填 URL + 集数 → 点「添加线路」。
     新流程不再把已保存的地址回填进输入框：输入框是「待添加」的位置，
     回填会让用户以为可以改它然后点保存—— 实际会新增一条重复线路。
     已保存的线路改为在面板与播放器选源面板里呈现。 */
  const in2 = doc.querySelector("#st-url"), ep2 = doc.querySelector("#st-ep");
  in2.value = "https://www.bilibili.com/video/BV1kx411k7VB";
  ep2.value = "7";
  doc.querySelector('[data-st="add"]').click();
  await new Promise(r => setTimeout(r, 400));
  const a1 = evSync('animeById("an_test1")');
  check("添加后 URL 落到该作品上", a1 && a1.streamUrl === "https://www.bilibili.com/video/BV1kx411k7VB",
    String(a1 && a1.streamUrl));
  check("添加后集数落到该作品上", a1 && a1.streamEp === 7, String(a1 && a1.streamEp));
  check("线路进了 sources 数组且带集数",
    a1 && Array.isArray(a1.sources) && a1.sources.length === 1 && a1.sources[0].ep === 7,
    JSON.stringify(a1 && a1.sources));
  check("添加后输入框已清空（避免误以为可改后保存）",
    doc.querySelector("#st-url").value === "", doc.querySelector("#st-url").value);
  check("添加不影响全局 settings.stream_url", evSync("settings.stream_url") === "", String(evSync("settings.stream_url")));
  check("添加后播放器容器仍在（不整页重渲染）", !!doc.querySelector(".stream-mount"));

  // 关键隔离性测试：另一部作品不应看到这份片源
  await ev('state.anime.push(draftFromCandidate({ id:"an_test2", titleCn:"另一部番" })); go("theater", "an_test2");');
  await new Promise(r => setTimeout(r, 400));
  check("换一部作品 → 片源输入框为空（不串号）", doc.querySelector("#st-url").value === "",
    doc.querySelector("#st-url").value);
  check("换一部作品 → 集数为空", doc.querySelector("#st-ep").value === "",
    doc.querySelector("#st-ep").value);
  check("换一部作品 → 不渲染播放按钮（它没有线路）", !doc.querySelector('[data-st="play"]'));

  // 回到第一部：线路应仍在，且详情页显示声明的集数
  await ev('go("theater", "an_test1");');
  await new Promise(r => setTimeout(r, 400));
  check("回到第一部 → 线路仍在",
    evSync('animeById("an_test1").sources.length') === 1,
    String(evSync('animeById("an_test1").sources.length')));
  check("回到第一部 → 集数回填到输入框（便于加下一条线路时沿用）",
    doc.querySelector("#st-ep").value === "7", doc.querySelector("#st-ep").value);
  check("回到第一部 → 有播放按钮", !!doc.querySelector('[data-st="play"]'));
  check("详情页显示「看到第 7 集」", /第\s*7\s*集/.test(doc.querySelector(".stream-note").textContent),
    doc.querySelector(".stream-note") ? doc.querySelector(".stream-note").textContent.slice(0, 40) : "无 .stream-note");

  // 集数写回 B 站分 P
  const applied = evSync('applyEpToURL("https://www.bilibili.com/video/BV1kx411k7VB", 12)');
  check("集数写回 B 站分 P 参数", applied && applied.includes("p=12"), String(applied));
  const appliedY = evSync('applyEpToURL("https://youtu.be/dQw4w9WgXcQ", 12)');
  check("YouTube 不乱改地址（无法换算就原样返回）", appliedY === "https://youtu.be/dQw4w9WgXcQ", String(appliedY));

  // 非法集数必须被拦
  /* 校验顺序：先看网址再看集数，是用户实际会遇到的情形 ——
     用户改了集数但没重新填网址就点添加，此时该报的是「网址为空」，
     因为那才是他下一步要解决的。两项都非法时报哪一条都可以，
     但不能什么都不报。 */
  doc.querySelector("#st-url").value = "";
  doc.querySelector("#st-ep").value = "0";
  doc.querySelector('[data-st="add"]').click();
  await new Promise(r => setTimeout(r, 300));
  check("网址与集数同时非法时给出可执行提示",
    /请先填一个播放网址|大于 0 的整数/.test(doc.querySelector("#st-status").textContent),
    doc.querySelector("#st-status").textContent.slice(0, 50));

  /* 网址合法、集数非法：必须拦下，且不能把线路加进去。 */
  doc.querySelector("#st-url").value = "https://www.bilibili.com/video/BV1zz4y1j7bY";
  doc.querySelector("#st-ep").value = "0";
  doc.querySelector('[data-st="add"]').click();
  await new Promise(r => setTimeout(r, 300));
  check("集数填 0 → 拒绝添加并给出可执行提示",
    /大于 0 的整数/.test(doc.querySelector("#st-status").textContent),
    doc.querySelector("#st-status").textContent.slice(0, 50));
  check("集数非法时没有新增线路",
    evSync('animeById("an_test1").sources.length') === 1,
    String(evSync('animeById("an_test1").sources.length')));
  check("集数非法时不污染已存值", evSync('animeById("an_test1").streamEp') === 7,
    String(evSync('animeById("an_test1").streamEp')));

  // 清除：多线路版里「清除全部」只在 >1 条时渲染，
  // 所以先补到两条再测「清除当前线路」与「清除全部」两个层级。
  doc.querySelector("#st-url").value = "https://vimeo.com/987654321";
  doc.querySelector("#st-ep").value = "";
  doc.querySelector('[data-st="add"]').click();
  await new Promise(r => setTimeout(r, 350));
  check("补第二条线路成功",
    evSync('animeById("an_test1").sources.length') === 2,
    String(evSync('animeById("an_test1").sources.length')));

  // 先测「清除当前线路」：只掉一条，另一条还在
  const clrOne = doc.querySelector('[data-st="clear-one"]');
  check("两条线路时提供「清除当前线路」", !!clrOne);
  clrOne.click();
  await new Promise(r => setTimeout(r, 400));
  check("清除当前线路后只剩一条",
    evSync('animeById("an_test1").sources.length') === 1,
    String(evSync('animeById("an_test1").sources.length')));
  check("清除一条后仍有线路 → 播放按钮还在",
    !!doc.querySelector('[data-st="play"]'));

  // 再测「清除全部」
  const clr2 = doc.querySelector('[data-st="clear"]');
  check("只剩一条时不再提供「清除全部」（清完就没了）", !clr2);
  const a2 = evSync('animeById("an_test1")');
  check("清除当前线路后该作品仍有可用片源", a2 && !!a2.streamUrl, String(a2 && a2.streamUrl));

  // 未选作品时 = 选片页
  await ev('go("theater");');
  await new Promise(r => setTimeout(r, 400));
  /* 对着 state.anime 断言，不写死张数。
     写死 2 的前提是「库里恰好两部」—— 早前第 133 行已经塞了 an_src1，
     后面又 push 了 an_test2，实际是 3 部。这类断言测的是
     「我数过几部」而不是「选片页列全了没」，增删测试数据就会红。 */
  const expectCards = JSON.parse(evSync('JSON.stringify(state.anime.map(function(a){return a.id;}))')).length;
  check("未选作品时显示选片入口",
    !!doc.querySelector(".pick-card") && doc.querySelectorAll(".pick-card").length === expectCards,
    "选片卡 " + doc.querySelectorAll(".pick-card").length + " 张 / 库里 " + expectCards + " 部");
  check("未选作品时无待机语录屏保", !doc.querySelector(".crt-quote") && !doc.querySelector(".modern-quote"));
  check("未选作品时播放区标注为临时片源",
    /临时片源/.test(doc.querySelector(".stream-panel .panel-head").textContent),
    doc.querySelector(".stream-panel .panel-head").textContent.slice(0, 40));

  // 点选片卡 → 进入详情
  doc.querySelector(".pick-card").click();
  await new Promise(r => setTimeout(r, 400));
  check("点选片卡进入该作品详情", !!doc.querySelector(".detail-wrap") && !!doc.querySelector(".stream-panel"));

  // 页头不应再有失效的 CRT 皮肤切换 / 换一条语录
  // 断言只扫用户可见元素：JS 注释里提到「换一条语录」是解释删除原因，
  // 用 body.textContent 会把这些注释当成文案，报出假失败。
  const visibleText = Array.from(doc.querySelectorAll("button, h1, h2, h3, summary, label, .seg, .hint"))
    .map(n => n.textContent).join(" | ");
  check("放映厅页头不再有「换一条语录」按钮", !/换一条语录/.test(visibleText), visibleText.slice(0, 60));
  check("放映厅页头不再有 CRT/现代影院皮肤切换", !/现代影院/.test(visibleText), visibleText.slice(0, 60));

  /* ---------- 番剧播放页（真实故障回归） ----------
   *
   * 用户粘的是 https://www.bilibili.com/bangumi/play/ep102167，
   * 而 bilibili 规则只认 BV/av —— 取不到 bvid/aid 就返回 null。
   * 连锁反应有两个，都很容易被忽略：
   *   1) 播放直接报「没能解析出视频地址」；
   *   2) 保存被一起拒绝（save() 当时写的是 `!resolveEmbed(raw).ok` 就 return）。
   * 第 2 条才是用户真正抱怨的「连保存都不行」—— 保存一个网址
   * 跟能不能在页内播放本就是两件事，不该绑死。
   * 真实浏览器验证见 tools/e2e-theater-stream.js。 */
  const bangumi = [
    ["https://www.bilibili.com/bangumi/play/ep102167", "epId", "102167"],
    ["https://www.bilibili.com/bangumi/play/ep102167?spm_id_from=333.337.0.0", "epId", "102167"],
    ["https://www.bilibili.com/bangumi/play/ss4181", "seasonId", "4181"],
    ["https://www.bangumi.tv/play/ep102167", null, null]
  ];
  for (const [input, key, val] of bangumi) {
    const k = evSync('bilibiliSeasonId(normalizeStreamURL(' + JSON.stringify(input) + '))');
    if (key === null) {
      check("非 B 站番剧链接不被误判: " + input.slice(0, 44), k === null, JSON.stringify(k));
      continue;
    }
    check("番剧链接被识别(" + key + "): " + input.slice(0, 40),
      k && k[key] === val, JSON.stringify(k));
  }
  const needSeason = evSync('resolveEmbed("https://www.bilibili.com/bangumi/play/ep102167")');
  check("番剧链接走 needsSeason 换算流程，而不是被判为无效",
    needSeason && needSeason.ok === false && needSeason.needsSeason === true,
    JSON.stringify({ ok: needSeason.ok, needs: needSeason.needsSeason }));
  check("needsSeason 的提示语不说「无法识别」（否则用户以为自己粘错了）",
    needSeason && !/无法识别|没能从这条/.test(needSeason.reason || ""), needSeason && needSeason.reason);

  // 保存绝不能被嵌入解析拦住 —— 这是本次修复的核心。
  // 用 go() 进详情：直接改 state.routeId 不会触发重渲染。
  await ev('go("theater", "an_test1");');
  await new Promise(r => setTimeout(r, 400));
  check("进入详情后播放器面板就位", !!doc.querySelector("#st-url"));
  const saveBangumi = await ev(`
    const input = document.querySelector("#st-url");
    input.value = "https://www.bilibili.com/bangumi/play/ep102167?spm_id_from=333.337.0.0";
    const ep = document.querySelector("#st-ep");
    ep.value = "2";
    document.querySelector('[data-st="add"]').click();
    await new Promise(r => setTimeout(r, 400));
    const a = animeById("an_test1");
    return JSON.stringify({ u: a.streamUrl, e: a.streamEp });
  `);
  const sb = JSON.parse(saveBangumi);
  check("无法内嵌的番剧网址也能保存（本次修复）",
    sb.u === "https://www.bilibili.com/bangumi/play/ep102167?spm_id_from=333.337.0.0", saveBangumi);
  check("保存集数与番剧链接同时生效", sb.e === 2, saveBangumi);

  // 换算失败时不得抛出未捕获异常，且必须带回官方页
  const seasonFail = await ev(`
    window.fetch = () => Promise.reject(new Error("no-network"));
    const res = await resolveEmbedAsync("https://www.bilibili.com/bangumi/play/ep102167");
    return JSON.stringify({ ok: res.ok, needOfficial: !!res.needOfficial,
      official: res.official || null, reason: res.reason || "" });
  `);
  const sf = JSON.parse(seasonFail);
  check("换算失败时返回 needOfficial 而不是抛错", sf.ok === false && sf.needOfficial === true, seasonFail);
  check("换算失败时带回官方页地址", String(sf.official || "").indexOf("bangumi/play/ep102167") > 0, seasonFail);
  check("换算失败的提示指向「新标签打开」这条例外", /新标签打开/.test(sf.reason || ""), sf.reason);

  // 集数写回：番剧用 ep=，普通投稿用 p=（写错参数名会静默不生效）
  check("番剧链接写回归数用 ep=",
    evSync('applyEpToURL("https://www.bilibili.com/bangumi/play/ep102167", 5)').indexOf("ep=5") > 0,
    evSync('applyEpToURL("https://www.bilibili.com/bangumi/play/ep102167", 5)'));
  check("普通投稿视频写回归数仍用 p=",
    evSync('applyEpToURL("https://www.bilibili.com/video/BV1GJ411x7h7", 5)').indexOf("p=5") > 0,
    evSync('applyEpToURL("https://www.bilibili.com/video/BV1GJ411x7h7", 5)'));

  // ---------- N. 死设置清理 ----------
  /* 放映厅待机屏保与皮肤切换删除后，tv_skin / crt_scanlines / crt_snow
     已无作用对象。这条断言防止它们（或同类死键）被重新加回 DEFAULT_SETTINGS：
     死设置最坑的地方不是「占一行」，而是它看起来还能用 ——
     用户找不到开关，音效却因为一个不可见的键被静默关掉。
     只查 DEFAULT_SETTINGS 的键，不查全文：老备份兼容代码里出现键名是合理的。 */
  const defaults = (() => {
    const i = html.indexOf("const DEFAULT_SETTINGS = {");
    const j = html.indexOf("let settings =", i);
    return html.slice(i, j);
  })();
  ["tv_skin", "crt_scanlines", "crt_snow"].forEach(k => {
    check("死设置已从 DEFAULT_SETTINGS 移除：" + k,
      defaults.indexOf(k + ":") < 0);
  });
  /* 反向：开机音必须还在，且是唯一条件 —— 曾经它被 tv_skin 挡在前面。 */
  check("开机音仍在默认设置里（不能连它一起清掉）",
    defaults.indexOf("crt_power_sound:") > 0);
  check("开机音不再被任何已删除的键挡在前面",
    /if\(settings\.crt_power_sound\)\s*powerSound\(\)/.test(
      html.slice(html.indexOf("function initAudioOnce"), html.indexOf("function initAudioOnce") + 800)
    ));

  console.log("\n通过 " + pass + " / " + (pass + fail));
  if (errs.length) { console.log("\n失败项："); errs.forEach(e => console.log("  · " + e)); }
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error("测试脚本异常:", e); process.exit(2); });
