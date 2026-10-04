/* 把压缩好的荣誉配图转成可直接内联的 JS 常量文件。
 * 产物 assets/honor-art.js 会被 build 步骤拼进 HTML。
 * 独立成文件的原因：HTML 里塞 645KB base64 会让编辑该文件变得极其痛苦。
 */
const fs = require("fs");
const path = require("path");

const DIR = path.join(__dirname, "..", "assets", "honor-webp");
const IDS = ["h10","h30","h60","h100d3","h200","dec3","old90","rew10","m10","keng","mecha"];

const out = {};
let bytes = 0;
for (const id of IDS) {
  const p = path.join(DIR, id + ".jpg");
  if (!fs.existsSync(p)) { console.error("缺图:", id); process.exit(1); }
  const b = fs.readFileSync(p);
  bytes += b.length;
  out[id] = "data:image/jpeg;base64," + b.toString("base64");
}

const js =
  "/* 荣誉墙默认配图（AI 生成 · 已压缩至 " + Math.round(bytes / 1024) + "KB 总计）\n" +
  "   由 tools/build-honor-art.js 生成，请勿手改。 */\n" +
  "const HONOR_ART = " + JSON.stringify(out, null, 1) + ";\n";

const dest = path.join(__dirname, "..", "assets", "honor-art.js");
fs.writeFileSync(dest, js, "utf8");
console.log("写入 " + dest + "  " + (js.length / 1024).toFixed(0) + "KB");
