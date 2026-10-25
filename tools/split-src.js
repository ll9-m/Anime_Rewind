/* 一次性拆分：把 anime-rewind.html 按既有 section 横幅切成 src/ 模块。
 * 方法：以字节偏移精确切片，src 文件内容 = 产物原字节（不改一字），
 *       build = 纯拼接 ⇒ 重新构建与现产物必然字节级一致。
 * 用法: node tools/split-src.js
 */
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");
const raw = fs.readFileSync(path.join(ROOT, "anime-rewind.html"), "utf8");

const styleOpen = raw.indexOf("<style>");
const styleClose = raw.indexOf("</style>");
const b0open = raw.indexOf("<script>");
const b0close = raw.indexOf("</script>", b0open);
const b1open = raw.indexOf("<script>", b0close);
const b1close = raw.lastIndexOf("</script>");

/* 模块边界 = 横幅「开行」（多行横幅的收尾与正文自然随本模块走）。
   开行形如：/* ============ （行首 /* + 长等号 + 行尾） */
const BANNER_OPEN = /^\/\*[ ]={10,}[ \t]*\r?\n/gm;

function splitRegion(fromByte, toByte){
  const starts = [];
  BANNER_OPEN.lastIndex = fromByte;
  let m;
  while((m = BANNER_OPEN.exec(raw)) && m.index < toByte){
    const titleLine = raw.slice(m.index + m[0].length, m.index + m[0].length + 120).split("\n")[0].trim();
    starts.push({ byte:m.index, title:titleLine });
  }
  const parts = [];
  for(let i = 0; i < starts.length; i++){
    const start = starts[i].byte;
    const end = (i + 1 < starts.length) ? starts[i+1].byte : toByte;
    if(start > fromByte && parts.length === 0){
      /* 首横幅之前的真·前导（"use strict";）并入第一个模块 */
      parts.push({ start:fromByte, end, title:starts[i].title });
    }else{
      parts.push({ start, end, title:starts[i].title });
    }
  }
  if(!parts.length) parts.push({ start:fromByte, end:toByte, title:"(整段)" });
  return parts;
}

const cssParts = splitRegion(styleOpen + "<style>".length, styleClose);
const jsParts = splitRegion(b1open + "<script>".length, b1close);
console.log("CSS 段:", cssParts.length, " JS 段:", jsParts.length);
jsParts.forEach((p, i) => console.log("  js[" + i + "] " + p.title.slice(0, 44)));

function slug(t){
  const n = t.replace(/^(\d+(?:\.\d+)?)[\.、]\s*/, "")
    .replace(/[（(][^）)]*[）)]/g, "")
    .replace(/[·/／、\s]+/g, "-")
    .replace(/[^\w\u4e00-\u9fa5-]/g, "")
    .replace(/-+/g, "-").replace(/^-|-$/g, "");
  return (n || "part").slice(0, 24);
}

fs.rmSync(path.join(ROOT, "src"), { recursive:true, force:true });
fs.mkdirSync(path.join(ROOT, "src/shell"), { recursive:true });
fs.mkdirSync(path.join(ROOT, "src/css"), { recursive:true });
fs.mkdirSync(path.join(ROOT, "src/js"), { recursive:true });

const manifest = [];
function write(file, text){ fs.writeFileSync(path.join(ROOT, file), text); }
function push(file, module, desc, bytes){ manifest.push({ file, module, desc, bytes }); }

write("src/shell/00-head.html", raw.slice(0, styleOpen + "<style>".length));
push("src/shell/00-head.html", "shell.head", "doctype/meta/字体与 <style> 开标签", styleOpen + 7);

const usedNames = new Set();
function emitCss(p, i){
  let name = "src/css/" + String(i+1).padStart(2,"0") + "-" + slug(p.title) + ".part";
  let k = 2;
  while(usedNames.has(name)) name = "src/css/" + String(i+1).padStart(2,"0") + "-" + slug(p.title) + "-" + (k++) + ".part";
  usedNames.add(name);
  write(name, raw.slice(p.start, p.end));
  push(name, "css." + slug(p.title), "CSS：" + p.title, p.end - p.start);
}
cssParts.forEach(emitCss);

write("src/shell/01-mid.html", raw.slice(styleClose, b0open + "<script>".length));
push("src/shell/01-mid.html", "shell.mid", "</style>、body 静态外壳、荣誉配图 script 开标签", b0open + 9 - styleClose);
write("src/js/00-honor-art.js", raw.slice(b0open + "<script>".length, b0close));
push("src/js/00-honor-art.js", "data.honor-art", "荣誉墙配图 dataURL（tools/build-honor-art.js 生成，勿手改）", b0close - b0open - 8);
write("src/shell/01b-close.html", raw.slice(b0close, b1open + "<script>".length));
push("src/shell/01b-close.html", "shell.between", "</script> 与主应用 <script> 开标签", b1open + 9 - b0close);

jsParts.forEach((p, i) => {
  let name = "src/js/" + String(i+1).padStart(2,"0") + "-" + slug(p.title) + ".part";
  let k = 2;
  while(usedNames.has(name)) name = "src/js/" + String(i+1).padStart(2,"0") + "-" + slug(p.title) + "-" + (k++) + ".part";
  usedNames.add(name);
  write(name, raw.slice(p.start, p.end));
  push(name, "js." + slug(p.title), "JS：" + p.title, p.end - p.start);
});

write("src/shell/02-tail.html", raw.slice(b1close));
push("src/shell/02-tail.html", "shell.tail", "</script></body></html>", raw.length - b1close);

fs.writeFileSync(path.join(ROOT, "src/manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

let rebuilt = "";
for(const e of manifest) rebuilt += fs.readFileSync(path.join(ROOT, e.file), "utf8");
if(rebuilt === raw) console.log("回环校验：字节级一致 ✓  共", manifest.length, "个模块");
else{
  console.log("回环校验：不一致 ✗  长度", raw.length, "vs", rebuilt.length);
  for(let i = 0; i < Math.min(raw.length, rebuilt.length); i++){
    if(raw[i] !== rebuilt[i]){ console.log("首个差异@", i, JSON.stringify(raw.slice(i-40, i+40)), "vs", JSON.stringify(rebuilt.slice(i-40, i+40))); break; }
  }
  process.exit(1);
}
