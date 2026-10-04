/* CSV 导入专项测试
 *
 * 为什么单独写：CSV 的坑几乎全是「看起来对了但实际解析错」，
 * 语法检查与冒烟测试都发现不了。必须逐条喂真实畸形输入。
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

  // ---------- 1. 基本解析 ----------
  check("parseCSV 是全局函数", evSync("typeof parseCSV") === "function", String(evSync("typeof parseCSV")));

  const r1 = evSync('parseCSV("a,b,c\\n1,2,3")');
  check("基本两行两列", Array.isArray(r1) && r1.length === 2 && r1[0].join("|") === "a|b|c" && r1[1].join("|") === "1|2|3",
    JSON.stringify(r1));

  // ---------- 2. 引号内含逗号 ----------
  const r2 = evSync('parseCSV(\'a,b\\n"x,y",z\')');
  check("引号内逗号不被切分", r2[1][0] === "x,y" && r2[1][1] === "z", JSON.stringify(r2));

  // ---------- 3. 转义双引号 "" -> " ----------
  const r3 = evSync('parseCSV(\'a\\n"他说""你好"""\')');
  check("双引号转义为单个引号", r3[1][0] === '他说"你好"', JSON.stringify(r3));

  // ---------- 4. 字段内换行 ----------
  const r4 = evSync('parseCSV(\'a,b\\n"第一行\\n第二行",z\')');
  check("引号内换行保留在同一字段", r4.length === 2 && r4[1][0] === "第一行\n第二行", JSON.stringify(r4));

  // ---------- 5. CRLF ----------
  const r5 = evSync('parseCSV("a,b\\r\\nc,d\\r\\n")');
  check("CRLF 不产生空列", r5.length === 2 && r5[1].length === 2 && r5[1][1] === "d", JSON.stringify(r5));

  // ---------- 6. BOM 剥离 ----------
  const r6 = evSync('parseCSV("\\uFEFF语录,出处")');
  check("UTF-8 BOM 被剥离", r6[0][0] === "语录", JSON.stringify(r6));

  // ---------- 7. 末行无换行符 ----------
  const r7 = evSync('parseCSV("a,b\\n1,2")');
  check("末行无换行符仍被吐出", r7.length === 2 && r7[1][1] === "2", JSON.stringify(r7));

  // ---------- 8. 全空行被过滤 ----------
  const r8 = evSync('parseCSV("a,b\\n\\n,\\n1,2\\n\\n")');
  check("空行被过滤", r8.length === 2, JSON.stringify(r8));

  // ---------- 9. 表头映射：中文别名 ----------
  const m1 = evSync('mapCSVHeader(["语录","出处作品","角色"])');
  check("中文表头按名映射", m1.text === 0 && m1.sourceAnimeTitle === 1 && m1.character === 2, JSON.stringify(m1));

  const m2 = evSync('mapCSVHeader(["text","anime","who"])');
  check("英文表头按名映射", m2.text === 0 && m2.sourceAnimeTitle === 1 && m2.character === 2, JSON.stringify(m2));

  const m3 = evSync('mapCSVHeader(["台词内容","来源作品","声优"])');
  check("表头别名（台词内容/来源作品/声优）", m3.text === 0 && m3.sourceAnimeTitle === 1 && m3.character === 2, JSON.stringify(m3));

  const m4 = evSync('mapCSVHeader(["收藏","正文","出处"])');
  check("列序打乱仍按名映射（收藏在第 0 列）", m4.favorite === 0 && m4.text === 1 && m4.sourceAnimeTitle === 2, JSON.stringify(m4));

  const m5 = evSync('mapCSVHeader(["随便","瞎写"])');
  check("认不出表头时留空（交给位置兜底）", m5.text == null, JSON.stringify(m5));

  // ---------- 10. 端到端：真实点击导入 ----------
  await ev('settings.module_quotes = true; go("quotes");');
  await new Promise(r => setTimeout(r, 250));

  // topbar 只应有一个按钮，且不再是「添加语录」
  const topbarBtns = Array.from(doc.querySelectorAll("#page-actions button")).map(b => b.textContent.trim());
  check("topbar 已无重复的「添加语录」按钮",
    !topbarBtns.some(t => t.includes("添加语录")), JSON.stringify(topbarBtns));
  check("topbar 有 CSV 导入入口", topbarBtns.some(t => t.includes("导入 CSV")), JSON.stringify(topbarBtns));

  // 页面内保留唯一一处添加语录
  const pageAdds = Array.from(doc.querySelectorAll("#view button")).filter(b => b.textContent.includes("添加语录"));
  // 默认分区「我的收藏」为空：toolbar 不再渲染添加按钮，只剩空态那一处
  check("空态时全页只有一处「添加语录」", pageAdds.length === 1, "实际 " + pageAdds.length);

  // 通过 UI 打开导入弹窗
  doc.querySelector('#page-actions [data-act="import-csv"]').click();
  await new Promise(r => setTimeout(r, 250));
  check("导入弹窗已打开", !!doc.querySelector("#qi-text"));

  // 点「填入示例」→ 应出现预览且导入按钮解禁
  doc.querySelector("#qi-demo").click();
  await new Promise(r => setTimeout(r, 400));
  const goBtn = doc.querySelector("#qi-go");
  check("示例解析后导入按钮解禁", goBtn && !goBtn.disabled);
  check("预览区显示解析条数", /\d+ 条可用语录/.test(doc.querySelector("#qi-preview").textContent),
    doc.querySelector("#qi-preview").textContent.slice(0, 80));

  const before = await ev('return state.quotes.length;');
  goBtn.click();
  await new Promise(r => setTimeout(r, 600));

  const after = await ev('return state.quotes.length;');
  check("导入确实写入了 state.quotes", after > before, before + " → " + after);

  const imported = await ev('return state.quotes.filter(q=>q.source==="csv").map(q=>({t:q.text,s:q.sourceAnimeTitle,c:q.character,f:q.favorite}));');
  check("导入条数 = 3", imported.length === 3, JSON.stringify(imported));
  check("含逗号的引号被正确解析",
    imported.some(q => q.t === "她说：我要, 走了"), JSON.stringify(imported));
  // 示例文案自带日文引号「」，解析结果应原样保留（含内部空格）
  check("含内部空格的英文引号被正确解析",
    imported.some(q => q.t === "「 We're  back 」"), JSON.stringify(imported));
  check("收藏列被识别",
    imported.filter(q => q.f).length === 1, JSON.stringify(imported));
  check("导入后自动切到「我添加的」分区", evSync("quotesState.tab") === "mine", String(evSync("quotesState.tab")));

  // ---------- 11. 重复导入去重 ----------
  const n1 = await ev('return state.quotes.length;');
  await ev('openQuoteImport();');
  await new Promise(r => setTimeout(r, 200));
  doc.querySelector("#qi-demo").click();
  await new Promise(r => setTimeout(r, 400));
  doc.querySelector("#qi-go").click();
  await new Promise(r => setTimeout(r, 600));
  const n2 = await ev('return state.quotes.length;');
  check("重复导入同内容不产生副本", n2 === n1, n1 + " → " + n2);

  // ---------- 12. 空输入不解禁按钮 ----------
  await ev('closeModal(); openQuoteImport();');
  await new Promise(r => setTimeout(r, 200));
  check("空内容时导入按钮保持禁用", doc.querySelector("#qi-go").disabled);

  // ---------- 13. 只有表头无数据行 ----------
  await ev('closeModal(); openQuoteImport();');
  await new Promise(r => setTimeout(r, 200));
  const ta = doc.querySelector("#qi-text");
  ta.value = "语录,出处作品";
  ta.dispatchEvent(new win.Event("input"));
  await new Promise(r => setTimeout(r, 400));
  check("仅表头时给出提示且按钮禁用",
    doc.querySelector("#qi-go").disabled && /至少需要/.test(doc.querySelector("#qi-preview").textContent),
    doc.querySelector("#qi-preview").textContent.slice(0, 60));

  // ---------- 14. 缺列的行被跳过而非崩溃 ----------
  await ev('closeModal(); openQuoteImport();');
  await new Promise(r => setTimeout(r, 200));
  const ta2 = doc.querySelector("#qi-text");
  ta2.value = "语录,出处作品\n只有正文,出处A\n,只有出处\n完整,出处B,角色C";
  ta2.dispatchEvent(new win.Event("input"));
  await new Promise(r => setTimeout(r, 400));
  const pv = doc.querySelector("#qi-preview").textContent;
  check("缺列行被跳过并计数", /解析到 2 条/.test(pv) && /跳过 1 行/.test(pv), pv.slice(0, 100));

  console.log("\n通过 " + pass + " / " + (pass + fail));
  if (errs.length) { console.log("\n失败项："); errs.forEach(e => console.log("  · " + e)); }
  const noisy = win.console.error;
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error("测试脚本异常:", e); process.exit(2); });
