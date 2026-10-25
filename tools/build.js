/* 构建器：按 src/manifest.json 的顺序把模块拼成单文件产物。
 *
 * 约束（这是本仓库的立身之本，别破坏）：
 *   · 产物永远是仓库根的 anime-rewind.html —— 单文件、零构建产物、双击可用；
 *   · src/ 下每个模块文件的内容就是产物原字节的一个切片，
 *     因此「构建」是纯拼接，没有任何转换/压缩 —— 想改什么直接改 src 模块；
 *   · node tools/build.js --check 必须与磁盘上的产物字节级一致，
 *     否则说明有人改了产物没改 src（或反之），CI/提交前都会拦下。
 *
 * 用法:
 *   node tools/build.js           重新生成 anime-rewind.html
 *   node tools/build.js --check   只校验不一致即退出码 1
 */
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");
const ARTIFACT = path.join(ROOT, "anime-rewind.html");
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "src", "manifest.json"), "utf8"));

const missing = manifest.filter(e => !fs.existsSync(path.join(ROOT, e.file)));
if(missing.length){
  console.error("manifest 引用了不存在的模块文件：");
  missing.forEach(e => console.error("  " + e.file));
  process.exit(2);
}

let out = "";
for(const e of manifest) out += fs.readFileSync(path.join(ROOT, e.file), "utf8");

const checkOnly = process.argv.includes("--check");
const current = fs.existsSync(ARTIFACT) ? fs.readFileSync(ARTIFACT, "utf8") : "";
if(checkOnly){
  if(out === current){
    console.log("build --check：src/ 与产物字节级一致 ✓（" + manifest.length + " 个模块）");
  }else{
    let diffAt = -1;
    for(let i = 0; i < Math.min(out.length, current.length); i++){
      if(out[i] !== current[i]){ diffAt = i; break; }
    }
    console.error("build --check：不一致 ✗  src 拼接 " + out.length + " 字节 vs 产物 " + current.length + " 字节" +
      (diffAt >= 0 ? "，首个差异 @" + diffAt : ""));
    console.error("修复方式：改了 src 就执行 node tools/build.js；改了产物就把改动搬回 src 对应模块。");
    process.exit(1);
  }
}else{
  fs.writeFileSync(ARTIFACT, out);
  console.log("已构建 anime-rewind.html：" + out.length + " 字节，" + manifest.length + " 个模块");
}
