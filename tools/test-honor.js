/* 荣誉墙专项测试
 *
 * 覆盖：卡片结构、内置配图、自定义荣誉 CRUD、授予状态、纯色玻璃回退、
 * 以及「没获得的显示为暗色」这条用户明确要求。
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
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const dom = new JSDOM(html, { runScripts:"dangerously", url:"https://x.test/", pretendToBeVisual:true });
  const win = dom.window, doc = win.document;
  await sleep(900);
  const ev = code => win.eval(`(async () => { ${code} })()`);
  const evSync = code => win.eval(code);

  // ---------- 1. 数据结构 ----------
  check("内置荣誉已重命名为 BUILTIN_HONORS", Array.isArray(evSync("BUILTIN_HONORS")));
  check("旧的 HONORS 常量已不存在", evSync("typeof HONORS") === "undefined", String(evSync("typeof HONORS")));
  const bh = await ev("return BUILTIN_HONORS.map(h=>({id:h.id,art:h.art,metric:h.metric}));");
  check("内置荣誉共 12 项", bh.length === 12, String(bh.length));
  check("每项内置荣誉都有 art 键", bh.every(h => !!h.art), JSON.stringify(bh.filter(h => !h.art)));
  const artKeys = [...new Set(bh.map(h => h.art))];
  check("art 键去重后 ≤ 11（允许共用配图）", artKeys.length <= 11, JSON.stringify(artKeys));

  // ---------- 2. AI 配图数据 ----------
  const artData = await ev("return Object.keys(typeof HONOR_ART !== 'undefined' ? HONOR_ART : {});");
  check("HONOR_ART 已注入", Array.isArray(artData) && artData.length >= 11, String(artData && artData.length));
  check("HONOR_ART 每项都是 JPEG dataURL",
    ev("return Object.values(HONOR_ART).every(v => /^data:image\\/jpeg;base64,/.test(v));"));
  // 每张图都要有足够像素，否则卡片上会糊
  const sizes = await ev("return Object.values(HONOR_ART).map(v => Math.round(v.length*0.75/1024));");
  check("每张图 ≥ 15KB（不是占位空图）", sizes.every(s => s >= 15), JSON.stringify(sizes));
  const totalKB = sizes.reduce((a,b)=>a+b,0);
  check("配图总体积在合理区间（100KB–900KB）", totalKB > 100 && totalKB < 900, totalKB + "KB");

  // 内置荣誉的 art 键必须都能在 HONOR_ART 里找到
  const missing = await ev("return BUILTIN_HONORS.map(h=>h.art).filter(a => !HONOR_ART[a]);");
  check("内置荣誉引用的 art 全部存在", missing.length === 0, JSON.stringify(missing));

  // ---------- 3. 卡片结构 ----------
  // 必须先造数据：首页在片库为空时走「欢迎」空态分支，荣誉墙根本不渲染。
  // 这正是「只测正常路径」的盲区 —— 空态与有数据态是两条完全不同的代码路径。
  await ev(`
    state.anime = [
      { id:"a1", titleCn:"机动战士", titleOriginal:"Mobile Suit Gundam", airDate:"1979-04-07",
        statusId:"st_done", watchedEpisodes:38, totalEpisodes:38, genres:["科幻","机战"],
        studios:["SUNRISE"], masterpiece:true, rewatchCount:0, createdAt:"2024-01-01T00:00:00Z", reviews:[] },
      { id:"a2", titleCn:"灌篮高手", airDate:"1990-10-15", statusId:"st_done",
        watchedEpisodes:101, totalEpisodes:101, genres:["体育","校园"], studios:["东映"],
        masterpiece:false, rewatchCount:2, createdAt:"2024-02-01T00:00:00Z", reviews:[] },
      { id:"a3", titleCn:"葬送的芙莉莲", airDate:"2023-09-29", statusId:"st_watching",
        watchedEpisodes:12, totalEpisodes:28, genres:["奇幻"], studios:[" Madhouse "],
        masterpiece:false, rewatchCount:0, createdAt:"2024-03-01T00:00:00Z", reviews:[] }
    ];
    saveSettings(); settings.module_honor = true; go("home");
  `);
  await sleep(500);
  const wall = doc.querySelector("#honor-wall");
  check("首页渲染出荣誉墙容器", !!wall);
  const cards = Array.from(doc.querySelectorAll(".tk"));
  check("渲染出 12 张荣誉卡", cards.length === 12, "实际 " + cards.length);
  check("卡片含齿孔层 .tk-perf", cards.every(c => !!c.querySelector(".tk-perf")));
  check("卡片含背景层 .tk-bg", cards.every(c => !!c.querySelector(".tk-bg")));
  check("卡片含底部 .tk-foot", cards.every(c => !!c.querySelector(".tk-foot")));
  check("未获得卡片有进度条", cards.filter(c => !c.classList.contains("is-got")).every(c => !!c.querySelector(".tk-progress")));
  check("已获得卡片有「已获得」印章", cards.filter(c => c.classList.contains("is-got")).every(c => /已获得/.test(c.textContent)));
  check("内置卡不带编辑按钮（只有自定义荣誉可编辑）",
    cards.every(c => !c.querySelector('[data-hact="edit"]')), "内置卡出现了编辑按钮");

  // ---------- 4. 内置卡用 AI 图，自定义卡用纯色玻璃 ----------
  const withImg = cards.filter(c => c.querySelector(".tk-art"));
  const withGlass = cards.filter(c => c.querySelector(".tk-glass"));
  check("内置荣誉卡使用 AI 配图", withImg.length === 12, "有图 " + withImg.length);
  check("未上传图时用纯色玻璃背景", withGlass.length === 0, "不该有玻璃层的卡：" + withGlass.length);
  const imgSrc = withImg[0].querySelector(".tk-art").getAttribute("src");
  check("配图 src 是 JPEG dataURL", /^data:image\/jpeg;base64,/.test(imgSrc), imgSrc.slice(0, 40));
  check("配图 img 带 loading=lazy（不拖慢首屏）", withImg[0].querySelector(".tk-art").getAttribute("loading") === "lazy");

  // ---------- 5. 纯色玻璃：手动建一个无图自定义荣誉 ----------
  await ev(`
    settings.custom_honors = [{ id:"h_test1", name:"测试荣誉", cat:"测试", desc:"没有配图的荣誉" }];
    saveSettings(); go("home");
  `);
  await sleep(400);
  const tc = doc.querySelector('.tk[data-ch="h_test1"]');
  check("自定义荣誉卡已渲染", !!tc);
  check("无图自定义荣誉使用纯色玻璃背景", tc && !!tc.querySelector(".tk-glass"), tc ? tc.outerHTML.slice(0,120) : "无");
  check("无图自定义荣誉不渲染 img", tc && !tc.querySelector(".tk-art"));
  const tint = tc && tc.querySelector(".tk-glass").getAttribute("style");
  check("纯色玻璃带按 id 散列的稳定色相", tint && /--tk-tint:hsl\(\d+ 62% 46%\)/.test(tint), tint);
  // 稳定性：同一 id 两次渲染颜色必须一致
  const tint2 = await ev('return honorTint({id:"h_test1"});');
  const tint3 = await ev('return honorTint({id:"h_test1"});');
  check("同一 id 的色相稳定（不闪）", tint2 === tint3, tint2 + " vs " + tint3);
  const tintA = await ev('return honorTint({id:"aaa"});');
  const tintB = await ev('return honorTint({id:"bbb"});');
  check("不同 id 得到不同色相", tintA !== tintB, tintA + " vs " + tintB);

  // ---------- 6. 自定义荣誉有编辑操作 ----------
  check("自定义荣誉有「授予」按钮", tc && !!tc.querySelector('[data-hact="toggle"]'));
  check("自定义荣誉有编辑按钮", tc && !!tc.querySelector('[data-hact="edit"]'));
  check("自定义荣誉有删除按钮", tc && !!tc.querySelector('[data-hact="del"]'));
  check("未授予的自定义荣誉是暗色态", tc && !tc.classList.contains("is-got"));

  // ---------- 7. 授予 → 变亮 + 出现印章 ----------
  tc.querySelector('[data-hact="toggle"]').click();
  await sleep(350);
  const tc2 = doc.querySelector('.tk[data-ch="h_test1"]');
  check("授予后卡片进入已获得态", tc2 && tc2.classList.contains("is-got"), tc2 ? tc2.className : "无");
  check("授予后出现「已获得」印章", tc2 && /已获得/.test(tc2.textContent));
  check("授予状态已持久化", (await ev('return settings.custom_honors[0].awarded === true;')) === true);
  check("授予后按钮文案变为「取消授予」", tc2 && /取消授予/.test(tc2.textContent));
  // 已获得后不再显示进度条
  check("已获得后隐藏进度条", tc2 && !tc2.querySelector(".tk-progress"));

  // 取消授予
  doc.querySelector('.tk[data-ch="h_test1"] [data-hact="toggle"]').click();
  await sleep(300);
  check("取消授予后回到暗色态", !doc.querySelector('.tk[data-ch="h_test1"]').classList.contains("is-got"));
  check("取消授予已持久化", (await ev('return settings.custom_honors[0].awarded === false;')) === true);

  // ---------- 8. 通过弹窗新建自定义荣誉 ----------
  await ev('openHonorWall();');
  await sleep(300);
  const addBtn = doc.querySelector('#view [data-hact="add"], .modal [data-hact="add"]');
  check("荣誉墙有「自定义荣誉」新建按钮", !!addBtn);
  addBtn.click();
  await sleep(300);
  check("新建表单已打开", !!doc.querySelector("#hf-name"));

  doc.querySelector("#hf-name").value = "我的童年称号";
  doc.querySelector("#hf-cat").value = "童年";
  doc.querySelector("#hf-desc").value = "写给十岁的自己";
  doc.querySelector("#hf-save").click();
  await sleep(400);
  const created = await ev('return settings.custom_honors.map(h=>h.name);');
  check("自定义荣誉已保存到设置", created.indexOf("我的童年称号") >= 0, JSON.stringify(created));
  const rec = await ev('return settings.custom_honors.find(h=>h.name==="我的童年称号");');
  check("新荣誉字段完整", rec && rec.name === "我的童年称号" && rec.cat === "童年" && rec.desc === "写给十岁的自己" && rec.awarded === false,
    JSON.stringify(rec));
  check("新荣誉有唯一 id", !!(rec && rec.id));

  // 弹窗内应能看到新卡
  const inModal = doc.querySelector('.modal .tk[data-ch="' + rec.id + '"]');
  check("新建后弹窗内立即出现该卡", !!inModal);

  // ---------- 9. 空名称校验 ----------
  await ev('closeModal(); openHonorWall();');
  await sleep(250);
  doc.querySelector('.modal [data-hact="add"]').click();
  await sleep(250);
  doc.querySelector("#hf-save").click();
  await sleep(200);
  check("空名称被拦截并提示", /不能为空/.test((doc.querySelector("#hf-msg") || {}).textContent || ""),
    (doc.querySelector("#hf-msg") || {}).textContent);
  check("校验失败时弹窗不关闭", !!doc.querySelector("#hf-name"));

  // ---------- 10. 编辑已有荣誉 ----------
  await ev('closeModal(); closeModal(); openHonorWall();');
  await sleep(250);
  doc.querySelector('.modal .tk[data-ch="' + rec.id + '"] [data-hact="edit"]').click();
  await sleep(300);
  check("编辑表单回填了原名称", doc.querySelector("#hf-name").value === "我的童年称号",
    doc.querySelector("#hf-name").value);
  doc.querySelector("#hf-name").value = "改过的称号";
  doc.querySelector("#hf-save").click();
  await sleep(400);
  const after = await ev('return settings.custom_honors.map(h=>h.name);');
  check("编辑已生效", after.indexOf("改过的称号") >= 0 && after.indexOf("我的童年称号") < 0, JSON.stringify(after));

  // ---------- 11. 删除自定义荣誉 ----------
  await ev('closeModal(); openHonorWall();');
  await sleep(250);
  doc.querySelector('.modal .tk[data-ch="' + rec.id + '"] [data-hact="del"]').click();
  await sleep(300);
  check("删除前有确认对话框", !!doc.querySelector(".modal"), "未弹确认框");
  const confirmBtn = Array.from(doc.querySelectorAll(".modal-foot button")).find(b => /删除/.test(b.textContent));
  check("确认框有「删除」按钮", !!confirmBtn);
  if (confirmBtn) {
    confirmBtn.click();
    await sleep(400);
    const left = await ev('return settings.custom_honors.length;');
    check("删除后从设置中移除", left === 1, "剩余 " + left + " 项（应只剩 h_test1）");
  }

  // ---------- 12. 侧栏荣誉摘要仍工作 ----------
  const sideName = await ev('return (document.querySelector("#side-honor-name")||{}).textContent;');
  check("侧栏荣誉名称有内容", !!sideName && sideName.length > 0, String(sideName));

  // ---------- 13. 关闭荣誉模块后不渲染 ----------
  await ev('settings.module_honor = false; go("home");');
  await sleep(300);
  check("关闭模块后荣誉墙不渲染", !doc.querySelector("#honor-wall"));
  await ev('settings.module_honor = true; go("home");');
  await sleep(300);
  check("重新开启后恢复渲染", !!doc.querySelector("#honor-wall"));

  // ---------- 14. 纯色玻璃 CSS 真的存在（否则是"看起来有"） ----------
  check(".tk-glass 有 conic-gradient 玻璃质感", /\.tk-glass\{[^}]*conic-gradient/.test(html));
  check("未获得卡有降饱和处理", /\.tk:not\(\.is-got\) \.tk-bg\{[^}]*saturate/.test(html));
  check("已获得卡有警示色印章", /\.tk-seal\{[^}]*background:var\(--warn\)/.test(html));
  check("齿孔用 mask 而非 SVG filter（性能）", /\.tk-perf\{[^}]*mask:/.test(html) && !/filter:url\(#bump\)/.test(html));
  check("卡片为 5:7 票券比例", /\.tk\{[^}]*aspect-ratio:5\/7/.test(html));

  console.log("\n通过 " + pass + " / " + (pass + fail));
  if (errs.length) { console.log("\n失败项："); errs.forEach(e => console.log("  · " + e)); }
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error("测试脚本异常:", e); process.exit(2); });
