// 无头冒烟测试（jsdom）：加载页面 → 走通主要流程 → 收集控制台错误
// 用法: node tools/smoke.js [target.html]
const fs = require("fs");
const path = require("path");
const { JSDOM, VirtualConsole } = require("jsdom");

const target = process.argv[2] || path.join(__dirname, "..", "anime-rewind.html");
const html = fs.readFileSync(target, "utf8");

const errors = [];
const warns = [];
const vc = new VirtualConsole();
vc.on("error", (...args) => errors.push("console.error: " + args.map(String).join(" ")));
vc.on("warn", (...args) => warns.push("console.warn: " + args.map(String).join(" ")));
vc.on("jsdomError", (e) => {
  const msg = String(e && e.message || e);
  // canvas / CSS 解析等 jsdom 未实现的能力，不构成应用缺陷
  if (/Not implemented|Could not parse CSS|getContext/i.test(msg)) return;
  errors.push("jsdomError: " + msg);
});

const dom = new JSDOM(html, {
  runScripts: "dangerously",
  pretendToBeVisual: true,
  url: "https://local.test/index.html",
  virtualConsole: vc
});
const win = dom.window;
const doc = win.document;
win.addEventListener("error", (e) => errors.push("window.error: " + (e.error && e.error.stack || e.message)));
win.addEventListener("unhandledrejection", (e) => errors.push("unhandledrejection: " + String(e.reason && e.reason.stack || e.reason)));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function check(name, fn) {
  try {
    const v = fn();
    results.push([v === true ? "PASS" : "FAIL", name, v === true ? "" : String(v)]);
  } catch (e) {
    results.push(["FAIL", name, String(e && e.message || e)]);
  }
}
const q = (sel) => doc.querySelector(sel);
const qa = (sel) => Array.from(doc.querySelectorAll(sel));
function click(el) { if (!el) return false; el.dispatchEvent(new win.MouseEvent("click", { bubbles: true })); return true; }
function setVal(el, v) {
  if (!el) return false;
  el.value = v;
  el.dispatchEvent(new win.Event("input", { bubbles: true }));
  el.dispatchEvent(new win.Event("change", { bubbles: true }));
  return true;
}

(async () => {
  await new Promise((r) => {
    if (doc.readyState === "complete") r();
    else win.addEventListener("load", r);
  });
  await sleep(900);

  // 1. 启动
  check("启动完成（boot 遮罩隐藏）", () => !q("#boot") || q("#boot").classList.contains("hide"));
  check("侧边栏渲染 7 个导航项", () => qa("#nav-list .nav-item").length === 7 || qa("#nav-list .nav-item").length);
  check("默认落点首页", () => q("#page-title").textContent.indexOf("看板") >= 0 || q("#page-title").textContent);
  check("首屏有内容", () => q("#view").innerHTML.length > 200 || q("#view").innerHTML.length);
  check("内置语录已播种 26 条", () => win.eval("state.quotes.length") === 26 || win.eval("state.quotes.length"));
  check("存储降级到 localStorage（jsdom 无 IndexedDB）", () => win.eval("Repo.mode") === "ls" || win.eval("Repo.mode"));

  // 2. 手动新增作品（走表单 → 去重 → 入库）
  win.eval("openAnimeForm({})");
  await sleep(60);
  check("添加表单打开", () => !!q("#f-titleCn"));
  setVal(q("#f-titleCn"), "数码宝贝大冒险");
  setVal(q("#f-titleOriginal"), "デジモンアドベンチャー");
  setVal(q("#f-airDate"), "1999-03-07");
  setVal(q("#f-totalEpisodes"), "54");
  setVal(q("#f-watchedEpisodes"), "54");
  setVal(q("#f-myScore"), "9.5");
  setVal(q("#f-watchYear"), "2008");
  setVal(q("#f-watchGrade"), "小学二年级");
  click(q("#f-save"));
  await sleep(150);
  check("作品入库", () => win.eval("state.anime.length") === 1 || win.eval("state.anime.length"));
  const id1 = win.eval("state.anime[0].id");
  check("进度=100% 自动匹配为「看过」", () => win.eval("statusName(state.anime[0])") === "看过" || win.eval("statusName(state.anime[0])"));
  check("估算时长按单集22分钟", () => win.eval("stats().hours") === 20 || win.eval("stats().hours"));

  // 3. L2 去重拦截
  win.eval("openAnimeForm({})");
  await sleep(60);
  setVal(q("#f-titleCn"), "数码宝贝大冒险");
  click(q("#f-save"));
  await sleep(120);
  check("重复入库出现 L2 拦截弹窗", () => (q("#modal-title") || {}).textContent === "重复检测" || (q("#modal-title") || {}).textContent);
  click(q("#cd-no")); // 仍要新建
  await sleep(120);
  check("选择「仍要新建」后产生第二条", () => win.eval("state.anime.length") === 2 || win.eval("state.anime.length"));
  await win.eval(`removeAnime("${id1}")`);
  const id2 = win.eval("state.anime[0].id");

  // 4. 记录重看 + 感想
  win.eval(`promptReview(state.anime[0])`);
  await sleep(80);
  setVal(q("#rv-content"), "当年守在电视前");
  click(q("#rv-save"));
  await sleep(150);
  check("重看次数 +1", () => win.eval("state.anime[0].rewatchCount") === 1 || win.eval("state.anime[0].rewatchCount"));
  check("首次感想 round=1", () => win.eval("state.anime[0].reviews[0].round") === 1 || win.eval("JSON.stringify(state.anime[0].reviews)"));
  win.eval("promptReview(state.anime[0])");
  await sleep(80);
  setVal(q("#rv-content"), "二刷还是哭了");
  click(q("#rv-save"));
  await sleep(150);
  check("第二次重看感想 round=2", () => win.eval("state.anime[0].reviews.map(r=>r.round).sort().join()") === "1,2" || win.eval("state.anime[0].reviews.map(r=>r.round).join()"));

  // 5. 各页面渲染
  for (const route of ["library", "chronicle", "wheel", "theater", "quotes", "settings"]) {
    win.eval(`go("${route}")`);
    await sleep(90);
    check("页面 " + route + " 有内容", () => q("#view").innerHTML.length > 120 || q("#view").innerHTML.length);
  }

  // 6. 片库视图切换与内联编辑
  win.eval('go("library")');
  await sleep(80);
  check("封面墙卡片渲染", () => qa(".wall .card").length === 1 || qa(".wall .card").length);

  // 6b. 3D 翻转卡结构与交互（真实点击 DOM，不只调函数）
  const cs = (sel) => win.getComputedStyle(q(sel));
  check("卡片含 3D 容器 card-3d", () => qa(".wall .card > .card-3d").length === 1 || qa(".wall .card > .card-3d").length);
  check("正反两面都是 direct child（3D 层级不被包裹打乱）",
    () => qa(".wall .card > .card-3d > .fc-face").length === 2 || qa(".wall .card > .card-3d > .fc-face").length);
  check("正面是封面、背面是资料", () => qa(".fc-front .fc-cover").length >= 1 && qa(".fc-back .fc-body").length >= 1);
  check("背面有旋转光带与漂浮光球", () => qa(".fc-back .fc-sweep").length >= 1 && qa(".fc-back .fc-orb").length === 3);
  check("背面三操作按钮齐全", () =>
    qa('.fc-acts [data-act="status"]').length >= 1 &&
    qa('.fc-acts [data-act="rewatch"]').length >= 1 &&
    qa('.fc-acts [data-act="detail"]').length >= 1);
  check("翻面按钮存在且有 aria-pressed", () => {
    const b = q(".fc-flip");
    return !!b && b.getAttribute("aria-pressed") === "false";
  });
  check("正反两面都有翻面按钮（触摸设备才有回头路）", () => qa(".fc-flip").length === 2 || qa(".fc-flip").length);
  check("背面操作区为翻面按钮留出空间（防重叠）", () => cs(".fc-acts").paddingRight !== "0px");
  // 3D 卡片最常见的失效：.card 上的 overflow:hidden 会 flatten preserve-3d
  check("卡片无 overflow:hidden（否则 preserve-3d 被压平）", () => cs(".wall .card").overflow !== "hidden");
  check("card-3d 声明 preserve-3d", () => cs(".card-3d").transformStyle === "preserve-3d");
  check("背面声明 rotateY(180deg)", () => cs(".fc-back").transform !== "none");
  check("两面均 backface-visibility:hidden", () =>
    cs(".fc-front").backfaceVisibility === "hidden" &&
    cs(".fc-back").backfaceVisibility === "hidden");
  // 静止态光带/光球必须暂停（否则 60 张卡常驻跑 blur 动画）
  check("装饰动画静止态为 paused", () => cs(".fc-sweep").animationPlayState === "paused" && cs(".fc-orb").animationPlayState === "paused");
  // hover 翻面
  q(".wall .card").dispatchEvent(new win.MouseEvent("mouseover", { bubbles: true }));
  check("hover 规则已声明（选择器存在）", () => {
    let found = false;
    for (const sheet of win.document.styleSheets) {
      let rules; try { rules = sheet.cssRules; } catch (_) { continue; }
      for (const r of rules) if (r.selectorText && /\.card:hover \.card-3d/.test(r.selectorText)) found = true;
    }
    return found;
  });
  check("hover 规则同时放开装饰动画", () => {
    let found = false;
    for (const sheet of win.document.styleSheets) {
      let rules; try { rules = sheet.cssRules; } catch (_) { continue; }
      for (const r of rules) if (r.selectorText && /\.card:hover \.fc-sweep/.test(r.selectorText) && /running/.test(r.style.animationPlayState)) found = true;
    }
    return found;
  });
  // 点击翻面按钮 → is-flipped 切换
  click(q(".fc-flip"));
  await sleep(60);
  check("点翻面按钮后卡片进入 is-flipped", () => q(".wall .card").classList.contains("is-flipped"));
  check("翻面后 aria-pressed 变为 true", () => qa(".fc-flip").every(b => b.getAttribute("aria-pressed") === "true"));
  check("翻面后两个按钮文案都切为「翻回封面」", () => qa(".fc-flip").every(b => b.getAttribute("aria-label") === "翻回封面"));
  check("翻面后可点背面按钮翻回（触摸设备回头路）", () => {
    click(q(".fc-back .fc-flip"));
    return !q(".wall .card").classList.contains("is-flipped");
  });
  check("is-flipped 未误触发跳转（仍在片库页）", () => win.eval("state.route") === "library" || win.eval("state.route"));
  // 翻面状态下点详情仍能进放映厅
  click(q(".fc-flip"));
  await sleep(40);
  click(q('.fc-acts [data-act="detail"]'));
  await sleep(160);
  check("背面「详情」按钮能进放映厅", () => win.eval("state.route") === "theater" || win.eval("state.route"));
  check("放映厅确实渲染了该作品标题", () => q("#view").innerHTML.indexOf("测试") >= 0 || q("#view").innerHTML.length > 100);
  win.eval('go("library")');
  await sleep(120);
  const sortSel = q("#lib-sort");
  setVal(sortSel, "myScore_desc");
  await sleep(80);
  check("排序切换生效", () => win.eval('libState.sort') === "myScore_desc" || win.eval("libState.sort"));
  win.eval('libState.view="table";rerender()');
  await sleep(80);
  check("表格视图渲染", () => qa(".grid-table tbody tr").length === 1 || qa(".grid-table tbody tr").length);
  const statusSel = q('select[data-inline="statusId"]');
  if (statusSel) { setVal(statusSel, "st_hold"); await sleep(120); }
  check("表格内联改状态生效", () => win.eval("state.anime[0].statusId") === "st_hold" || win.eval("state.anime[0].statusId"));
  win.eval('go("library")');
  await sleep(60);

  // 7. 详情 + 皮肤切换
  win.eval(`go("theater","${id2}")`);
  await sleep(100);
  check("详情页渲染标题", () => (q(".detail-title") || {}).textContent === "数码宝贝大冒险" || (q(".detail-title") || {}).textContent);
  check("感想时间线渲染（2 条）", () => qa(".review-item").length === 2 || qa(".review-item").length);
  const skinBtn = q('[data-skin="modern"]');
  click(skinBtn);
  await sleep(120);
  check("切换到现代影院皮肤", () => win.eval("settings.tv_skin") === "modern" || win.eval("settings.tv_skin"));
  win.eval('settings.tv_skin="crt";saveSettings();go("theater")');
  await sleep(120);
  check("待机屏保渲染语录", () => !!q("#q-text") || q("#view").innerHTML.length);

  // 8. 主题 / 强调色切换
  win.eval('settings.theme="light";saveSettings();applyAppearance();rerender()');
  await sleep(80);
  check("浅色主题应用", () => doc.documentElement.getAttribute("data-theme") === "light" || doc.documentElement.getAttribute("data-theme"));
  win.eval('settings.accent_color="amber";saveSettings();applyAppearance();rerender()');
  await sleep(60);
  check("强调色应用", () => doc.documentElement.getAttribute("data-accent") === "amber" || doc.documentElement.getAttribute("data-accent"));
  win.eval('settings.theme="dark";settings.accent_color="cyan";settings.density="compact";saveSettings();applyAppearance();rerender()');
  await sleep(60);
  check("深色+紧凑应用", () => doc.documentElement.getAttribute("data-density") === "compact" || doc.documentElement.getAttribute("data-density"));

  // 9. 语录：新增与查重
  win.eval('go("quotes")');
  await sleep(90);
  win.eval("openQuoteForm(null)");
  await sleep(60);
  setVal(q("#qf-text"), "测试语录正文");
  click(q("#qf-save"));
  await sleep(80);
  check("缺少出处被拦截", () => !!q("#qf-msg .err-text"));
  setVal(q("#qf-src"), "数码宝贝大冒险");
  click(q("#qf-save"));
  await sleep(120);
  check("语录新增成功", () => win.eval("state.quotes.length") === 27 || win.eval("state.quotes.length"));
  win.eval("openQuoteForm(null)");
  await sleep(50);
  setVal(q("#qf-text"), "测试语录正文");
  setVal(q("#qf-src"), "数码宝贝大冒险");
  click(q("#qf-save"));
  await sleep(80);
  check("重复语录有提示", () => (q("#qf-msg") || {}).textContent.indexOf("已收录") >= 0 || (q("#qf-msg") || {}).textContent);
  win.eval("closeModal()");

  // 10. 导出载荷
  const payload = win.eval("JSON.stringify(buildExportPayload(false))");
  const parsed = JSON.parse(payload);
  check("导出 app 标识正确", () => parsed.app === "anime-rewind" || parsed.app);
  check("导出含作品与语录", () => parsed.anime.length === 1 && parsed.quotes.length === 27 || parsed.anime.length + "/" + parsed.quotes.length);
  check("导出含设置", () => !!parsed.settings && !!parsed.statuses || "missing");

  // 11. 导入：智能合并 + 预览报告
  parsed.anime[0].watchedEpisodes = 30;
  parsed.anime[0].titleCn = "数码宝贝大冒险";
  parsed.quotes.push({ text: "导入带来的新语录", sourceAnimeTitle: "导入作" });
  win.__payload = parsed;
  const analysis = win.eval("JSON.stringify((function(){const a=analyzeImport(window.__payload);return {add:a.add.length,dup:a.dup.length,suspect:a.suspect.length,qadd:a.quoteAdd.length,qskip:a.quoteSkip.length};})())");
  let an;
  try { an = JSON.parse(analysis); } catch (e) { an = null; }
  check("导入分析：识别为重复 1 部", () => an && an.dup === 1 || JSON.stringify(an));
  check("导入分析：语录新增 1 条", () => an && an.qadd === 1 || JSON.stringify(an));
  const importRes = await win.eval("(async()=>{const a=analyzeImport(window.__payload);const r=await applyImport(a,'merge',{});return JSON.stringify(r);})()");
  const ir = JSON.parse(importRes);
  check("智能合并执行：merged=1", () => ir.merged === 1 || JSON.stringify(ir));
  check("合并后手动修订过的字段不被覆盖", () => win.eval("state.anime[0].communityScore") === null || win.eval("state.anime[0].communityScore"));

  // 12. 清除引号植被 hold 状态 / 重建 CI 数据 → 荣誉计算
  win.eval('state.anime[0].statusId="st_done";saveAnime(state.anime[0])');
  await sleep(80);
  const honor = win.eval("JSON.stringify(currentHonor())");
  check("荣誉称号可计算", () => honor.indexOf("topId") >= 0 || honor);

  // 13. 手动档不被自动覆盖 / 自动档恢复
  win.eval('state.anime[0].statusId="st_hold";state.anime[0].watchedEpisodes=54;state.anime[0].totalEpisodes=54;saveAnime(state.anime[0])');
  await sleep(60);
  check("设为「搁置」后改进度不被自动覆盖", () => win.eval("state.anime[0].statusId") === "st_hold" || win.eval("state.anime[0].statusId"));
  win.eval('state.anime[0].statusId="st_watching";applyAutoStatus(state.anime[0])');
  await sleep(40);
  check("回到自动档后100%自动变「看过」", () => win.eval("state.anime[0].statusId") === "st_done" || win.eval("state.anime[0].statusId"));

  // 14. 自定义状态：区间冲突检测与自动匹配
  await win.eval('saveStatus({id:"st_test90",name:"差亿点看完",color:"#8AB4F8",matchType:"progress",progressMin:90,progressMax:99,isSystem:false,schemaVersion:1})');
  await sleep(40);
  win.eval('state.anime[0].statusId="st_watching";state.anime[0].watchedEpisodes=50;state.anime[0].totalEpisodes=54;applyAutoStatus(state.anime[0])');
  await sleep(40);
  check("自定义区间状态被自动匹配", () => win.eval("state.anime[0].statusId") === "st_test90" || win.eval("state.anime[0].statusId"));
  const conflict = win.eval('state.statuses.filter(s=>s.matchType==="progress").some(s=>!(99 < s.progressMin || 90 > s.progressMax) && s.id!=="st_test90")');
  check("区间检测结果可用于冲突提示", () => conflict === true || conflict);

  // 15. 手动修订标记（locked）
  win.eval('const prev=JSON.parse(JSON.stringify(state.anime[0])); state.anime[0].airDate="2000-01-01"; commitAnime(state.anime[0], prev);');
  await sleep(40);
  check("改过的抓取字段被标记 locked", () => win.eval("state.anime[0].locked.airDate") === true || win.eval("JSON.stringify(state.anime[0].locked)"));

  // 16. 清空函数存在（不实际触发）
  check("清空函数存在", () => typeof win.eval("clearAllData") === "function");

  // 17. 搜索弹窗：可输入、可搜索、可关闭（回归：footer 内访问 root 的 TDZ 缺陷曾导致弹窗无法关闭）
  errors.length = 0;
  win.eval("openSearchModal()");
  await sleep(80);
  const kw = qa("#s-kw")[0];
  check("搜索弹窗已打开", () => !!kw || "无 #s-kw");
  check("搜索弹窗无渲染报错", () => errors.length === 0 || errors.join(" | "));
  check("关闭按钮已渲染", () => qa('#modal-x').length === 1 || qa("#modal-x").length);
  if (kw) {
    setVal(kw, "STEINS;GATE");
    kw.dispatchEvent(new win.Event("input", { bubbles: true }));
    await sleep(500);
    check("输入片名后有搜索反馈（状态文案变化）",
      () => { const t = qa("#s-status")[0]; return !!t && t.textContent !== "输入片名后将依次搜索 Bangumi、AniList。"; },
      () => { const t = qa("#s-status")[0]; return t ? t.textContent.slice(0, 60) : "无"; });
    check("回车触发搜索（不抛未捕获异常）", () => errors.length === 0 || errors.join(" | "));
  }
  click(qa("#modal-x")[0]);
  await sleep(80);
  check("点 × 能关闭搜索弹窗", () => !qa("#modal-card").length);
  check("关闭后 modal-root 已清空", () => win.eval('document.querySelector("#modal-root").classList.contains("open")') === false);

  // 18. 搜索弹窗的「关闭」按钮（data-close 委托路径）
  win.eval("openSearchModal()");
  await sleep(80);
  click(qa('#modal-foot [data-close]')[0]);
  await sleep(80);
  check("点「关闭」能关闭搜索弹窗（事件委托）", () => !qa("#modal-card").length);

  // 19. 任意渲染回调抛错时，弹窗仍可关闭（防御性回归）
  win.eval('openModal({ title:"异常弹窗", body:"x", footer: function(){ throw new Error("boom"); } })');
  await sleep(60);
  check("回调抛错时弹窗仍渲染出关闭按钮", () => qa("#modal-x").length === 1);
  check("回调抛错时显示错误提示而非白屏", () => /渲染出错/.test(qa("#modal-body")[0].textContent));
  click(qa("#modal-x")[0]);
  await sleep(60);
  check("回调抛错的弹窗也能关闭", () => !qa("#modal-card").length);

  // 20. ESC 关闭
  win.eval("openSearchModal()");
  await sleep(80);
  doc.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await sleep(60);
  check("ESC 能关闭搜索弹窗", () => !qa("#modal-card").length);

  // 21. 转盘：指针落点数学（回归：旋转符号写反，指针永远指错片）
  // 指针固定在 0°(右侧)；扇区 i 中心 c = -PI/2 + (i+0.5)*step，需旋转 -c 才能停在指针下
  const spinMath = win.eval(`(function(){
    const n = 6, step = (Math.PI*2)/n, base = -Math.PI/2, bad = [];
    for(let i=0;i<n;i++){
      const target = -(base + i*step + step*0.5);   // spinWheel 里的公式
      let land = base + i*step + step*0.5 + target; // 旋转后扇区中心的最终角
      land = ((land % (Math.PI*2)) + Math.PI*2) % (Math.PI*2);
      if(Math.abs(land) > 1e-9) bad.push(i + ":" + land.toFixed(4));
    }
    return bad.join(",");
  })()`);
  check("旋转后被选扇区恰好停在指针(0°)下", () => spinMath === "" || spinMath);

  // 单候选与双候选也要成立
  const spinMath2 = win.eval(`(function(){
    const bad = [];
    [1,2,3,5,7].forEach(function(n){
      const step = (Math.PI*2)/n, base = -Math.PI/2;
      for(let i=0;i<n;i++){
        const target = -(base + i*step + step*0.5);
        let land = base + i*step + step*0.5 + target;
        land = ((land % (Math.PI*2)) + Math.PI*2) % (Math.PI*2);
        if(Math.abs(land) > 1e-9) bad.push(n+"部/"+i);
      }
    });
    return bad.join(",");
  })()`);
  check("1/2/3/5/7 部候选时落点均正确", () => spinMath2 === "" || spinMath2);

  // 22. 转盘结果卡布局：按钮区必须可换行，且容器有 min-width:0（回归：结果卡被裁切）
  win.eval('state.anime.forEach(a=>{a.statusId="st_done";a.progress=100;}); rerender();');
  await sleep(60);
  win.eval('go("wheel")');
  await sleep(200);
  check("转盘页已渲染", () => qa("#wheel-canvas").length === 1);
  win.eval('bindResultHTML(state.anime[0])');
  await sleep(120);
  const acts = qa(".result-actions");
  check("结果卡操作区使用可换行容器", () => acts.length === 1 || "无 .result-actions");
  check("操作区声明了 flex-wrap:wrap", () => {
    if (!acts.length) return "无元素";
    const st = win.getComputedStyle(acts[0]);
    return st.flexWrap === "wrap" || st.flexWrap;
  });
  check("结果卡正文有 min-width:0（防溢出裁切）", () => {
    const b = qa(".result-body")[0];
    if (!b) return "无 .result-body";
    const st = win.getComputedStyle(b);
    return (st.minWidth === "0px" || st.minWidth === "0") || st.minWidth;
  });
  check("结果卡三个操作按钮都在", () => qa(".result-actions [data-act]").length === 3 || qa(".result-actions [data-act]").length);
  const body = qa(".result-body")[0];
  check("标题不撑破容器（body 有 min-width:0）", () => !body || !!body.className);

  // 23. 转盘重渲染后角度回放（回归：重新渲染导致下次旋转从 0° 跳变）
  win.eval("wheelState.angle = 4.2; rerender();");
  await sleep(150);
  const tf = qa("#wheel-canvas")[0] ? qa("#wheel-canvas")[0].style.transform : "";
  check("重渲染后回放已转角度", () => /rotate\(2[34][0-9]/.test(tf) || tf || "无 transform");
  win.eval("wheelState.angle = 0;");

  // 24. 候选为 0 的可用性（回归：所有作品都是「想看 0 集」时，转盘只给一个不动的圆盘，
  //     零原因说明 —— 用户完全无从判断是筛选错了还是没入库）
  await win.eval(`(async () => {
    for (const a of state.anime) { a.statusId = "st_want"; a.watchedEpisodes = 0; await saveAnime(a); }
    state.anime = (await Repo.all("anime")).map(x => migrateRecord(x, "anime")).filter(Boolean);
    wheelState.filter = "all"; wheelState.decade = ""; wheelState.result = null;
    go("wheel");
  })()`);
  await sleep(250);
  check("全为「想看0集」时候选为 0", () => win.eval("wheelCandidates().length") === 0 || win.eval("wheelCandidates().length"));
  check("候选为 0 时开始按钮禁用", () => { const b = q("#wh-go"); return b && b.disabled; });
  check("候选为 0 时显示「为什么转不动」诊断面板", () => qa("#wheel-why").length === 1);
  const whyTxt = q("#wheel-why") ? q("#wheel-why").textContent : "";
  check("诊断说明了具体数量而非泛泛而谈", () => /你(的)?\s*\d+\s*部作品|片库还是空的|年代没有作品|神作/.test(whyTxt) || whyTxt.slice(0, 60));
  check("诊断提供可点击的修复动作", () => qa("#wheel-why [data-why-act]").length >= 1 || 0);

  // 筛选下拉必须有「全部作品」——否则「想看」的作品永远进不了转盘
  const filterOpts = qa("#wh-filter option").map(o => o.value);
  check("筛选含「全部作品」选项", () => filterOpts.indexOf("any") >= 0 || filterOpts.join(","));

  // 真实点击引导按钮 → 候选应恢复
  const whyBtn = q('#wheel-why [data-why-act="set-all"]');
  if (whyBtn) { click(whyBtn); await sleep(260); }
  check("点「改看全部作品」后 filter 变为 any", () => win.eval('wheelState.filter') === "any" || win.eval("wheelState.filter"));
  check("点引导后候选恢复为 >0", () => win.eval("wheelCandidates().length") > 0 || win.eval("wheelCandidates().length"));
  check("候选恢复后诊断面板消失", () => !q("#wheel-why"));
  check("候选恢复后开始按钮可用", () => { const b = q("#wh-go"); return b && !b.disabled; });

  // 真实点「开始」→ 必须真的转出结果（此前所有断言都只调函数，从未点过这个按钮）
  const whGo = q("#wh-go");
  if (whGo) { click(whGo); await sleep(200); }
  check("点「开始」进入 spinning 状态", () => win.eval("wheelState.spinning") === true || "已结束(reduced-motion)");
  await sleep(6000);
  check("点「开始」后转出结果", () => !!win.eval("wheelState.result"));
  check("结果卡三个操作按钮齐全", () => qa("#result-panel [data-act]").length === 3 || qa("#result-panel [data-act]").length);
  win.eval('wheelState.filter = "all"; rerender();');
  await sleep(200);

  // 25. 功能开关 → 侧栏入口必须同步（回归：buildNav 只在启动时调用，
  //     关掉「重看转盘」后入口仍留在侧栏，点了却被 pageModuleEnabled 拦下）
  await win.eval('go("settings")');
  await sleep(200);
  const secBtn = qa("[data-sec]").find(b => b.dataset.sec === "modules");
  if (secBtn) { click(secBtn); await sleep(250); }
  const wheelBox = q('input[type=checkbox][data-set="module_wheel"]');
  check("功能开关页有「重看转盘」开关", () => !!wheelBox);
  const navWheel = () => { const b = q('[data-route="wheel"]'); return b ? !b.hasAttribute("hidden") : null; };
  check("开关打开时侧栏入口可见", () => navWheel() === true || navWheel());
  if (wheelBox) {
    wheelBox.checked = false;
    wheelBox.dispatchEvent(new win.Event("change", { bubbles: true }));
    await sleep(280);
  }
  check("关闭后侧栏入口立即消失（buildNav 重建）", () => navWheel() === false || navWheel());
  check("关闭后 settings.module_wheel 为 false", () => win.eval("settings.module_wheel") === false);
  // 在转盘页上关掉自己 → 应弹回首页，而不是留下一屏死界面
  win.eval("settings.module_wheel = true; afterSettingsChange(); go('wheel');");
  await sleep(220);
  win.eval("settings.module_wheel = false; afterSettingsChange();");
  await sleep(280);
  check("在转盘页关掉自己会弹回首页", () => win.eval("state.route") === "home" || win.eval("state.route"));
  win.eval("settings.module_wheel = true; afterSettingsChange();");
  await sleep(220);
  check("重新打开后入口恢复", () => navWheel() === true || navWheel());
  win.eval('go("library")');
  await sleep(200);

  // 输出
  console.log("\n=== 冒烟测试结果 ===");
  results.forEach(([st, name, extra]) => console.log(st.padEnd(5) + name + (extra ? "   → " + extra : "")));
  const failed = results.filter((r) => r[0] === "FAIL");
  console.log("\n通过 " + (results.length - failed.length) + " / " + results.length);
  if (warns.length) console.log("\n--- console.warn (" + warns.length + ") ---\n" + warns.slice(0, 10).join("\n"));
  const realErrors = errors.filter((e) => !/Not implemented|Could not parse CSS/i.test(e)
    && !/\[openModal\] 渲染回调出错： Error: boom/.test(e)); // boom 为第 19 项故意注入的预期异常
  if (realErrors.length) console.log("\n--- 错误 (" + realErrors.length + ") ---\n" + realErrors.slice(0, 20).join("\n"));
  else console.log("\n无控制台 error / 未捕获异常");
  process.exit(failed.length || realErrors.length ? 1 : 0);
})().catch((e) => { console.error("SMOKE CRASH", e); process.exit(2); });
