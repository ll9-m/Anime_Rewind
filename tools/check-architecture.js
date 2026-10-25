/* 架构检查：模块契约 + 分层（高内聚低耦合的机械化守门）。
 *
 * 规则
 *  1. 产物一致性：src/ 按 manifest 拼接必须与 anime-rewind.html 字节级一致。
 *  2. 模块清单：manifest 里 shell/css/js 分组有序、文件齐全，js 模块带 section 横幅。
 *  3. 分层单向依赖：src/js 按文件序即层序（下标小 = 底层）。
 *     底层模块引用「只在更上层模块定义的顶层标识符」= 前向依赖 = 违规，
 *     除非登记在 ALLOWED_FORWARD（每条必须写原因 —— 耦合必须显式可见）。
 *     说明：整个主 script 在浏览器里是一次性求值的单作用域，
 *     前向引用能跑（函数提升），但它让底层隐式依赖高层，是耦合劣化的源头。
 *
 * 用法: node tools/check-architecture.js
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const ROOT = path.join(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "src", "manifest.json"), "utf8"));

let fail = 0;
const check = (name, ok, note) => {
  console.log((ok ? "PASS " : "FAIL ") + name + (note ? "  → " + note : ""));
  if(!ok) fail++;
};

/* ---- 1. 产物一致性 ---- */
let rebuilt = "";
for(const e of manifest) rebuilt += fs.readFileSync(path.join(ROOT, e.file), "utf8");
const artifact = fs.readFileSync(path.join(ROOT, "anime-rewind.html"), "utf8");
check("产物与 src/ 字节级一致", rebuilt === artifact,
  rebuilt === artifact ? "" : "先跑 node tools/build.js，或把产物改动搬回 src 模块");

/* ---- 2. 模块清单 ---- */
const jsMods = manifest.filter(e => e.file.startsWith("src/js/"));
const cssMods = manifest.filter(e => e.file.startsWith("src/css/"));
const shellMods = manifest.filter(e => e.file.startsWith("src/shell/"));
check("manifest 分组数（shell/css/js）", shellMods.length === 4 && cssMods.length >= 15 && jsMods.length >= 35,
  shellMods.length + "/" + cssMods.length + "/" + jsMods.length);
check("js 模块顺序 = manifest 出现顺序（层序即文件序）",
  JSON.stringify(jsMods) === JSON.stringify(manifest.filter(e => e.part === undefined || e.file.startsWith("src/js/")).filter(e => e.file.startsWith("src/js/"))), "");

/* js 模块必须有 section 横幅（数据模块除外） */
for(const e of jsMods){
  const text = fs.readFileSync(path.join(ROOT, e.file), "utf8");
  if(e.module === "data.honor-art") continue;
  const ok = /^\/\* ={10,}/m.test(text.slice(0, 400)) || /"use strict";/.test(text.slice(0, 40));
  if(!ok){ check("js 模块带 section 横幅：" + e.file, false, "模块必须以既有 section 横幅开头"); }
}
check("js 模块横幅契约", fail === 0);

/* ---- 3. 分层单向依赖 ---- */
/* 注释剥离 + 字符串内容掩码。
   逐字符扫描跟踪字符串状态（与 check.js 同思路；行尾仍开着的单双引号按行复位）。
   已知局限：正则字面量里的引号（如 normalize 的字符类）会让状态误判 ——
   因此配合「整行注释无条件剥离」双保险；残余误差只影响个别行，不影响结论。 */
function stripComments(text){
  let out = "", state = null;   // null | "'" | '"' | '`'
  const lines = text.split("\n");
  let inBlock = false;
  for(let line of lines){
    if(inBlock){
      const end = line.indexOf("*/");
      if(end < 0){ out += "\n"; continue; }
      inBlock = false;
      line = line.slice(end + 2);
    }
    const t = line.trim();
    if(t.startsWith("//") || t.startsWith("/*") || t.startsWith("*") || t.startsWith("*/")){
      if(t.startsWith("/*") && !t.includes("*/")) inBlock = true;   // 多行块注释开始
      out += "\n"; continue;                       // 整行注释：无条件丢弃
    }
    let lineOut = "", i = 0;
    while(i < line.length){
      const ch = line[i], next = line[i+1];
      if(state){
        if(ch === "\\"){ i += 2; continue; }       // 掩码字符串内容（含转义）
        if(ch === "\n" && state !== "`"){ state = null; break; }
        if(ch === state){ state = null; lineOut += ch; i++; continue; }
        i++; continue;                             // 字符串内容掩掉
      }
      if(ch === "/" && next === "/"){ break; }                 // 行注释
      if(ch === "/" && next === "*"){
        const end = line.indexOf("*/", i + 2);
        if(end < 0){ inBlock = true; i = line.length; break; }  // 块注释跨行：进入块状态
        i = end + 2; continue;
      }
      if(ch === "'" || ch === '"' || ch === "`"){ state = ch; lineOut += ch; i++; continue; }
      lineOut += ch; i++;
    }
    out += lineOut + "\n";
    if(state && state !== "`") state = null;
  }
  return out;
}

/* 每个模块的顶层标识符定义 */
const defsByMod = jsMods.map(e => {
  const raw = fs.readFileSync(path.join(ROOT, e.file), "utf8");
  const text = stripComments(raw);
  const defs = new Set();
  let m;
  const fnRe = /^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm;
  while((m = fnRe.exec(text))) defs.add(m[1]);
  const varRe = /^(?:const|let|var)\s+([A-Za-z_$][\w$]*)/gm;
  while((m = varRe.exec(text))) defs.add(m[1]);
  return { e, text, defs, raw };
});
/* 语法层校验：每个 js 模块单独可编译（片段允许未定义引用，只查语法） */
for(const d of defsByMod){
  try{ new vm.Script(d.raw, { filename: d.e.file }); }
  catch(err){
    check("js 模块语法：" + d.e.file, false, String(err && err.message).slice(0, 120));
  }
}
check("js 模块语法完整", fail === 0);

/* 跨模块引用矩阵 → 前向依赖。
   匹配排除两类噪音：属性/键访问（X.state、settings:）与 data 模块（base64 墙）。 */
/* 显式允许清单：登记「底层 → 高层」的既有前向引用，每条必须写原因。
   新增前向依赖会被直接 FAIL —— 想加，先想清楚为什么不该反转层次。 */
const ALLOWED_FORWARD = {
  /* 放映厅簇：放映厅是「页面装配层」，详情页/启动器/原生播放器互相咬合，
     且启动器要跨页跳台账（带筛选状态）。装配层引用兄弟页面属于既成结构，
     拆解它们需要页面级重构而非层次调整，先显式登记。 */
  "ledgerState":   ["js.9-播放源管理", "启动器「去台账」按钮带片名跳台账页，装配层引用兄弟页面的页内状态"],
  "settingsState": ["js.设置页", "首页「去设置」直达数据 tab，需要设置页的 tab 状态"],
  "openHonorWall": ["js.启动", "待机/启动流程重开荣誉墙（荣誉墙标志位在通用 UI 层）"],
  "openSearchModal": ["js.添加新番搜索-选源-表单-入库", "TV 影院空态/工具条的「添加」直达搜索弹窗，页面装配引用相邻页面流程"]
};
const forward = [];
for(let i = 0; i < defsByMod.length; i++){
  const low = defsByMod[i];
  if(low.e.module === "data.honor-art") continue;
  const higherDefs = new Map();
  for(let j = i + 1; j < defsByMod.length; j++){
    for(const id of defsByMod[j].defs) if(!higherDefs.has(id)) higherDefs.set(id, j);
  }
  for(const [id, j] of higherDefs){
    const re = new RegExp("(?<![.\\w$\"'])" + id.replace(/\$/g, "\\$") + "(?!\\s*:[^/])(?![\\w$])");
    if(re.test(low.text)){
      forward.push({ from: low.e.module, to: defsByMod[j].e.module, id });
    }
  }
}
const unallowed = forward.filter(f => {
  const key = f.id;
  const a = ALLOWED_FORWARD[key];
  return !a || a[0] !== f.to || !a[1];
});
console.log("");
console.log("前向依赖（底层引用上层）总计: " + forward.length + "，未登记: " + unallowed.length);
forward.forEach(f => console.log("  " + f.from + "  →  " + f.to + "  :: " + f.id +
  (ALLOWED_FORWARD[f.id] ? "（已登记）" : "")));
check("无未登记的前向依赖", unallowed.length === 0,
  unallowed.length ? "在 ALLOWED_FORWARD 登记并写明原因，或反转依赖" : "");

console.log("");
if(fail){ console.log("架构检查未通过 " + fail + " 项"); process.exit(1); }
console.log("架构检查全部通过");
