/* ============================================================
   21.5 荣誉墙
   ------------------------------------------------------------
   两类荣誉：
   · 内置（BUILTIN_HONORS）—— 条件自动判定，配图是 AI 生成的怀旧场景（见 HONOR_ART）
   · 自定义（settings.custom_honors）—— 用户自己建，可传图；没图就用纯色玻璃背景
   两类共用同一套 ticket card 渲染，所以外观完全一致。
   ============================================================ */
const BUILTIN_HONORS = [
  { id:"h10",    cat:"看完数量", name:"初入番门",     desc:"看完 ≥ 10 部",                metric:"done", need:10,  art:"h10" },
  { id:"h30",    cat:"看完数量", name:"番剧常客",     desc:"看完 ≥ 30 部",                metric:"done", need:30,  art:"h30" },
  { id:"h60",    cat:"看完数量", name:"老二次元",     desc:"看完 ≥ 60 部",                metric:"done", need:60,  art:"h60" },
  { id:"h100d3", cat:"看完数量", name:"番剧考古学家", desc:"看完 ≥ 100 部且年代覆盖 ≥ 3",  metric:"done100_3",        art:"h100d3" },
  { id:"h200",   cat:"看完数量", name:"童年守墓人",   desc:"看完 ≥ 200 部",               metric:"done", need:200, art:"h200" },
  { id:"dec3",   cat:"年代",     name:"跨年代观众",   desc:"首播年代覆盖 ≥ 3 个",          metric:"decades", need:3,  art:"dec3" },
  { id:"old90",  cat:"年代",     name:"动画考古队员", desc:"库中最早作品首播早于 1990 年", metric:"oldest1990",        art:"old90" },
  { id:"rew10",  cat:"重看",     name:"回味者",       desc:"全库重看次数累计 ≥ 10",        metric:"rewatches", need:10, art:"rew10" },
  { id:"rew5",   cat:"重看",     name:"五刷大佬",     desc:"单部重看 ≥ 5 次",              metric:"maxRewatch", need:5, art:"rew10" },
  { id:"m10",    cat:"收藏",     name:"神作收藏家",   desc:"神作标记 ≥ 10",                metric:"masterpieces", need:10, art:"m10" },
  { id:"keng",   cat:"趣味",     name:"坑王",         desc:"弃坑 ≥ 10 且弃坑率 > 40%",     metric:"keng",                art:"keng" },
  { id:"mecha",  cat:"趣味",     name:"机战魂",       desc:"含机战/机甲类标签且看完 ≥ 10", metric:"mecha", need:10,   art:"mecha" }
];
/* 自定义荣誉存在 settings（localStorage）而不是 IndexedDB：
   它本质是「个人配置」而非「档案数据」，跟主题、密度等同属偏好。 */
function customHonors(){ return Array.isArray(settings.custom_honors) ? settings.custom_honors : []; }
function saveCustomHonors(list){ settings.custom_honors = list; saveSettings(); }
function allHonors(){
  return BUILTIN_HONORS.map(h => Object.assign({ builtin:true }, h))
    .concat(customHonors().map(h => Object.assign({ builtin:false }, h)));
}
function honorContext(){
  const list = state.anime;
  const doneList = list.filter(isDone);
  const decades = new Set();
  let oldest = null;
  list.forEach(a => {
    const d = decadeOf(a.airDate);
    if(d) decades.add(d);
    const y = yearOf(a.airDate);
    if(y && (oldest == null || y < oldest)) oldest = y;
  });
  const tags = (settings.mecha_tags || []).map(normalize);
  const mechaCount = doneList.filter(a => (a.genres || []).some(g => tags.indexOf(normalize(g)) >= 0)).length;
  const s = stats();
  return {
    done: doneList.length,
    decades: decades.size,
    oldest,
    rewatches: s.rewatches,
    maxRewatch: list.reduce((m,a) => Math.max(m, a.rewatchCount || 0), 0),
    masterpieces: s.masterpieces,
    drop: s.drop,
    dropRate: s.dropRate,
    total: list.length,
    mechaCount
  };
}
function honorStatus(h, ctx){
  // 自定义荣誉是「手动授予」：没有可自动计算的指标，由用户决定是否点亮。
  // 这样既保留自定的自由，又不会让自定义项永远灰着、看着像坏了。
  if(!h.builtin) return { got: !!h.awarded, cur: h.awarded ? 1 : 0, need: 1, unit:"" };
  switch(h.metric){
    case "done":         return { got: ctx.done >= h.need, cur: ctx.done, need: h.need, unit:"部" };
    case "done100_3":    return { got: ctx.done >= 100 && ctx.decades >= 3, cur: Math.min(ctx.done, ctx.decades * 40), need:100, unit:"部", extra: ctx.done >= 100 ? ("年代覆盖 " + ctx.decades + "/3") : null };
    case "decades":      return { got: ctx.decades >= h.need, cur: ctx.decades, need: h.need, unit:"个年代" };
    case "oldest1990":   return { got: ctx.oldest != null && ctx.oldest < 1990, cur: ctx.oldest == null ? 0 : 1, need:1, unit:"部", extra: ctx.oldest == null ? "还没有首播年份" : ("最早 " + ctx.oldest + " 年") };
    case "rewatches":    return { got: ctx.rewatches >= h.need, cur: ctx.rewatches, need: h.need, unit:"次" };
    case "maxRewatch":   return { got: ctx.maxRewatch >= h.need, cur: ctx.maxRewatch, need: h.need, unit:"次 / 单部" };
    case "masterpieces": return { got: ctx.masterpieces >= h.need, cur: ctx.masterpieces, need: h.need, unit:"部" };
    case "keng":         return { got: ctx.drop >= 10 && ctx.dropRate > 0.4, cur: ctx.drop, need:10, unit:"部弃坑", extra: "弃坑率 " + Math.round(ctx.dropRate*100) + "%" };
    case "mecha":        return { got: ctx.mechaCount >= h.need, cur: ctx.mechaCount, need: h.need, unit:"部机战" };
    default:             return { got:false, cur:0, need:1, unit:"" };
  }
}
const QUANT_ORDER = ["h10","h30","h60","h100d3","h200"];
function currentHonor(){
  const ctx = honorContext();
  let top = null;
  QUANT_ORDER.forEach(id => {
    const h = BUILTIN_HONORS.find(x => x.id === id);
    if(h && honorStatus(h, ctx).got) top = h;
  });
  const nextQuant = QUANT_ORDER.map(id => BUILTIN_HONORS.find(x => x.id === id))
    .find(h => h && !honorStatus(h, ctx).got) || null;
  const nx = nextQuant ? Object.assign({ name: nextQuant.name, need: honorStatus(nextQuant, ctx).need, cur: honorStatus(nextQuant, ctx).cur }) : null;
  return { topId: top ? top.id : null, nextQuant: nx, ctx };
}
/* 卡片背景三级回退（用户明确要求第 3 级存在且好看）：
   1) 自定义荣誉传了图 → 该图
   2) 内置荣誉 → AI 生成的 HONOR_ART
   3) 都没有 → 纯色玻璃（.tk-glass 的全息 conic 渐变），不是灰底 */
const honorArtCache = {};
function honorArtURL(h){
  if(h.builtin) return (typeof HONOR_ART !== "undefined" && HONOR_ART[h.art]) || "";
  if(!h.art) return "";
  return honorArtCache[h.id] || "";
}
/* 自定义荣誉的图存在 assets 里（key = h.art），需要异步读。
   读完后写入缓存并直接改 DOM 的 background-image，不整页重渲染 ——
   重渲染会让用户刚点开的弹窗抖动。 */
async function hydrateHonorArt(root){
  const list = customHonors().filter(h => h.art && !honorArtCache[h.id]);
  if(!list.length) return;
  let changed = false;
  for(const h of list){
    const v = await Repo.getAsset(h.art);
    if(v && typeof v === "string"){ honorArtCache[h.id] = v; changed = true; }
    else honorArtCache[h.id] = "";   // 资产丢失：记空，不再反复重试
  }
  if(!changed || !root) return;
  const wall = root.querySelector("#honor-wall");
  if(!wall) return;
  for(const h of list){
    const url = honorArtCache[h.id];
    if(!url) continue;
    const card = wall.querySelector('.tk[data-ch="' + (window.CSS && CSS.escape ? CSS.escape(h.id) : h.id) + '"]');
    if(!card) continue;
    const bg = card.querySelector(".tk-bg");
    if(!bg) continue;
    const glass = bg.querySelector(".tk-glass");
    if(glass) glass.remove();
    bg.classList.add("has-art");
    bg.style.backgroundImage = 'url("' + url + '")';
  }
}
/* 每个自定义荣誉一个稳定色相：按 id 散列到色环，
   纯色玻璃背景每次打开颜色一致，不会闪。 */
function honorTint(h){
  if(h.tint) return h.tint;
  let s = 0;
  const id = String(h.id || "");
  for(let i = 0; i < id.length; i++) s = (s * 31 + id.charCodeAt(i)) >>> 0;
  return "hsl(" + (s % 360) + " 62% 46%)";
}
function honorTicketHTML(h, has, ctx){
  const st = honorStatus(h, ctx);
  const pct = st.need ? Math.min(100, Math.round(st.cur / st.need * 100)) : (st.got ? 100 : 0);
  const art = honorArtURL(h);
  const tint = honorTint(h);
  const progress = has ? "" : '<div class="tk-progress"><i style="width:' + pct + '%"></i></div>';
  const foot = has
    ? '<div class="tk-foot"><span class="tk-seal">已获得</span><div class="tk-barcode" aria-hidden="true"></div></div>'
    : '<div class="tk-foot"><span class="tk-prog">' + st.cur + " / " + st.need + " " + esc(st.unit) + "</span></div>";
  return '<article class="tk' + (has ? " is-got" : "") + '"' + (h.builtin ? "" : ' data-ch="' + attr(h.id) + '"') + ">" +
    '<div class="tk-bg' + (art ? " has-art" : "") + '">' +
      (art
        ? '<img class="tk-art" src="' + attr(art) + '" alt="" loading="lazy" decoding="async">'
        : '<div class="tk-glass" style="--tk-tint:' + tint + '"></div>') +
    "</div>" +
    '<div class="tk-perf" aria-hidden="true"></div>' +
    '<div class="tk-head">' + ic(has ? "medal" : "lock", 18) + "<span>" + esc(h.name) + "</span></div>" +
    '<div class="tk-cat">' + esc(h.cat || "自定义") + "</div>" +
    '<div class="tk-desc">' + esc(h.desc || (has ? "自定义荣誉" : "尚未获得")) + "</div>" +
    progress + foot +
    (h.builtin ? "" :
      '<div class="tk-ops">' +
        '<button class="btn btn-sm" type="button" data-hact="toggle" data-hid="' + attr(h.id) + '">' + ic(has ? "check" : "plus", 13) + (has ? "取消授予" : "授予") + "</button>" +
        '<button class="btn btn-sm" type="button" data-hact="edit" data-hid="' + attr(h.id) + '" aria-label="编辑">' + ic("edit", 13) + "</button>" +
        '<button class="btn btn-sm btn-danger" type="button" data-hact="del" data-hid="' + attr(h.id) + '" aria-label="删除">' + ic("trash", 13) + "</button>" +
      "</div>") +
  "</article>";
}
function honorWallHTML(){
  if(!settings.module_honor) return "";
  const ctx = honorContext();
  const list = allHonors();
  const got = [], todo = [];
  list.forEach(h => { honorStatus(h, ctx).got ? got.push(h) : todo.push(h); });
  return '<div class="panel"><div class="panel-head">' + ic("medal",16) + "<h3>荣誉墙</h3>" +
    '<span class="hint">已获 ' + got.length + " / " + list.length + "</span>" +
    '<button class="btn btn-sm" type="button" data-hact="add" style="margin-left:var(--sp-3)">' + ic("plus",14) + "自定义荣誉</button></div>" +
    '<div class="tk-grid" id="honor-wall">' + got.map(h => honorTicketHTML(h, true, ctx)).join("") +
      todo.map(h => honorTicketHTML(h, false, ctx)).join("") + "</div>" +
    '<p class="hint mt-3">内置称号依据片库数据实时计算；自定义荣誉由你自己授予。没获得的荣誉显示为暗色卡面。</p>' +
  "</div>";
}
/* ---- 自定义荣誉的增删改 ---- */
function openHonorForm(existing){
  const base = existing || { name:"", cat:"自定义", desc:"" };
  const root = openModal({
    title: existing ? "编辑自定义荣誉" : "新建自定义荣誉",
    body:
      '<div class="field mb-3"><label for="hf-name">荣誉名称 *（1–12 字）</label>' +
        '<input class="input" id="hf-name" maxlength="12" value="' + attr(base.name) + '" data-autofocus></div>' +
      '<div class="field mb-3"><label for="hf-cat">分类（1–8 字）</label>' +
        '<input class="input" id="hf-cat" maxlength="8" value="' + attr(base.cat || "") + '" placeholder="例如：童年、毅力、收藏"></div>' +
      '<div class="field mb-3"><label for="hf-desc">说明（1–40 字）</label>' +
        '<input class="input" id="hf-desc" maxlength="40" value="' + attr(base.desc || "") + '"></div>' +
      '<div class="field"><label>背景图片（选填）</label>' +
        '<p class="hint mb-2">不传图片时使用纯色玻璃背景，按荣誉自动配色。</p>' +
        '<div class="row gap-2" style="flex-wrap:wrap">' +
          '<button class="btn btn-sm" type="button" id="hf-pick">' + ic("image",14) + "选择图片</button>" +
          '<button class="btn btn-sm" type="button" id="hf-clear"' + (base.art ? "" : " disabled") + '>' + ic("trash",14) + "移除图片</button>" +
          '<span class="hint" id="hf-artinfo">' + (base.art ? "已有背景图" : "当前为纯色玻璃") + "</span>" +
        "</div>" +
        '<div id="hf-thumb" class="hf-thumb mt-2">' + (base.art ? '<img alt="" src="">' : ic("image",22)) + "</div>" +
      "</div>",
    footer:(f) => {
      f.innerHTML = '<span class="hint" id="hf-msg"></span><div class="grow"></div>' +
        '<button class="btn" type="button" data-close="1">取消</button>' +
        '<button class="btn btn-primary" type="button" id="hf-save">保存</button>';
    }
  });
  const nameEl = root.querySelector("#hf-name");
  const catEl = root.querySelector("#hf-cat");
  const descEl = root.querySelector("#hf-desc");
  const thumb = root.querySelector("#hf-thumb");
  const artInfo = root.querySelector("#hf-artinfo");
  let newArtKey = null, removeArt = false;

  function refreshThumb(){
    const key = newArtKey || (removeArt ? null : (base.art || null));
    if(key && (honorArtCache[key] || newArtKey)){
      const url = honorArtCache[key];
      if(url){ thumb.innerHTML = '<img src="' + attr(url) + '" alt="">'; artInfo.textContent = "已选择背景图"; return; }
    }
    thumb.innerHTML = ic("image",22);
    artInfo.textContent = key ? "图片处理中…" : "当前为纯色玻璃";
  }
  // 已有图：从 assets 读出来显示缩略图
  if(base.art && !removeArt){
    const cached = honorArtCache[base.id];
    if(cached) refreshThumb();
    else{
      artInfo.textContent = "正在载入已有图片…";
      Repo.getAsset(base.art).then(v => {
        if(v && typeof v === "string"){ honorArtCache[base.id] = v; refreshThumb(); }
        else artInfo.textContent = "原图片已丢失，保存后将使用纯色玻璃";
      });
    }
  }
  root.querySelector("#hf-pick").addEventListener("click", () => {
    const inp = document.createElement("input");
    inp.type = "file"; inp.accept = "image/*";
    inp.addEventListener("change", async () => {
      const file = inp.files && inp.files[0];
      if(!file) return;
      const raw = await readFileAsDataURL(file);
      // 卡片背景不需要原图画质，压缩到长边 720 —— 否则 localStorage 降级模式下必然写不进
      const dataUrl = await compressBgImage(raw, 720, 0.8);
      const key = "honor_" + Date.now().toString(36);
      try{
        await Repo.setAsset(key, dataUrl);
        newArtKey = key;
        removeArt = false;
        honorArtCache["tmp_" + key] = dataUrl;
        // 缩略图直接用新图，不等缓存
        thumb.innerHTML = '<img src="' + attr(dataUrl) + '" alt="">';
        artInfo.textContent = "已选择背景图";
        root.querySelector("#hf-clear").disabled = false;
      }catch(e){
        toast(e && e.message === "QUOTA" ? "存储空间不足，请换一张小一点的图" : "图片处理失败：" + (e && e.message), "err", 5000);
      }
    });
    inp.click();
  });
  root.querySelector("#hf-clear").addEventListener("click", () => {
    newArtKey = null; removeArt = true;
    root.querySelector("#hf-clear").disabled = true;
    refreshThumb();
  });
  root.querySelector("#hf-save").addEventListener("click", () => {
    const name = nameEl.value.trim();
    if(!name){ root.querySelector("#hf-msg").innerHTML = '<span class="err-text">荣誉名称不能为空</span>'; return; }
    const list = customHonors().slice();
    const rec = existing
      ? Object.assign({}, existing, { name, cat: catEl.value.trim() || "自定义", desc: descEl.value.trim() })
      : { id: uid("h"), name, cat: catEl.value.trim() || "自定义", desc: descEl.value.trim(), awarded:false };
    if(newArtKey){
      rec.art = newArtKey;
      if(existing && existing.art && existing.art !== newArtKey){
        Repo.delAsset(existing.art).catch(() => {});   // 换图后清掉旧图，别让 assets 无限膨胀
      }
    }else if(removeArt){
      rec.art = "";
      if(existing && existing.art) Repo.delAsset(existing.art).catch(() => {});
    }
    if(existing){
      const i = list.findIndex(x => x.id === existing.id);
      if(i >= 0) list[i] = rec;
    }else{
      list.push(rec);
    }
    saveCustomHonors(list);
    closeModal();
    toast(existing ? "已更新" : "已创建自定义荣誉", "ok");
    refreshAll();
  });
}
async function honorAction(act, id){
  const list = customHonors();
  const i = list.findIndex(x => x.id === id);
  if(act === "add"){ openHonorForm(null); return; }
  if(i < 0) return;
  if(act === "toggle"){
    list[i].awarded = !list[i].awarded;
    saveCustomHonors(list);
    rerender();
    toast(list[i].awarded ? ("已授予「" + list[i].name + "」") : ("已取消「" + list[i].name + "」"), "ok", 2000);
    return;
  }
  if(act === "edit"){ openHonorForm(list[i]); return; }
  if(act === "del"){
    const ok = await confirmDialog({
      title:"删除自定义荣誉", danger:true, okText:"删除",
      html:"确定删除「" + esc(list[i].name) + "」吗？<br><span class=\"small muted\">它的背景图片也会一并删除，无法恢复。</span>"
    });
    if(!ok) return;
    if(list[i].art) Repo.delAsset(list[i].art).catch(() => {});
    list.splice(i, 1);
    saveCustomHonors(list);
    toast("已删除","ok");
    refreshAll();
  }
}
function bindHonorWall(root){
  root.querySelectorAll("[data-hact]").forEach(b => b.addEventListener("click", () => {
    honorAction(b.dataset.hact, b.dataset.hid);
  }));
  hydrateHonorArt(root);
}
function openHonorWall(){
  const root = openModal({
    title:"荣誉墙", wide:true,
    body: honorWallHTML(),
    footer:(f) => {
      f.innerHTML = '<span class="hint">称号实时计算，无需领取。</span><div class="grow"></div>' +
        '<button class="btn" type="button" data-close="1">关闭</button>';
    }
  });
  bindHonorWall(root);
}
