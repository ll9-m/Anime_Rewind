/* 荣誉墙配图压缩管线
 *
 * 原始 AI 出图是 1024x1536 PNG，单张 2-2.9MB，11 张合计 27MB。
 * 内联进单文件 HTML 会让首屏解析代价极高 —— 27MB base64 约 37MB 字符，
 * 足以让「流畅启动」这个需求当场失败。
 *
 * 处理：
 *   1) 裁掉右下角 AI 水印（保留 92% 高度 + 右侧留 4% 安全边）
 *   2) 缩到 480x720（卡片实际显示约 180x320，2x 足够 retina）
 *   3) 转 JPEG q=0.72 —— 荣誉卡本身是压暗+全息蒙版叠加，不需要高保真
 *   4) 输出 base64 内联到单独 js，运行时按需注入
 */
const sharp = require("sharp");
const fs = require("fs");
const path = require("path");

const SRC = path.join(__dirname, "..", "assets", "honor");
const OUT = path.join(__dirname, "..", "assets", "honor-webp");

/* 荣誉 id -> 源图文件名（生成时的顺序） */
const MAP = [
  ["h10",    "08-36-43"],
  ["h30",    "08-37-07"],
  ["h60",    "08-37-31"],
  ["h100d3", "08-37-53"],
  ["h200",   "08-38-16"],
  ["dec3",   "08-38-39"],
  ["old90",  "08-39-00"],
  ["rew10",  "08-39-23"],
  ["m10",    "08-39-46"],
  ["keng",   "08-40-05"],
  ["mecha",  "08-40-26"],
];

(async () => {
  if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });
  let total = 0;
  const rows = [];
  for (const [id, stamp] of MAP) {
    const hit = fs.readdirSync(SRC).find(f => f.includes(stamp));
    if (!hit) { console.log("MISS", id, stamp); continue; }
    const src = path.join(SRC, hit);
    const meta = await sharp(src).metadata();

    // 裁掉右下角水印：高度取 90%，宽度取 96%，再从左上角偏移
    const cropW = Math.round(meta.width * 0.96);
    const cropH = Math.round(meta.height * 0.90);

    const buf = await sharp(src)
      .extract({ left: 0, top: 0, width: cropW, height: cropH })
      .resize(480, Math.round(480 * cropH / cropW), { fit: "fill" })
      .jpeg({ quality: 72, mozjpeg: true })
      .toBuffer();

    fs.writeFileSync(path.join(OUT, id + ".jpg"), buf);
    total += buf.length;
    rows.push([id, (buf.length / 1024).toFixed(1) + "KB"]);
  }
  console.log("压缩完成：");
  rows.forEach(r => console.log("  " + r[0].padEnd(8) + r[1]));
  console.log("合计 " + (total / 1024).toFixed(0) + "KB（原 27MB）");
  console.log("base64 后约 " + (total * 4 / 3 / 1024).toFixed(0) + "KB");
})();
