/* 重看感想的编辑与删除测试。
 * 覆盖：时间线条目的编辑/删除按钮、promptReview 编辑模式（预填与就地更新）、
 *       删除确认（确认/取消两条路）、rewatchCount 纪律（编辑不涨不跌、只在轮次变大时抬底）。
 *
 * 防回归点：
 *  1. 编辑必须就地更新同一条记录（id 不变、条数不变），不能变成「追加一条新的」；
 *  2. 删除一条感想不能动 rewatchCount —— 看过就是看过，删笔记不等于没看过；
 *  3. 渲染必须带 data-rv 定位到具体条目，否则事件处理找不到目标。 */
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
  const J = o => JSON.stringify(o);

  /* ---------- 1. 静态结构 ---------- */
  check("时间线条目带编辑按钮（data-act=rv-edit）",
    html.indexOf('data-act="rv-edit"') >= 0);
  check("时间线条目带删除按钮（data-act=rv-del）",
    html.indexOf('data-act="rv-del"') >= 0);
  check("按钮用 data-rv 定位到具体条目",
    html.indexOf('data-rv=') >= 0);
  check("promptReview 支持编辑模式（opts.review）",
    html.indexOf("opts.review || null") >= 0);
  check("编辑保存走就地更新（editedAt）而不是 concat 追加",
    html.indexOf("editing.editedAt") >= 0);
  check("删除有二次确认且说明不影响重看次数",
    html.indexOf("只删这条记录，不影响重看次数") >= 0);

  /* ---------- 2. 造数据并渲染详情 ---------- */
  await ev(`
    state.anime = [{
      id:"A1", titleCn:"测试作品", totalEpisodes:12, watchedEpisodes:12,
      statusId:"st_done", rewatchCount:3,
      reviews:[
        { id:"rv1", date:"2026-10-01", round:2, content:"第一次写的感想", createdAt:"2026-10-01T10:00:00Z" },
        { id:"rv2", date:"2026-10-05", round:3, content:"", createdAt:"2026-10-05T10:00:00Z" }
      ],
      aliases:[], genres:[], studios:[], personalTags:[]
    }];
    state.series = [];
  `);
  const ops = await ev(`
    const root = document.createElement("div");
    document.body.appendChild(root);
    renderDetail(root, "A1");
    const items = root.querySelectorAll(".review-item");
    const eb = items.length ? items[0].querySelector('[data-act="rv-edit"]') : null;
    return JSON.stringify({
      items: items.length,
      btns: root.querySelectorAll('[data-act="rv-edit"]').length + "/" + root.querySelectorAll('[data-act="rv-del"]').length,
      rvOfFirst: eb ? eb.getAttribute("data-rv") : null
    });
  `);
  const opsObj = JSON.parse(ops);
  check("两条感想各渲染出一组编辑/删除按钮", opsObj.items === 2 && opsObj.btns === "2/2", ops);
  check("按钮的 data-rv 指向对应感想 id",
    opsObj.rvOfFirst === "rv2" || opsObj.rvOfFirst === "rv1", ops);

  /* ---------- 3. 编辑：预填 ---------- */
  const prefill = await ev(`
    const p = promptReview(animeById("A1"), { review: animeById("A1").reviews[0] });
    await new Promise(r => setTimeout(r, 30));
    const t = document.querySelector("#modal-title");
    const d = document.querySelector("#rv-date");
    const rd = document.querySelector("#rv-round");
    const c = document.querySelector("#rv-content");
    const save = document.querySelector("#rv-save");
    const out = {
      title: t ? t.textContent : null,
      date: d ? d.value : null,
      round: rd ? rd.value : null,
      content: c ? c.value : null,
      saveText: save ? save.textContent : null
    };
    window.__editPromise = p;
    return JSON.stringify(out);
  `);
  const pf = JSON.parse(prefill);
  check("编辑弹窗标题是「编辑这条感想」", pf.title === "编辑这条感想", prefill);
  check("编辑弹窗预填日期/轮次/内容",
    pf.date === "2026-10-01" && pf.round === "2" && pf.content === "第一次写的感想", prefill);
  check("编辑模式的保存按钮文案是「保存修改」", pf.saveText === "保存修改", prefill);

  /* ---------- 4. 编辑：保存就地更新 ---------- */
  const afterEdit = await ev(`
    document.querySelector("#rv-date").value = "2026-10-02";
    document.querySelector("#rv-round").value = "1";
    document.querySelector("#rv-content").value = "改过的感想";
    document.querySelector("#rv-save").click();
    const rv = await window.__editPromise;
    const a = animeById("A1");
    return JSON.stringify({
      len: a.reviews.length,
      id: a.reviews[0].id,
      date: a.reviews[0].date,
      round: a.reviews[0].round,
      content: a.reviews[0].content,
      edited: !!a.reviews[0].editedAt,
      rewatch: a.rewatchCount,
      modalGone: !document.querySelector("#rv-save")
    });
  `);
  const ae = JSON.parse(afterEdit);
  check("编辑后条数不变（不会变成追加）", ae.len === 2, afterEdit);
  check("编辑的是原记录（id 不变）", ae.id === "rv1", afterEdit);
  check("日期/轮次/内容都已更新",
    ae.date === "2026-10-02" && ae.round === 1 && ae.content === "改过的感想", afterEdit);
  check("编辑留痕（editedAt）", ae.edited === true, afterEdit);
  check("编辑不改变重看次数（3 保持 3）", ae.rewatch === 3, afterEdit);
  check("保存后弹窗关闭", ae.modalGone === true, afterEdit);

  /* ---------- 5. 编辑：轮次变大时抬底 rewatchCount ---------- */
  const lift = await ev(`
    const p = promptReview(animeById("A1"), { review: animeById("A1").reviews[0] });
    await new Promise(r => setTimeout(r, 30));
    document.querySelector("#rv-round").value = "9";
    document.querySelector("#rv-save").click();
    await p;
    const a = animeById("A1");
    return JSON.stringify({ rewatch: a.rewatchCount, round: a.reviews[0].round });
  `);
  const lf = JSON.parse(lift);
  check("轮次改成 9 后重看次数抬到 8（round-1 下限）",
    lf.rewatch === 8 && lf.round === 9, lift);

  /* ---------- 6. 删除：确认后只删这一条 ---------- */
  /* 时间线按日期倒序渲染，DOM 第一条不一定是 rv1 ——
     以被点按钮的 data-rv 为准断言「点谁删谁」。 */
  const del = await ev(`
    confirmDialog = async () => true;
    const btn = document.querySelector(".review-item [data-act='rv-del']");
    const targetId = btn.getAttribute("data-rv");
    btn.click();
    await new Promise(r => setTimeout(r, 80));
    const a = animeById("A1");
    return JSON.stringify({
      targetId: targetId,
      len: a.reviews.length,
      left: a.reviews.map(r => r.id),
      rewatch: a.rewatchCount
    });
  `);
  const dl = JSON.parse(del);
  check("删除后只剩一条感想", dl.len === 1, del);
  check("删掉的是点的那条（" + dl.targetId + "），另一条完好",
    dl.len === 1 && dl.left.indexOf(dl.targetId) < 0, del);
  check("删除感想不动重看次数", dl.rewatch === 8, del);

  /* ---------- 7. 删除：取消则不删 ---------- */
  const cancel = await ev(`
    confirmDialog = async () => false;
    const btn = document.querySelector(".review-item [data-act='rv-del']");
    const before = animeById("A1").reviews.map(r => r.id);
    btn.click();
    await new Promise(r => setTimeout(r, 80));
    const after = animeById("A1").reviews.map(r => r.id);
    return JSON.stringify({ same: before.join() === after.join() });
  `);
  check("取消确认框后感想仍在", JSON.parse(cancel).same === true, cancel);

  /* ---------- 8. 编辑空内容也允许（记录本身保留） ---------- */
  const blank = await ev(`
    const p = promptReview(animeById("A1"), { review: animeById("A1").reviews[0] });
    await new Promise(r => setTimeout(r, 30));
    document.querySelector("#rv-content").value = "  ";
    document.querySelector("#rv-save").click();
    await p;
    const a = animeById("A1");
    return JSON.stringify({ len: a.reviews.length, content: a.reviews[0].content });
  `);
  const bl = JSON.parse(blank);
  check("编辑时清空内容：记录保留、内容置空", bl.len === 1 && bl.content === "", blank);

  console.log("");
  console.log("== 重看感想编辑/删除测试：pass=" + pass + " fail=" + fail + " ==");
  if(fails.length){ console.log("失败项：\n - " + fails.join("\n - ")); process.exit(1); }
})().catch(e => { console.error("测试脚本异常：", e); process.exit(1); });
