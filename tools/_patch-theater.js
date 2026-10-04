// 替换「外部播放器 + 待机屏保」整块（按作品保存片源与集数）
const fs = require('fs');
const F = 'anime-rewind.html';
const lines = fs.readFileSync(F, 'utf8').split('\n');

// 1-based: 3879 = "/* 播放器输入区。URL 持久化到 settings.stream_url ..." 行
const START = 3879, STOP = 3973;   // 保留 3974 行起的 renderStandby（下一步单独删）
if(!/播放器输入区/.test(lines[START-1])) throw new Error('START 锚点不符: ' + lines[START-1]);
if(!/^function renderStandby\(root\)\{/.test(lines[STOP])) throw new Error('STOP 锚点不符: ' + lines[STOP]);

const block = `/* 外部播放器区。
 *
 * 数据归属（这是本轮最关键的改动）：
 *   原先存在 settings.stream_url —— 全局一份，于是「给 A 番粘的片源」
 *   会在打开 B 番时被当成 B 番的片源。用户的原话是「不用每次都输入
 *   这部番的链接」，全局一份在语义上根本满足不了。
 *   现在按作品存：a.streamUrl（片源）+ a.streamEp（看到第几集）。
 *   settings.stream_url 保留为「无作品时的临时片源」，不删以免旧数据失效。
 *
 * 集数记录的现实约束：B 站分 P 用 ?p=，YouTube 用 &start=（秒），
 * 两者无法统一换算。所以只做「用户自己声明看到第几集」的轻量记录，
 * 不假装能从播放进度反推 —— 那需要跨域读取播放器内部状态，做不到。
 */
function streamURLOf(a){
  if(a && a.streamUrl) return a.streamUrl;
  return settings.stream_url || "";
}
/* 把声明的集数写回地址。分 P 制（B 站）能对上就改 p=，
 * 其余平台原样返回 —— 改不了总比改错好。 */
function applyEpToURL(raw, ep){
  const u = normalizeStreamURL(raw);
  if(!u || ep == null) return u;
  try{
    const url = new URL(u);
    if(/(^|\\.)bilibili\\.com$/i.test(url.hostname)){
      url.searchParams.set("p", String(ep));
      return url.href;
    }
  }catch(e){}
  return u;
}
function renderStreamLauncher(a){
  const u = streamURLOf(a);
  const has = !!u;
  const ep = a && a.streamEp != null ? a.streamEp : null;
  return '<div class="panel stream-panel mt-4"><div class="panel-head">' + ic("film",16) +
    "<h3>外部播放器</h3>" +
    '<span class="hint">' + (a ? "片源按这部作品保存，换番不会互相覆盖" : "临时片源（未选作品）") + "</span></div>" +
    '<p class="small muted mb-3">粘一个播放网址（YouTube / 哔哩哔哩 / Vimeo，或任意允许嵌入的网站）。' +
    "本应用会自动把常见分享链接转换成播放器地址；保存后下次打开这部作品直接续播。</p>" +
    '<div class="row gap-2" style="flex-wrap:wrap">' +
      '<div class="search-wrap" style="flex:1 1 320px;max-width:none">' + ic("link",16) +
        '<input class="input" id="st-url" type="url" inputmode="url" spellcheck="false" ' +
        'placeholder="https://www.bilibili.com/video/BV... 或 https://youtu.be/..." value="' + attr(u) + '">' +
      "</div>" +
      '<div class="field" style="flex:0 0 132px"><label for="st-ep">看到第几集</label>' +
        '<input class="input" id="st-ep" type="number" inputmode="numeric" min="1" step="1" ' +
        'placeholder="—" value="' + (ep == null ? "" : ep) + '"></div>' +
    "</div>" +
    '<div class="row gap-2 mt-3" style="flex-wrap:wrap">' +
      '<button class="btn btn-primary" type="button" data-st="play">' + ic("play",14) + "播放</button>" +
      '<button class="btn" type="button" data-st="save">' + ic("check",14) + "保存片源与进度</button>" +
      '<button class="btn" type="button" data-st="open">' + ic("external",14) + "新标签打开</button>" +
      '<button class="btn btn-sm" type="button" data-st="clear" title="清除已保存的片源"' + (has ? "" : " hidden") + ">" + ic("trash",14) + "</button>" +
    "</div>" +
    (has && ep != null
      ? '<div class="note-box is-ok mt-3">' + ic("check",16) + "<span>已保存：第 " + esc(String(ep)) + " 集</span></div>"
      : '<div id="st-status" class="note-box is-warn mt-3">' + ic("info",16) +
        "<span>" + (has ? "已保存片源，直接点「播放」续上次的进度。" : "尚未保存。多数网站禁止被第三方网站嵌入，遇到白屏属正常现象，用「新标签打开」总能观看。") + "</span></div>") +
    '<div id="st-mount" class="stream-mount mt-3" hidden></div>' +
  "</div>";
}
/* 清除按钮的显示不能只看渲染那一刻的持久化状态：
   用户常常是「先粘网址 → 才想到保存」，此时页面并未重渲染，
   按钮就永远不出现。改为依据输入框实时取值。 */
function syncStreamLauncher(root){
  const input = root.querySelector("#st-url");
  const open = root.querySelector('[data-st="open"]');
  const clear = root.querySelector('[data-st="clear"]');
  const has = !!(input && input.value.trim());
  if(open) open.disabled = !has;
  if(clear) clear.hidden = !has;
}
function bindStreamLauncher(root, a){
  const input = root.querySelector("#st-url");
  const epInput = root.querySelector("#st-ep");
  const mount = root.querySelector("#st-mount");
  const status = root.querySelector("#st-status");
  if(!input || !mount) return;
  let cleanup = null;

  function setStatus(kind, text){
    if(!status) return;
    status.className = "note-box mt-3 " + (kind === "ok" ? "is-ok" : kind === "warn" ? "is-warn" : "is-err");
    status.innerHTML = (kind === "ok" ? ic("check",16) : kind === "warn" ? ic("warning",16) : ic("info",16)) +
      "<span>" + text + "</span>";
  }
  function showError(msg){ if(cleanup){ cleanup(); cleanup = null; } mount.hidden = true; mount.innerHTML = ""; setStatus("err", msg); }
  function readEp(){
    const v = epInput ? epInput.value.trim() : "";
    if(v === "") return null;
    const n = Number(v);
    if(!Number.isInteger(n) || n < 1) return NaN;   // NaN = 用户填了非法值，需要提示
    return n;
  }
  function effectiveURL(){
    const ep = readEp();
    return applyEpToURL(input.value, ep != null && !isNaN(ep) ? ep : null);
  }

  function play(){
    const raw = effectiveURL();
    if(!raw || !input.value.trim()){ showError("请先填一个播放网址"); return; }
    const res = resolveEmbed(raw);
    if(!res.ok){ showError(res.reason); return; }
    mount.hidden = false;
    // 每次播放前先清掉上一个 iframe 的网络与计时器，否则快速连点会叠出多个播放器
    if(cleanup) cleanup();
    setStatus("warn", "正在加载 " + res.rule.name + " 播放器…");
    cleanup = mountStreamPlayer(mount, raw, status);
  }
  /* 保存：不整页重渲染。rerender() 会把 iframe 销毁掉，
     正在播的视频会被打断 —— 保存只是存数据，没必要牺牲播放状态。 */
  async function save(){
    const raw = input.value.trim();
    const ep = readEp();
    if(isNaN(ep)){ showError("集数必须是大于 0 的整数"); return; }
    if(raw && !resolveEmbed(raw).ok){ showError("网址无法识别，未保存"); return; }
    if(!a){ showError("请先从片库打开一部作品，再保存片源"); return; }
    a.streamUrl = raw;
    a.streamEp = ep;
    a.streamUrlAt = raw ? new Date().toISOString() : "";
    await saveAnime(a);
    const note = root.querySelector(".stream-panel .note-box");
    if(note){
      note.className = "note-box is-ok mt-3";
      note.innerHTML = ic("check",16) + "<span>" + (raw
        ? "已保存" + (ep != null ? "，下次从第 " + ep + " 集续播" : "")
        : "已清除片源") + "</span>";
    }
    syncStreamLauncher(root);
    toast(raw ? "片源已保存" : "已清除片源", "ok");
  }

  root.querySelectorAll("[data-st]").forEach(b => b.addEventListener("click", () => {
    const act = b.dataset.st;
    if(act === "play"){ play(); return; }
    if(act === "save"){ save(); return; }
    if(act === "open"){
      const u = normalizeStreamURL(effectiveURL());
      if(!u){ setStatus("err", "网址无效，无法打开"); return; }
      window.open(u, "_blank", "noopener,noreferrer");
      return;
    }
    if(act === "clear"){
      if(cleanup){ cleanup(); cleanup = null; }
      mount.hidden = true; mount.innerHTML = "";
      input.value = "";
      if(epInput) epInput.value = "";
      if(a){
        a.streamUrl = ""; a.streamEp = null; a.streamUrlAt = "";
        saveAnime(a);
      }else{
        settings.stream_url = ""; saveSettings();
      }
      syncStreamLauncher(root);
      setStatus("warn", "已清除保存的片源。");
    }
  }));
  input.addEventListener("keydown", e => {
    if(e.key === "Enter"){ e.preventDefault(); play(); }
  });
  input.addEventListener("input", debounce(() => {
    syncStreamLauncher(root);
    if(resolveEmbed(input.value).ok) setStatus("warn", "地址可识别，按「播放」开始。");
  }, 350));
  syncStreamLauncher(root);
  // 切走时务必断开 iframe，否则外部站点的音频/视频会继续在后台播放
  window.addEventListener("pagehide", () => { if(cleanup) cleanup(); }, { once:true });
}
`;
lines.splice(START - 1, STOP - START + 1, block);
fs.writeFileSync(F, lines.join('\n'));
console.log('已替换 3879-3973，共', STOP - START + 1, '行 →', block.split('\n').length, '行');