/* ============================================================
   23. 首页 · 档案馆看板
   ------------------------------------------------------------
   恢复说明：本模块曾因一次范围计算错误的批量替换被误删，
   此处按原设计重建（class 名与 CSS 完全对齐，未改动样式表）。
   ============================================================ */
let bannerQuote = null;
function renderHome(root){
  const s = stats();
  const list = state.anime;
  if(!list.length){
    root.innerHTML = '<div class="state-box">' + ic("home",40) +
      "<h2>欢迎回到放映厅</h2><p>搜索第一部童年动画，开始建档。</p>" +
      '<div class="row" style="justify-content:center"><button class="btn btn-primary" type="button" data-act="go-library">' + ic("plus",16) + "建立第一份档案</button></div></div>";
    const b = root.querySelector('[data-act="go-library"]');
    if(b) b.addEventListener("click", () => go("library"));
    return;
  }
  // 语录横幅：每次进首页换一条，避免用户第一眼就腻
  bannerQuote = pickRandomQuote(bannerQuote);
  const hon = currentHonor();
  const gotHonor = hon.topId ? BUILTIN_HONORS.find(h => h.id === hon.topId) : null;

  const stat = (val, label, icon) =>
    '<div class="stat-card">' + (icon ? ic(icon,14) : "") + "<b>" + val + "</b><span>" + esc(label) + "</span></div>";

  let html =
    '<div class="stats-strip">' +
      stat(fmtInt(s.total), "片库总数", "library") +
      stat(fmtInt(s.done), "已看完", "check") +
      stat(fmtInt(s.totalEps), "累计集数", "film") +
      stat(fmtInt(s.hours), "累计小时", "clock") +
      stat(fmtInt(s.rewatches), "重看次数", "refresh") +
      stat(fmtInt(s.masterpieces), "神作标记", "medal") +
    "</div>";

  // 荣誉摘要
  html += '<div class="honor-card mt-4">' +
    ic("medal", 52, "honor-medal") +
    "<div><div class=\"hint\">当前称号</div>" +
      '<div class="honor-title">' + esc(gotHonor ? gotHonor.name : "尚未解锁") + "</div>" +
      '<div class="small muted">' + (gotHonor ? esc(gotHonor.desc) : "看完 10 部作品即可获得第一个称号") + "</div>" +
    "</div>" +
    (hon.nextQuant
      ? '<div class="honor-prog"><div class="row small"><span class="muted">距 ' + esc(hon.nextQuant.name) + "</span>" +
        '<span class="muted" style="margin-left:auto">' + hon.nextQuant.cur + " / " + hon.nextQuant.need + " 部</span></div>" +
        '<div class="progress"><i style="width:' + Math.min(100, Math.round(hon.nextQuant.cur / hon.nextQuant.need * 100)) + '%"></i></div></div>'
      : '<div class="grow"></div>') +
    '<button class="btn btn-sm" type="button" data-act="open-honor" style="margin-left:var(--sp-3)">' + ic("medal",14) + "荣誉墙</button>" +
  "</div>";

  // 语录横幅
  if(bannerQuote){
    html += '<div class="quote-banner mt-4">' +
      '<div class="quote-body"><div class="quote-text">「' + esc(bannerQuote.text) + "」</div>" +
      '<div class="quote-src">' + esc(quoteMetaLine(bannerQuote)) + "</div></div>" +
      '<div class="quote-actions">' +
        '<button class="btn btn-sm" type="button" data-act="quote-refresh" title="换一条">' + ic("refresh",14) + "</button>" +
        '<button class="btn btn-sm btn-icon' + (bannerQuote.favorite ? " is-on" : "") + '" type="button" data-act="quote-fav" title="收藏" aria-pressed="' + (bannerQuote.favorite ? "true" : "false") + '">' + ic(bannerQuote.favorite ? "starfill" : "star",14) + "</button>" +
      "</div></div>";
  }

  // 最近添加 + 最近感想
  const recent = recentAdded(4);
  const reviews = recentReviews(2);
  html += '<div class="grid-2 mt-4">';
  html += '<div class="panel"><div class="panel-head">' + ic("plus",16) + "<h3>最近建档</h3></div>" +
    (recent.length
      ? recent.map(a => '<div class="recent-item" data-open="' + attr(a.id) + '" role="button" tabindex="0">' +
          '<div class="recent-thumb">' + coverThumb(a) + "</div>" +
          '<div style="min-width:0"><div class="truncate" style="font-weight:600">' + esc(a.titleCn || a.titleOriginal || "未命名") + "</div>" +
          '<div class="hint">' + esc(statusName(a)) + " · " + esc(String(a.airDate || "—").slice(0,4)) + "</div></div></div>").join("")
      : '<p class="hint">还没有建档任何作品</p>') +
  "</div>";
  html += '<div class="panel"><div class="panel-head">' + ic("quote",16) + "<h3>最近感想</h3></div>" +
    (reviews.length
      ? reviews.map(r => '<div class="recent-review" style="margin-bottom:var(--sp-3)">' +
          '<div class="txt clamp-2">' + esc(r.review.content || "（只记录了重看，没有写文字）") + "</div>" +
          '<div class="hint">' + esc(r.anime.titleCn || r.anime.titleOriginal || "—") + " · " + esc(String(r.review.date || "").slice(0,10)) + "</div></div>").join("")
      : '<p class="hint">还没有写过感想。在作品详情里记录重看时可以写几句。</p>') +
  "</div>";
  html += "</div>";

  // 图表区
  if(settings.module_charts){
    html += '<div class="grid-2 mt-4">';
    html += chartPanelHTML("decade", "年代分布", "chart", rankListHTML(topCount(a => { const d = decadeOf(a.airDate); return d ? [d + "s"] : []; }, state.anime, 8).map(x => ({ k: x[0], v: x[1] })), " 部"));
    html += chartPanelHTML("studio", "制作公司", "chart", rankListHTML(topCount(a => a.studios || [], state.anime, 8).map(x => ({ k: x[0], v: x[1] })), " 部"));
    html += chartPanelHTML("genre", "类型分布", "chart", rankListHTML(topCount(a => a.genres || [], state.anime, 8).map(x => ({ k: x[0], v: x[1] })), " 部"));
    html += chartPanelHTML("status", "状态构成", "pie", rankListHTML(state.statuses.map(st => ({ k: st.name, v: state.anime.filter(a => a.statusId === st.id).length })).filter(x => x.v > 0), " 部"));
    html += "</div>";
  }

  // 荣誉墙
  html += '<div class="mt-4">' + honorWallHTML() + "</div>";

  root.innerHTML = html;

  // 事件
  const hb = root.querySelector('[data-act="open-honor"]');
  if(hb) hb.addEventListener("click", () => openHonorWall());
  const nb = root.querySelector('[data-act="quote-refresh"]');
  if(nb) nb.addEventListener("click", () => { bannerQuote = pickRandomQuote(bannerQuote); rerender(); });
  const fb = root.querySelector('[data-act="quote-fav"]');
  if(fb) fb.addEventListener("click", async () => {
    if(!bannerQuote) return;
    bannerQuote.favorite = !bannerQuote.favorite;
    await saveQuote(bannerQuote);
    updateSidebarInfo();
    rerender();
  });
  root.querySelectorAll("[data-open]").forEach(n => {
    n.addEventListener("click", () => go("theater", n.dataset.open));
    n.addEventListener("keydown", (e) => { if(e.key === "Enter" || e.key === " "){ e.preventDefault(); go("theater", n.dataset.open); } });
  });
  const gb = root.querySelector('[data-act="go-library"]');
  if(gb) gb.addEventListener("click", () => go("library"));
  bindHonorWall(root);
  mountCharts(root);
}
