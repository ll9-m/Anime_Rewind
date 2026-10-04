/* 播放记录提示条（.stream-note）与选片卡（.pick-card）的对比度实测
 *
 * 为什么单独写：这两块是本轮新加的 UI，都用了 var(--accent) / var(--panel-2)，
 * 而这些令牌在 3 套 UI × 2 主题下取值都不同。9 种组合都要过 WCAG AA，
 * 不能靠「看起来没问题」。
 *
 * —— 写这个脚本时自己踩的三个坑，都记在下面，因为它们都会伪装成「产品已达标」——
 * 1) 以为颜色定义在 :root 里。实际全在 [data-theme="dark|light|glass"] 三个块中，
 *    :root 只有间距/字号/圆角这类结构令牌。取错块 → 全部报 null。
 * 2) 以为存在 [data-skin="archive"] 块。档案馆套系不覆写任何颜色，
 *    「块不存在」是正常状态，不该判为「令牌无法解析」。
 * 3) 拼接顺序错。resolve() 取首个匹配，所以字符串要按「低优先级 → 高优先级」拼，
 *    拼反了会读到被覆盖的旧值。
 */
const fs = require("fs");
const path = require("path");
const html = fs.readFileSync(path.join(__dirname, "..", "anime-rewind.html"), "utf8");

/* --- WCAG 相对亮度与对比度（纯函数） --- */
function hex2rgb(h){
  h = String(h).trim().replace("#", "");
  if (h.length === 3) h = h.split("").map(c => c + c).join("");
  if (h.length !== 6 || /[^0-9a-f]/i.test(h)) return null;
  return [parseInt(h.slice(0,2),16), parseInt(h.slice(2,4),16), parseInt(h.slice(4,6),16)];
}
const lin = v => { v /= 255; return v <= 0.04045 ? v/12.92 : Math.pow((v+0.055)/1.055, 2.4); };
const lum = rgb => 0.2126*lin(rgb[0]) + 0.7152*lin(rgb[1]) + 0.0722*lin(rgb[2]);
function ratio(a, b){
  const r1 = hex2rgb(a), r2 = hex2rgb(b);
  if (!r1 || !r2) return null;
  const l1 = lum(r1), l2 = lum(r2);
  return (Math.max(l1,l2) + 0.05) / (Math.min(l1,l2) + 0.05);
}
/* 只解一层 var()；解析不了返回 null，绝不猜一个值填进去。
 *
 * 用「按分号切声明 + 精确键匹配」而不是正则：正则里的字符类
 * （[;{\s]）在多层 shell 里转义层级多，很容易被吃掉一部分而静默失配 ——
 * 我在这上面浪费了一轮：正则明明看着对，却一直返回 null。
 * 纯字符串比较没有转义层，跨环境可靠。
 *
 * 还有第二个坑：按 ":" 定位键值分界时必须用 indexOf 而非 lastIndexOf。
 * 一行里常有多处冒号（`color:var(--text)` 里就有两个），
 * lastIndexOf 会落在 `var(` 后面，把键读成 "{ color" —— 永远匹配不上。
 *
 * 第三个坑：切分前必须剥注释。像素风里写着
 *   /* muted 原为 #5f574f，配 #c2c3c7 只有 4.02:1 … *\/
 *   --muted:#3a342e;
 * 不剥的话，注释和声明会粘在同一段里（分号在注释末尾之后），
 * 键被读成 "…-1 压深后升 --muted"，于是解析退回上一个作用域的值。
 * 症状是「报告某个像素风取值不对」，看着像产品配色问题，其实是解析器没剥注释。 */
function stripComments(css){
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}
function splitDecls(css){
  return stripComments(css).split(";").map(s => s.replace(/^[;{\s]+/, "").replace(/\s*}\s*$/, ""));
}
function pickDecl(decls, name){
  for (let i = 0; i < decls.length; i++){
    const d = decls[i];
    const ci = d.indexOf(":");
    if (ci < 0) continue;
    if (d.slice(0, ci).replace(/^\s+|\s+$/g, "") !== name) continue;
    const val = d.slice(ci + 1).replace(/^\s+|\s+$/g, "");
    if (val) return val;
  }
  return null;
}
function resolve(css, name){
  if (css.indexOf(name) < 0) return null;          // 先确认出现过，省掉全量切分
  const val = pickDecl(splitDecls(css), name);
  if (!val) return null;
  const vref = val.match(/var\(\s*(--[\w-]+)/);
  return vref ? resolve(css, vref[1]) : val;
}

/* 取块内容：sel 之后紧跟 {，配平大括号 */
function blockFor(sel){
  const i = html.indexOf(sel + "{");
  if (i < 0) return "";
  const open = i + sel.length;
  let depth = 0;
  for (let j = open; j < html.length; j++){
    if (html[j] === "{") depth++;
    else if (html[j] === "}") { depth--; if (depth === 0) return html.slice(open+1, j); }
  }
  return "";
}

const themes = { dark: blockFor('[data-theme="dark"]'), light: blockFor('[data-theme="light"]') };
/* :root 只提供默认值（--accent 等在这里），主题块会覆写其中一部分。
   漏掉 :root 会让 --accent 在 dark 下解析成 null ——
   「解析失败」看起来像产品缺变量，实际是作用域取窄了。 */
const rootVars = blockFor(":root");
const skins = {
  archive: "",                                          // 不覆写颜色，空是正确的
  pixel:   blockFor('[data-skin="pixel"]'),
  holo:    blockFor('[data-skin="holo"]'),
};
/* 像素/科技风对浅色主题另有覆写（浅底需重新挑深色） */
const lightSkin = {
  archive: "",
  pixel:   blockFor('[data-theme="light"][data-skin="pixel"]'),
  holo:    blockFor('[data-theme="light"][data-skin="holo"]'),
};
/* 低优先级 → 高优先级（resolve 取首个匹配，所以高优先级必须在前） */
function scopeFor(sk, th){
  return th === "light"
    ? lightSkin[sk] + skins[sk] + themes[th] + rootVars
    : skins[sk] + themes[th] + rootVars;
}

let pass = 0, fail = 0;
const bad = [];
function t(name, cond, detail){
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; bad.push(name + (detail ? " — " + detail : "")); console.log("  ✗ " + name + (detail ? "  → " + detail : "")); }
}

/* 强调数字的取值必须来自真实 CSS 规则，不能问「--accent 是什么」。
 * 第一版就是这么写的，于是我改成 .stream-note b{color:var(--text)} 之后，
 * 它仍然在报 #ff004d 3.55:1 —— 测的是令牌，不是这条规则实际用的值。
 * 这种「测试与被测对象脱钩」最危险：它对修复毫无反应，看着像失败，
 * 实际是我没测到点子上。 */
function resolveRule(scope, selector, prop){
  const i = html.indexOf(selector + "{");
  if (i < 0) return null;
  const open = i + selector.length;
  let depth = 0, end = open;
  for (let j = open; j < html.length; j++){
    if (html[j] === "{") depth++;
    else if (html[j] === "}") { depth--; if (depth === 0) { end = j; break; } }
  }
  const body = html.slice(open, end);
  const val = pickDecl(splitDecls(body), prop);
  if (!val) return null;
  const vref = val.match(/var\(\s*(--[\w-]+)/);
  return vref ? resolve(scope, vref[1]) : val;
}

console.log("=== .stream-note：提示条（强调数字 / 正文）===");
Object.keys(skins).forEach(sk => {
  ["dark", "light"].forEach(th => {
    const scope = scopeFor(sk, th);
    const strong = resolveRule(scope, ".stream-note b", "color");
    const panel2 = resolve(scope, "--panel-2");
    const text2  = resolve(scope, "--text-2");
    const border = resolve(scope, "--border");
    const label = sk + " / " + th;
    if (!strong || !panel2) { t(label + " 令牌可解析", false, "strong=" + strong + " panel-2=" + panel2); return; }
    const rs = ratio(strong, panel2);
    t(label + " 强调数字 " + strong + " on " + panel2, rs !== null && rs >= 4.5, rs === null ? "解析失败" : rs.toFixed(2) + ":1");
    if (text2) {
      const rt = ratio(text2, panel2);
      t(label + " 正文 " + text2 + " on " + panel2, rt !== null && rt >= 4.5, rt === null ? "解析失败" : rt.toFixed(2) + ":1");
    }
    if (border) {
      const rb = ratio(border, panel2);
      console.log("    · 边框 " + border + " on " + panel2 + " = " + (rb === null ? "解析失败" : rb.toFixed(2) + ":1") + "（分隔用，不设门槛）");
    }
  });
});

console.log("\n=== .pick-card：选片卡（卡名 / 副标题）===");
Object.keys(skins).forEach(sk => {
  ["dark", "light"].forEach(th => {
    const scope = scopeFor(sk, th);
    const panel2 = resolve(scope, "--panel-2");
    const text   = resolve(scope, "--text");
    const muted  = resolve(scope, "--muted");
    const label = sk + " / " + th;
    if (!panel2 || !text) { t(label + " 令牌可解析", false, "panel-2=" + panel2 + " text=" + text); return; }
    const r = ratio(text, panel2);
    t(label + " 卡名 " + text + " on " + panel2, r !== null && r >= 4.5, r === null ? "解析失败" : r.toFixed(2) + ":1");
    if (muted) {
      const rm = ratio(muted, panel2);
      t(label + " 副标题 " + muted + " on " + panel2, rm !== null && rm >= 4.5, rm === null ? "解析失败" : rm.toFixed(2) + ":1");
    }
  });
});

/* 钉死「强调数字用 --text 而不是 --accent」这条约束。
   不加这条的话，把 b{color} 改回 var(--accent) 只会让上面的 24 项变红，
   报错信息是「3.55:1」—— 看到的人未必会想到是规则本身退回了。 */
const strongRaw = (html.match(/\.stream-note b\{([^}]*)\}/) || [])[1] || "";
t(".stream-note b 显式用 var(--text)（不用 --accent）",
  /var\(\s*--text\s*\)/.test(strongRaw), strongRaw.trim());

console.log("\n通过 " + pass + " / " + (pass + fail));
if (fail) { console.log("\n不达标："); bad.forEach(b => console.log("  · " + b)); process.exit(1); }
console.log("全部达到 WCAG AA。");