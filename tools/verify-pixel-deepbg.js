/* 像素风「深底文字修正」的存在性与特异性验证
 *
 * 为什么单独写这个文件：
 * 上一轮我用一条内联 -e 命令去 grep 刚写入的 CSS 规则，报「未找到」，
 * 但读文件确认规则其实在。原因是多层 shell 里的正则转义被逐层吃掉 ——
 * 检查脚本自身的 bug 会伪装成「产品有缺陷」。
 * 本文件改为「字符串包含 + 逐条精确匹配」，不含正则，零转义风险。
 */
const fs = require("fs");
const path = require("path");

const html = fs.readFileSync(path.join(__dirname, "..", "anime-rewind.html"), "utf8");
const fails = [];
function ok(label, cond, detail){
  if(cond) console.log("  ✓ " + label + (detail ? "  → " + detail : ""));
  else fails.push(label + (detail ? "  → " + detail : ""));
}

console.log("=== 像素风深底文字修正 ===\n");

// 1) 每条规则以完整字面量出现（不做正则匹配，避免转义风险）
const RULES = [
  ['[data-skin="pixel"] #topbar .page-title{', "顶栏标题改亮色"],
  ['[data-skin="pixel"] #topbar .page-sub{',   "顶栏副标题改亮色"],
  ['[data-skin="pixel"] #topbar .btn-ghost{',  "顶栏幽灵按钮改亮色"],
  ['[data-skin="pixel"] #sidebar{',            "侧栏分隔线改亮色"]
];
RULES.forEach(([lit, desc]) => {
  const at = html.indexOf(lit);
  ok(desc + " 规则存在", at >= 0, at >= 0 ? "第 " + (html.slice(0, at).split("\n").length) + " 行" : "未找到字面量 " + lit);
});

// 2) 令牌必须同时存在定义与使用
const px = html.match(/\[data-skin="pixel"\]\{([\s\S]*?)\n\}/);
ok("找到 [data-skin=\"pixel\"] 变量块", !!px);
const TOKENS = ["--text-on-bg", "--text-2-on-bg"];
TOKENS.forEach(t => {
  const defined = px && px[1].indexOf(t + ":") >= 0;
  const used = html.indexOf("var(" + t + ")") >= 0;
  ok(t + " 已定义", !!defined);
  ok(t + " 被使用", used);
});

// 3) 特异性检查：顶栏覆盖必须能压过像素风通配的 h1 规则
//    像素风 h1 规则是 [data-skin="pixel"] h1（特异度 0,1,1），
//    顶栏覆盖是 [data-skin="pixel"] #topbar .page-title（0,2,1）—— 必须更高。
function specificity(sel){
  const m = sel.match(/#([\w-]+)|\.([\w-]+)|(\[[^\]]+\])|(:[a-z-]+)|([\w-]+)/g) || [];
  let id = 0, cls = 0, attr = 0, pseudo = 0, tag = 0;
  m.forEach(tok => {
    if(tok[0] === "#") id++;
    else if(tok[0] === ".") cls++;
    else if(tok[0] === "[") attr++;
    else if(tok[0] === ":") pseudo++;
    else tag++;
  });
  return { id, cls, attr, s: id*100 + cls*10 + attr };
}
const base = specificity('[data-skin="pixel"] h1');            // 0,1,1 -> 11
const over = specificity('[data-skin="pixel"] #topbar .page-title'); // 0,2,1 -> 21
ok("顶栏覆盖特异性高于像素风 h1 通配",
   over.s > base.s,
   "h1=" + base.s + " < 覆盖=" + over.s);
ok("且源码中覆盖规则位于 h1 规则之后（层叠顺序正确）",
   html.indexOf('[data-skin="pixel"] #topbar .page-title{') > html.indexOf('[data-skin="pixel"] h1,'));

// 4) 复用陷阱检查：顶栏覆盖不得把米色面板里的文字也改亮
//    .brand-text / .nav-item / .side-honor 都在米色侧栏内，必须保持黑色系。
[".brand-text span", ".nav-item{", ".side-honor small"].forEach(sel => {
  const bad = html.indexOf('[data-skin="pixel"] ' + sel) >= 0;
  ok("未误覆写 " + sel + "（它在米色侧栏内，改亮色会看不清）", !bad);
});

console.log("\n=== 结果 ===");
if(fails.length){
  console.log("失败 " + fails.length + " 项：");
  fails.forEach(f => console.log("  · " + f));
  process.exit(1);
}
console.log("全部通过。");
