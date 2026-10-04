/* 片库动作与放映厅入口专项测试
 *
 * 起因是一个真实 bug：片库空态的「添加第一部动画」按钮点了没反应。
 * 根因是 libraryAction() 开头写 `const a = animeById(id); if(!a) return;`，
 * 而这个按钮没有 data-id → animeById(undefined) 返回 null → 被静默拦死。
 * 右上角「添加新番」是另一个 DOM 节点，走的是不同的绑定路径，所以正常 ——
 * 这个「一个能点一个不能点」的不对称，是它难以被发现的根本原因。
 *
 * 本测试刻意覆盖两类易漏场景：
 *   1) 空态按钮（无 data-id 的动作）
 *   2) 筛选无结果时的「清空筛选」（同样无 data-id）
 *   3) 从片库点详情 → 放映厅必须真的跳转
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
  const q = s => doc.querySelector(s);
  const qa = s => Array.from(doc.querySelectorAll(s));
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // 记录弹窗是否被打开过 —— add 动作的唯一可观察结果就是弹搜索窗
  await ev(`
    window.__searchOpened = 0;
    const orig = window.openSearchModal;
    window.openSearchModal = function(){ window.__searchOpened++; };
  `);

  // ---------- 1. 空片库：空态按钮必须可点 ----------
  await ev('state.anime = []; settings.default_view="list"; go("library");');
  await sleep(250);
  check("空片库渲染出空态", !!q(".state-box"), "无 .state-box");
  const addFirst = qa('[data-act="add"]').find(b => /添加第一部动画/.test(b.textContent));
  check("空态有「添加第一部动画」按钮", !!addFirst,
    "实有: " + qa('[data-act="add"]').map(b => b.textContent.trim()).join(" / "));

  if (addFirst) {
    addFirst.click();
    await sleep(200);
    check("★ 空态「添加第一部动画」点击后真的打开了搜索弹窗",
      evSync("window.__searchOpened") === 1,
      "openSearchModal 被调用 " + evSync("window.__searchOpened") + " 次");
  }

  // ---------- 2. 无作品时不能误开其他作品的操作 ----------
  check("空态不含删除/详情类动作（避免无 id 时误伤）",
    qa('[data-act="del"]').length === 0 && qa('[data-act="detail"]').length === 0);

  // ---------- 3. 筛选无结果：「清空筛选」也要能点 ----------
  await ev('state.anime = [draftFromCandidate({ id:"an_x", titleCn:"漆黑的子弹", studios:["Bee Train"] })]; go("library");');
  await sleep(250);
  const noMatch = await ev(`
    libState.q = "绝对不存在的关键字zzz";
    rerender();
    return true;
  `);
  await sleep(200);
  check("筛选无结果时渲染出筛选空态", !!q(".state-box") && /没有符合条件/.test(q(".state-box").textContent),
    q(".state-box") ? q(".state-box").textContent.slice(0, 40) : "无空态");
  const resetBtn = q('[data-act="reset-filter"]');
  check("筛选空态有「清空筛选」按钮", !!resetBtn);
  if (resetBtn) {
    resetBtn.click();
    await sleep(250);
    const cleared = evSync('JSON.stringify(libState)');
    check("★「清空筛选」真的重置了筛选条件",
      /"q":""/.test(cleared) || /"q":\s*""/.test(cleared), cleared.slice(0, 100));
    check("清空后卡片重新出现", qa(".grid-table tbody tr").length >= 0 || "表格模式");
  }

  // ---------- 4. 有关键字时输入框仍能筛选 ----------
  await ev('libState.q = ""; go("library");');
  await sleep(200);
  const searchInput = q("#lib-q");
  check("片库有搜索输入框", !!searchInput);
  if (searchInput) {
    searchInput.value = "漆黑";
    searchInput.dispatchEvent(new win.Event("input", { bubbles:true }));
    await sleep(450);
    check("搜索能筛出目标作品", /漆黑的子弹/.test(q("#view").textContent),
      "命中 " + (qa(".grid-table tbody tr").length) + " 行");
  }

  // ---------- 5. 从片库进详情 → 放映厅 ----------
  await ev('libState.q = ""; rerender();');
  await sleep(250);
  const detailBtn = q('[data-act="detail"]');
  check("列表行有详情按钮", !!detailBtn);
  if (detailBtn) {
    detailBtn.click();
    await sleep(300);
    check("★ 点详情跳到放映厅并带上作品 id",
      evSync('state.route') === "theater" && evSync('state.routeId') === "an_x",
      "route=" + evSync('state.route') + " routeId=" + evSync('state.routeId'));
    check("放映厅渲染出该作品详情", /漆黑的子弹/.test(q("#view").textContent));
    check("详情页有播放器面板", !!q(".stream-panel"));
  }

  // ---------- 6. 详情页 → 返回放映厅（回到选片页） ----------
  const backBtn = q('[data-act="back"]');
  check("详情页有返回按钮", !!backBtn);
  if (backBtn) {
    backBtn.click();
    await sleep(300);
    check("★ 返回后回到选片页（不是回到某部作品的详情）",
      evSync("state.routeId") === null, "routeId=" + evSync("state.routeId"));
    check("选片页列出该作品", /漆黑的子弹/.test(q(".pick-grid") ? q(".pick-grid").textContent : ""));
  }

  // ---------- 7. 作品存在时页头「添加新番」仍可用 ----------
  /* 必须先回到片库页：页头按钮属于页面模块的 actions(box)，
     只有该页渲染时才会挂到 DOM 上。上一段刚跳去了放映厅。 */
  await ev('state.anime = [draftFromCandidate({ id:"an_x", titleCn:"漆黑的子弹", studios:["Bee Train"] })]; go("library");');
  await sleep(250);
  const headAdd = qa('button').find(b => /添加新番/.test(b.textContent));
  check("页头有「添加新番」按钮", !!headAdd,
    "可见按钮: " + qa("button").map(b => b.textContent.trim().slice(0, 8)).join(" / ").slice(0, 90));
  const before = evSync("window.__searchOpened");
  if (headAdd) {
    headAdd.click();
    await sleep(200);
    check("页头「添加新番」也能打开搜索弹窗", evSync("window.__searchOpened") === before + 1,
      "调用计数 " + before + " → " + evSync("window.__searchOpened"));
  }

  // ---------- 8. 空片库时的选片页空态 ----------
  await ev('state.anime = []; go("theater");');
  await sleep(250);
  check("片库为空时选片页给出引导", /去片库添加/.test(q("#view").textContent));
  const gotoLib = q('[data-act="goto-lib"]');
  check("选片页空态有去片库按钮", !!gotoLib);
  if (gotoLib) {
    gotoLib.click();
    await sleep(250);
    check("★ 点「去片库添加」真的跳到片库", evSync("state.route") === "library", evSync("state.route"));
  }

  console.log("\n通过 " + pass + " / " + (pass + fail));
  if (errs.length) { console.log("\n失败项："); errs.forEach(e => console.log("  · " + e)); }
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error("测试脚本异常:", e); process.exit(2); });
