/* 中文输入法（IME）防打断测试。
 * 症状：片库搜索框打拼音时，防抖回调 rerender() 重建输入框，
 *       合成被顶掉，用户看到「打字中文自己打断，只剩拼音字母」。
 * 修法：bindIMEInput —— 合成期间忽略 input，compositionend 才触发。
 *
 * 覆盖：功能级（片库/语录搜索框走完整合成流程）+ 静态（其余绑定点必须走 bindIMEInput）。
 * 防回归点：
 *  1. 合成期间防抖窗口过了也不许触发回调（不许 rerender、不许写 libState）；
 *  2. compositionend 后恰好触发一次，拿到的是上屏后的完整文本；
 *  3. 不走输入法的英文输入照常工作。 */
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
  const doc = win.document;
  await sleep(1100);
  const ev = async expr => await win.eval("(async()=>{" + expr + "})()");

  /* ---------- 1. 静态：所有会触发重渲的文本输入必须走 bindIMEInput ---------- */
  check("bindIMEInput 工具存在（compositionstart/end 守卫）",
    html.indexOf("function bindIMEInput") >= 0 &&
    html.indexOf('el.addEventListener("compositionstart"') >= 0 &&
    html.indexOf('el.addEventListener("compositionend"') >= 0);
  const mustUseIME = [
    ["片库搜索 #lib-q",        'bindIMEInput(q, debounce(() => { libState.rowExpanded'],
    ["添加新番搜索 #st-kw",    "kwNode && bindIMEInput(kwNode"],
    ["播放源地址 #st-url",     "bindIMEInput(input, debounce(() => {\n    syncStreamLauncher(root)"],
    ["播放源台账搜索 #led-q",  "if(q) bindIMEInput(q, debounce(() => {\n    ledgerState.q = q.value"],
    ["语录 CSV 预览 textarea", "bindIMEInput(ta, debounce(analyze, 200))"],
    ["语录本搜索 #qt-q",       "if(q) bindIMEInput(q, debounce(() => { quotesState.q = q.value"],
    ["作品名自动补全",         'bindIMEInput(input, () => {\n    const kw = normalize(input.value)'],
    ["设置页文本输入",         "bindIMEInput(n, debounce(handler, 220))"]
  ];
  for(const [name, marker] of mustUseIME){
    check(name + " 已走 bindIMEInput", html.indexOf(marker) >= 0, marker.slice(0, 60));
  }
  check("不再有裸绑的 input 搜索监听（除数字框与滑块）",
    (html.match(/addEventListener\("input"/g) || []).length === 3); /* bindIMEInput 内部 1 + 数字框 + bgOv 滑块 */

  /* ---------- 2. 功能：片库搜索框完整合成流程 ---------- */
  await ev(`
    state.anime = [{
      id:"A1", titleCn:"启航", totalEpisodes:12, watchedEpisodes:0,
      statusId:"st_want", rewatchCount:0, reviews:[],
      aliases:[], genres:[], studios:[], personalTags:[]
    }];
    go("library");
  `);
  const comp = await ev(`
    const q = document.querySelector("#lib-q");
    if(!q) return JSON.stringify({ err:"no #lib-q" });
    const marker = q;
    q.dispatchEvent(new Event("compositionstart"));
    q.value = "qi";
    q.dispatchEvent(new Event("input"));
    /* 停满防抖窗口：合成中不许触发回调 */
    await new Promise(r => setTimeout(r, 420));
    const mid = {
      qState: libState.q,
      nodeAlive: document.body.contains(marker)
    };
    /* 上屏：改值为最终中文，结束合成 */
    q.value = "启";
    q.dispatchEvent(new Event("compositionend"));
    await new Promise(r => setTimeout(r, 420));
    const n2 = document.querySelector("#lib-q");
    return JSON.stringify({
      mid: mid,
      after: { qState: libState.q, focused: document.activeElement === n2, val: n2 ? n2.value : null }
    });
  `);
  const c = JSON.parse(comp);
  check("合成期间（拼音未上屏）不触发搜索/重渲",
    c.mid && c.mid.qState === "" && c.mid.nodeAlive === true, comp);
  check("compositionend 后用上屏文本触发一次搜索",
    c.after && c.after.qState === "启", comp);
  check("重渲后输入框保持焦点、值为上屏文本",
    c.after && c.after.focused === true && c.after.val === "启", comp);

  /* ---------- 3. 功能：不走输入法的英文输入照常 ---------- */
  const plain = await ev(`
    const q = document.querySelector("#lib-q");
    q.value = "sazae";
    q.dispatchEvent(new Event("input"));
    await new Promise(r => setTimeout(r, 420));
    return libState.q;
  `);
  check("英文直接输入照常触发搜索", plain === "sazae", String(plain));

  /* ---------- 4. 功能：语录本搜索同样防打断 ---------- */
  await ev("go('quotes')");
  const qt = await ev(`
    const q = document.querySelector("#qt-q");
    if(!q) return JSON.stringify({ err:"no #qt-q" });
    q.dispatchEvent(new Event("compositionstart"));
    q.value = "pin";
    q.dispatchEvent(new Event("input"));
    await new Promise(r => setTimeout(r, 420));
    const mid = { qState: quotesState.q, nodeAlive: document.body.contains(q) };
    q.value = "拼";
    q.dispatchEvent(new Event("compositionend"));
    await new Promise(r => setTimeout(r, 420));
    return JSON.stringify({ mid: mid, after: quotesState.q });
  `);
  const qtj = JSON.parse(qt);
  check("语录搜索合成期间不打断", qtj.mid && qtj.mid.qState === "" && qtj.mid.nodeAlive === true, qt);
  check("语录搜索 compositionend 后生效", qtj.after === "拼", qt);

  console.log("");
  console.log("== IME 防打断测试：pass=" + pass + " fail=" + fail + " ==");
  if(fails.length){ console.log("失败项：\n - " + fails.join("\n - ")); process.exit(1); }
})().catch(e => { console.error("测试脚本异常：", e); process.exit(1); });
