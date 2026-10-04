/* 校验 GitHub Pages 工作流声明的上传文件清单
 *
 * 为什么需要这个：workflow 里path: 块列的是明文字符串，
 * 没有任何机制会在文件被改名/删除时报错 —— 少了index.html
 * 就是线上直接 404，而报错发生在 GitHub 的部署日志里，离本地很远。
 * 这个脚本把「声明」与「磁盘实际」对齐，本地就能发现。
 *
 * 同时校验那份清单本身是否够用：
 *  - 必须含 index.html（Pages 站点根只解析这个文件名）
 *  - 必须含 anime-rewind.html（主应用）
 *  - 不能再含 path: '.'（会把 tools/ 与内部工作记录一起公开）
 */
const fs = require("fs"), path = require("path");

const ROOT = path.join(__dirname, "..");
const YML = path.join(ROOT, ".github", "workflows", "static.yml");
const src = fs.readFileSync(YML, "utf8");

const checks = [];
const add = (name, ok, note) => checks.push({ name, ok: !!ok, note: note || "" });

// ---- 取出 path: | 块 ----
/* 块的结束判据是「出现缩进少于 path 的行」，不能只靠「行首缩进 + 非空」——
   后面 steps 段的缩进更浅，但正则若写成匹配到文件尾就会把 - name: Deploy
   之类也当成清单项。按行逐个扫，缩进一旦回退即停。 */
const lines = src.split("\n");
const pathIdx = lines.findIndex(l => /^\s*path:\s*\|\s*$/.test(l));
add("工作流使用 path: | 多行块", pathIdx >= 0,
  pathIdx >= 0 ? "第 " + (pathIdx + 1) + " 行" : "未找到 path: | 块");
const files = [];
if (pathIdx >= 0){
  const indent = (lines[pathIdx].match(/^\s*/) || [""])[0].length;
  for (let i = pathIdx + 1; i < lines.length; i++){
    const l = lines[i];
    if (!l.trim()) continue;
    const ind = (l.match(/^\s*/) || [""])[0].length;
    if (ind <= indent) break;          // 缩进回退 = 块结束
    const t = l.trim();
    if (t.startsWith("#")) continue;   // 注释行不是清单项
    files.push(t);
  }
}
add("声明了具体文件清单", files.length > 0, "共 " + files.length + " 个: " + files.join(", "));

// ---- path: '.' 会公开整个仓库 ----
add("不再用 path: '.' 上传整个仓库", !/path:\s*['"]?\.\s*['"]?\s*$/m.test(src),
  /path:\s*['"]?\.\s*['"]?\s*$/m.test(src) ? "仍为整仓上传" : "");

// ---- 逐个查磁盘 ----
files.forEach(f => {
  const p = path.join(ROOT, f);
  const ex = fs.existsSync(p) && fs.statSync(p).isFile();
  add("清单文件存在：" + f, ex, ex ? (fs.statSync(p).size + " 字节") : "磁盘上找不到");
});

// ---- 清单必须够用 ----
add("清单含 index.html（Pages 根只解析这个名）", files.includes("index.html"), "");
add("清单含 anime-rewind.html（主应用）", files.includes("anime-rewind.html"), "");
add("清单含 LICENSE（CC BY-NC 4.0 要求许可随作品分发）", files.includes("LICENSE"), "");

// ---- 不该上线的东西确实没被声明 ----
["tools/smoke.js", ".workbuddy/memory/2026-10-04.md", "README.md"]
  .forEach(f => add("未声明上线：" + f, !files.includes(f), ""));

// ---- 站点根跳转链路完整 ----
const idx = path.join(ROOT, "index.html");
if (fs.existsSync(idx)){
  const html = fs.readFileSync(idx, "utf8");
  add("index.html 跳转到 anime-rewind.html",
    /location\.replace\("anime-rewind\.html"\)/.test(html), "");
  add("index.html 带 CC BY-NC 4.0 署名 meta",
    /<meta name="license" content="CC BY-NC 4\.0">/.test(html), "");
  add("index.html 带 nojekyll 无关但含 canonical", /rel="canonical"/.test(html), "");
}

const pass = checks.filter(c => c.ok).length;
checks.forEach(c => console.log((c.ok ? "  ok   " : "  FAIL ") + c.name + (c.note ? "  [" + c.note + "]" : "")));
console.log("\n通过 " + pass + " / " + checks.length);
if (pass < checks.length){
  console.log("--- 未通过 ---");
  checks.filter(c => !c.ok).forEach(c => console.log("  FAIL " + c.name + "  " + c.note));
  process.exitCode = 1;
}
