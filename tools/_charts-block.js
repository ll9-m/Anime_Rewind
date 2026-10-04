/* ============================================================
   22. 图表（ECharts CDN + 降级文字排行）
   ============================================================ */
let echartsPromise = null, echartsReady = false, echartsFailed = false;
function loadECharts(){
  if(echartsPromise) return echartsPromise;
  echartsPromise = new Promise((resolve) => {
    const tryScript = (urls, i) => {
      if(i >= urls.length){ echartsFailed = true; resolve(null); return; }
      const s = document.createElement("script");
      s.src = urls[i];
      s.async = true;
      s.onload = () => { echartsReady = !!window.echarts; resolve(window.echarts || null); };
      s.onerror = () => { tryScript(urls, i+1); };
      document.head.appendChild(s);
    };
    tryScript(["https://cdn.jsdelivr.net/npm/echarts@5.5.0/dist/echarts.min.js",
               "https://cdnjs.cloudflare.com/ajax/libs/echarts/5.5.0/echarts.min.js"], 0);
  });
  return echartsPromise;
}
const chartRegistry = [];
/* 必须逐个 dispose，不能只清数组 —— 详见 mountCharts 内的注释。 */
function disposeCharts(){
  if(!chartRegistry.length) return;
  chartRegistry.forEach(c => {
    try{ c.inst.dispose(); }catch(e){}
    try{ c.inst.off(); }catch(e){}
  });
  chartRegistry.length = 0;
}
function cssVar(name, fallback){
  const v = getComputedStyle(document.documentElement).getPropertyValue(name);
  return (v && v.trim()) || fallback;
}
function chartTheme(){
  return {
    text: cssVar("--text", "#e6edf3"),
    muted: cssVar("--muted", "#94a3b3"),
    accent: cssVar("--accent", "#22d3ee"),
    border: cssVar("--border", "#2a333f"),
    panel: cssVar("--panel-2", "#1c232d")
  };
}
function baseOption(){
  const t = chartTheme();
  return {
    textStyle: { color: t.text, fontFamily: "Segoe UI, 'PingFang SC', 'Microsoft YaHei', sans-serif" },
    tooltip: { backgroundColor: t.panel, borderColor: t.border, textStyle:{ color:t.text } },
    grid: { left: 8, right: 16, top: 24, bottom: 8, containLabel: true }
  };
}
function barOption(cats, values, opts){
  const t = chartTheme();
  const o = opts || {};
  return Object.assign(baseOption(), {
    xAxis: { type:"category", data:cats, axisLine:{ lineStyle:{ color:t.border } }, axisLabel:{ color:t.muted, interval:0, hideOverlap:true } },
    yAxis: { type:"value", splitLine:{ lineStyle:{ color:t.border, opacity:.5 } }, axisLabel:{ color:t.muted }, minInterval:1 },
    series: [{
      type:"bar", data:values, barMaxWidth:34,
      itemStyle:{ color:o.color || t.accent, borderRadius:[4,4,0,0] },
      label:{ show:o.label !== false, position:"top", color:t.muted, fontSize:10 }
    }]
  });
}
function hbarOption(cats, values){
  const t = chartTheme();
  return Object.assign(baseOption(), {
    grid: { left: 8, right: 40, top: 12, bottom: 8, containLabel: true },
    xAxis: { type:"value", splitLine:{ lineStyle:{ color:t.border, opacity:.5 } }, axisLabel:{ color:t.muted }, minInterval:1 },
    yAxis: { type:"category", data:cats, axisLine:{ lineStyle:{ color:t.border } }, axisLabel:{ color:t.muted, width:90, overflow:"truncate" } },
    series: [{
      type:"bar", data:values, barMaxWidth:18,
      itemStyle:{ color:t.accent, borderRadius:[0,4,4,0] },
      label:{ show:true, position:"right", color:t.muted, fontSize:10 }
    }]
  });
}
function pieOption(items){
  const t = chartTheme();
  return Object.assign(baseOption(), {
    tooltip: { trigger:"item", backgroundColor:t.panel, borderColor:t.border, textStyle:{ color:t.text },
      formatter: p => p.name + "：" + p.value + "（" + p.percent + "%）" },
    legend: { bottom:0, textStyle:{ color:t.muted, fontSize:10 } },
    series: [{
      type:"pie", radius:["42%","66%"], center:["50%","44%"],
      itemStyle:{ borderColor:t.panel, borderWidth:2 },
      label:{ color:t.muted, fontSize:10 },
      data:items
    }]
  });
}
function rankListHTML(items, unit){
  if(!items || !items.length) return '<p class="hint">还没有数据</p>';
  const max = Math.max.apply(null, items.map(i => i.v || 0)) || 1;
  return '<div class="rank-list">' + items.map((it, i) =>
    '<div class="rank-item">' +
      '<div class="rank-no">' + (i+1) + "</div>" +
      (it.img ? '<div class="rank-thumb"><img src="' + attr(it.img) + '" alt=""></div>' : "") +
      '<div class="rank-name truncate">' + esc(it.k) + "</div>" +
      '<div class="rank-val">' + fmtInt(it.v) + (unit || "") + "</div>" +
    "</div>").join("") + "</div>";
}
function mountCharts(root){
  // 关键：ECharts 实例持有 canvas、WebGL 上下文、事件总线与 ResizeObserver。
  // 只把数组清空（chartRegistry.length = 0）而不 dispose，往返切页十几次就会
  // 攒下十几个僵尸实例 —— 这是本项目最大的内存泄漏点，且不报错、只表现为"越用越卡"。
  disposeCharts();
  if(!settings.module_charts) return Promise.resolve();
  const nodes = Array.from(root.querySelectorAll("[data-chart]"));
  if(!nodes.length) return Promise.resolve();
  return loadECharts().then(ec => {
    // 加载期间用户可能已经切走页面：此时 DOM 里的 canvas 早已不在文档中，
    // 继续 init 会产生永不显示却常驻内存的实例。
    if(!nodes[0].isConnected) return;
    nodes.forEach(node => {
      const kind = node.dataset.chart;
      const fallbackEl = node.parentNode.querySelector("[data-fallback-for='" + kind + "']");
      if(!ec || echartsFailed){
        node.hidden = true;
        if(fallbackEl) fallbackEl.hidden = false;
        return;
      }
      node.hidden = false;
      if(fallbackEl) fallbackEl.hidden = true;
      let inst;
      try{ inst = ec.init(node, null, { renderer:"canvas" }); }
      catch(e){ node.hidden = true; if(fallbackEl) fallbackEl.hidden = false; return; }
      const build = chartBuilders[kind];
      if(!build) return;
      inst.setOption(build());
      chartRegistry.push({ inst, kind });
    });
  }).catch(() => {
    nodes.forEach(node => {
      node.hidden = true;
      const fb = node.parentNode.querySelector("[data-fallback-for='" + node.dataset.chart + "']");
      if(fb) fb.hidden = false;
    });
  });
}
function redrawChartsIfOpen(){
  if(!chartRegistry.length) return;
  chartRegistry.forEach(c => {
    try{
      c.inst.setOption(chartBuilders[c.kind] ? chartBuilders[c.kind]() : {}, true);
    }catch(e){}
  });
}
const chartBuilders = {
  decade(){
    const cats = allDecades();
    const vals = cats.map(d => state.anime.filter(a => decadeOf(a.airDate) === d).length);
    return barOption(cats.map(d => d + "s"), vals);
  },
  studio(){
    // topCount 的 keyFn 必须返回数组（作品可有多家制作公司），
    // 传入字符串会让 forEach 逐字符统计 —— 这是旧实现的一个隐性错误。
    const items = topCount(a => a.studios || [], state.anime, 8);
    return hbarOption(items.map(i => i[0]), items.map(i => i[1]));
  },
  genre(){
    const items = topCount(a => a.genres || [], state.anime, 8);
    return hbarOption(items.map(i => i[0]), items.map(i => i[1]));
  },
  status(){
    const counts = {};
    state.statuses.forEach(s => { counts[s.id] = 0; });
    state.anime.forEach(a => { if(counts[a.statusId] != null) counts[a.statusId]++; });
    const items = state.statuses.map(s => ({ name: s.name, value: counts[s.id] || 0 }))
      .filter(i => i.value > 0);
    return pieOption(items);
  },
  year(){
    const cats = allWatchYears();
    const vals = cats.map(y => state.anime.filter(a => yearOf(a.airDate) === y).length);
    return barOption(cats.map(String), vals, { label:false });
  }
};
function chartPanelHTML(kind, title, icon, fallbackHTML, height){
  return '<div class="panel"><div class="panel-head">' + ic(icon,16) + "<h3>" + esc(title) + "</h3></div>" +
    '<div class="chart-box"><div class="chart-el' + (height === "tall" ? " tall" : "") + '" data-chart="' + kind + '"></div>' +
    '<div data-fallback-for="' + kind + '" hidden>' + fallbackHTML + "</div></div></div>";
}
