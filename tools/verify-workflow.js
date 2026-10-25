/* 校验 GitHub Pages 工作流声明的上线文件清单
 *
 * 为什么需要这个：workflow 里的 cp 命令列的是明文字符串，
 * 没有任何机制会在文件被改名/删除时报错 —— 少了 index.html
 * 就是线上直接 404，而报错发生在 GitHub 的部署日志里，离本地很远。
 * 这个脚本把「声明」与「磁盘实际」对齐，本地就能发现。
 *
 * 结构说明：upload-pages-artifact 的 path 参数只接受单个目录，
 * 不接受文件清单（历史上曾直接把多行清单塞给 path，导致每次
 * 部署都失败、线上停更在旧版）。所以现在的做法是先在
 * 「Assemble site directory」步骤里把四个文件 cp 进 site/，
 * 再 path: 'site' 整目录上传 —— 清单就是那行 cp 命令。
 *
 * 同时校验那份清单本身是否够用：
 *  - 必须含 index.html（Pages 站点根只解析这个文件名）
 *  - 必须含 anime-rewind.html（主应用）
 *  - 不能回到 path: '.'（会把 tools/ 与内部工作记录一起公开）
 *  - path 必须是组装目录（site），不能再是文件清单或整仓
 */
const fs = require("fs"), path = require("path");

const ROOT = path.join(__dirname, "..");
const YML = path.join(ROOT, ".github", "workflows", "static.yml");
const src = fs.readFileSync(YML, "utf8");

const checks = [];
const add = (name, ok, note) => checks.push({ name, ok: !!ok, note: note || "" });

// ---- 取出 cp 组装行 ----
/* 组装行形如：cp anime-rewind.html index.html LICENSE .nojekyll site/
   只认「Assemble site directory」步骤块里的第一行 cp，别处出现的 cp 不算。 */
const lines = src.split("\n");
const asmIdx = lines.findIndex(l => /name:\s*Assemble site directory/.test(l));
add("存在「Assemble site directory」组装步骤", asmIdx >= 0,
  asmIdx >= 0 ? "第 " + (asmIdx + 1) + " 行" : "未找到组装步骤");
const files = [];
if (asmIdx >= 0){
  const cpLine = lines.slice(asmIdx, asmIdx + 8).find(l => /^\s*cp\s+\S/.test(l));
  if (cpLine){
    const m = cpLine.trim().match(/^cp\s+(.+?)\s+site\/\s*$/);
    if (m) m[1].split(/\s+/).filter(Boolean).forEach(f => files.push(f));
  }
}
add("cp 清单解析出文件", files.length > 0, "共 " + files.length + " 个: " + files.join(", "));

// ---- path 参数必须是单个目录 ----
/* upload-pages-artifact@v3 只接受目录。path: | 多行清单 / path: '.' 都是错的。 */
const pathMatch = src.match(/upload-pages-artifact[\s\S]{0,200}?path:\s*['"]?([\w./-]+)['"]?\s*\n/);
add("upload-pages-artifact 的 path 指向组装目录 site",
  !!pathMatch && /^site\/?$/.test(pathMatch[1]),
  pathMatch ? ("实际是 " + pathMatch[1]) : "未找到 path 参数");
add("path 不再是多行文件清单（该写法会让部署静默失败）",
  !/path:\s*\|/.test(src), /path:\s*\|/.test(src) ? "仍是多行清单" : "");
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
