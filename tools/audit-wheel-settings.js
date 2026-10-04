// 设置 → 转盘 联动审计：逐项切换每个设置，检查转盘是否仍可用
const fs = require("fs");
const { JSDOM, VirtualConsole } = require("jsdom");

const FILE = "D:/env/projects/Anime_Rewind/anime-rewind.html";
const sleep = ms => new Promise(r => setTimeout(r, ms));

function boot() {
  const errs = [];
  const vc = new VirtualConsole();
  vc.on("jsdomError", e => { if (!/Not implemented|Could not parse CSS/i.test(String(e.message))) errs.push(String(e.message).slice(0,150)); });
  const dom = new JSDOM(fs.readFileSync(FILE, "utf8"), {
    runScripts: "dangerously", pretendToBeVisual: true, url: "https://local.test/", virtualConsole: vc
  });
  return { win: dom.window, doc: dom.window.document, errs };
}

async function seed(win, statuses) {
  await win.eval(`(async () => {
    const titles = ["星际牛仔","猫眼三姐妹","灌篮高手","交响乐篇","EVA 新世纪","幽灵 Hunter"];
    for (let i=0;i<titles.length;i++){
      await saveAnime({
        id:"t"+i, titleCn:titles[i], titleOriginal:"Original "+i,
        statusId:"st_done", watchedEpisodes:12, totalEpisodes:12,
        airDate:(2000+i*2)+"-04-01", watchYear:2005+i, myScore:8, genres:["科幻"],
        coverUrl:"", rewatchCount:0, reviews:[], createdAt:new Date().toISOString()
      });
    }
    state.anime = (await Repo.all("anime")).map(a => migrateRecord(a,"anime")).filter(Boolean);
    state.statuses = (await Repo.all("statuses")).map(s => migrateRecord(s,"status")).filter(Boolean);
    if(!state.statuses.length) state.statuses = SYSTEM_STATUSES.slice();
    return 1;
  })()`);
  if (statuses) await win.eval("state.statuses = " + JSON.stringify(statuses) + ";");
}

// 关键：真实点「开始」，等动画结束，看是否出结果
async function trySpin(win) {
  const doc = win.document;
  await win.eval('go("wheel")');
  await sleep(250);
  const btn = doc.querySelector("#wh-go");
  const canvas = doc.querySelector("#wheel-canvas");
  const wrap = doc.querySelector(".wheel-wrap");
  const rep = {
    navVisible: !!doc.querySelector('[data-route="wheel"]:not([hidden])'),
    canvasExists: !!canvas,
    wrapW: wrap ? wrap.getBoundingClientRect().width : 0,
    btnExists: !!btn,
    btnDisabled: btn ? btn.disabled : null,
    cands: win.eval("wheelCandidates().length"),
  };
  if (!btn || btn.disabled) { rep.spun = false; rep.reason = "按钮缺失或禁用"; return rep; }
  btn.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
  await sleep(200);
  rep.startedSpinning = win.eval("wheelState.spinning");
  await sleep(6000);
  rep.spun = win.eval("!!wheelState.result");
  rep.resultTitle = win.eval("wheelState.result ? wheelState.result.titleCn : null");
  rep.resultBtns = doc.querySelectorAll("#result-panel [data-act]").length;
  return rep;
}

const SETTINGS_TO_TEST = [
  ["module_wheel", false, "关闭「重看转盘」"],
  ["module_charts", false, "关闭统计图表"],
  ["module_chronicle", false, "关闭童年编年史"],
  ["module_quotes", false, "关闭语录模块"],
  ["status_auto_match", false, "关闭集数自动匹配状态"],
  ["theme", "light", "切到浅色主题"],
  ["theme", "glass", "切到玻璃主题"],
  ["accent_color", "amber", "强调色改琥珀"],
  ["density", "compact", "密度改紧凑"],
  ["default_view", "table", "默认视图改表格"],
  ["episode_minutes", 30, "单集时长 30"],
  ["search_limit", 3, "搜索条数 3"],
  ["bg_blur", 20, "背景模糊 20"],
  ["bg_overlay", 0.8, "背景遮罩 0.8"],
  ["panel_opacity", 0.4, "面板不透明度 0.4"],
  ["tv_skin", "modern", "放映厅改现代"],
];

(async () => {
  console.log("=== A. 基线（默认设置）===");
  {
    const { win, errs } = boot(); await sleep(600); await seed(win);
    const r = await trySpin(win);
    console.log(JSON.stringify(r));
    if (errs.length) console.log("  错误:", errs.slice(0,2));
  }

  console.log("\n=== B. 逐项设置后转盘是否仍可用 ===");
  for (const [key, val, desc] of SETTINGS_TO_TEST) {
    const { win, errs } = boot(); await sleep(600); await seed(win);
    await win.eval(`settings[${JSON.stringify(key)}] = ${JSON.stringify(val)}; saveSettings(); rerender();`);
    await sleep(150);
    const r = await trySpin(win);
    const bad = !r.spun || !r.navVisible || r.cands === 0;
    console.log(
      (bad ? "✗ 失效  " : "✓ 正常  ") + desc.padEnd(22) +
      " nav=" + (r.navVisible ? "显" : "隐") +
      " 候选=" + r.cands +
      " 按钮=" + (r.btnDisabled ? "禁用" : "可用") +
      " 结果=" + (r.spun ? r.resultTitle : "无") +
      (errs.length ? "  ERR:" + errs[0].slice(0,60) : "")
    );
  }

  console.log("\n=== C. 自定义状态被改名/改区间后 ===");
  {
    const { win, errs } = boot(); await sleep(600); await seed(win);
    // 用户把「看过」改名为「看完」，ID 不变
    await win.eval('state.statuses.find(s=>s.id==="st_done").name = "看完"; rerender();');
    const r1 = await trySpin(win);
    console.log((r1.spun ? "✓" : "✗") + " 系统状态改名        候选=" + r1.cands + " 结果=" + (r1.spun ? r1.resultTitle : "无"));
    // 用户删掉「看过」系统档（应不允许，但看是否崩）
    await win.eval('state.statuses = state.statuses.filter(s=>s.id!=="st_done"); rerender();');
    const r2 = await trySpin(win);
    console.log((r2.spun ? "✓" : "✗") + " 删除「看过」状态     候选=" + r2.cands + " 结果=" + (r2.spun ? r2.resultTitle : "无") + (errs.length ? "  ERR:" + errs[0].slice(0,70) : ""));
  }

  console.log("\n=== D. 候选为 0 的场景（全部作品为「想看」且 0 集）===");
  {
    const { win, errs } = boot(); await sleep(600);
    await win.eval(`(async () => {
      for (let i=0;i<3;i++) await saveAnime({
        id:"z"+i, titleCn:"想看片 "+i, titleOriginal:"", statusId:"st_want",
        watchedEpisodes:0, totalEpisodes:12, airDate:"2020-01-01", watchYear:null,
        myScore:null, genres:[], coverUrl:"", rewatchCount:0, reviews:[], createdAt:new Date().toISOString()
      });
      state.anime = (await Repo.all("anime")).map(a=>migrateRecord(a,"anime")).filter(Boolean);
      return 1;
    })()`);
    const r = await trySpin(win);
    console.log("候选=" + r.cands + " 按钮=" + (r.btnDisabled ? "禁用" : "可用") + " 结果=" + (r.spun ? r.resultTitle : "无"));
    const txt = win.document.querySelector("#view").textContent.replace(/\s+/g," ").trim();
    console.log("页面文案包含提示:", /没有候选作品|换一下筛选/.test(txt) ? "有" : "无");
    console.log("文案:", txt.slice(0, 200));
    if (errs.length) console.log("ERR:", errs.slice(0,2));
  }
  process.exit(0);
})();
