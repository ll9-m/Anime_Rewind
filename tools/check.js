// 语法校验 + 引号配对 lint
// 1) 抽取 html 中所有内联 <script>，用 vm.Script 逐个编译
// 2) 逐行扫描：剔除注释后模拟字符串状态，报告"行尾仍处于字符串内"的可疑行
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const target = process.argv[2] || path.join(__dirname, "..", "anime-rewind.html");
const html = fs.readFileSync(target, "utf8");
const blocks = [];
const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
let m;
while ((m = re.exec(html))) blocks.push({ code: m[1], index: m.index });

let fail = 0;
blocks.forEach((b, i) => {
  const line = html.slice(0, b.index).split("\n").length;
  try {
    new vm.Script(b.code, { filename: "block-" + i + ".js" });
    console.log("OK   block#" + i + "  html line " + line + "  (" + b.code.split("\n").length + " lines)");
  } catch (e) {
    fail++;
    console.log("FAIL block#" + i + "  starts at html line " + line + " :: " + String(e && e.message));
    const ln = Number((e.stack.match(/block-\d+\.js:(\d+)/) || [])[1] || 0);
    const lines = b.code.split("\n");
    const htmlStart = html.slice(0, b.index).split("\n").length - 1;
    for (let d = -2; d <= 1; d++) {
      const n = ln + d;
      if (n >= 1 && n <= lines.length) console.log("     " + String(htmlStart + n).padStart(5) + (d === 0 ? " >> " : "    ") + lines[n - 1]);
    }
  }
});

// ---- 引号配对 lint ----
const suspicious = [];
blocks.forEach((b) => {
  const htmlStart = html.slice(0, b.index).split("\n").length - 1;
  const lines = b.code.split("\n");
  let inStr = null;
  lines.forEach((raw, i) => {
    let line = raw;
    // 剔除行注释（行内 // 不在字符串中的情况）
    let cleaned = "", local = inStr;
    for (let j = 0; j < line.length; j++) {
      const c = line[j];
      if (local) {
        cleaned += c;
        if (c === local) local = null;
        continue;
      }
      if (c === "/" && line[j + 1] === "/") break;
      cleaned += c;
      if (c === "'" || c === '"' || c === "`") local = c;
    }
    // 重新用 cleaning 结果的行做完整扫描（保持跨行字符串状态）
    let str = null;
    for (let j = 0; j < cleaned.length; j++) {
      const c = cleaned[j];
      if (str) { if (c === str) str = null; continue; }
      if (c === "'" || c === '"' || c === "`") str = c;
    }
    inStr = str;
    if (str) suspicious.push({ line: htmlStart + i + 1, text: raw });
  });
});
if (suspicious.length) {
  console.log("\n--- 行尾仍处于字符串内（疑似引号配对错误）---");
  suspicious.slice(0, 30).forEach((s) => console.log(String(s.line).padStart(5) + "  " + s.text.trim().slice(0, 150)));
  console.log("共 " + suspicious.length + " 行");
} else {
  console.log("\n引号配对检查通过");
}
console.log(fail ? "=== " + fail + " block(s) failed ===" : "=== all " + blocks.length + " script block(s) parsed OK ===");
console.log("total html lines: " + html.split("\n").length);
