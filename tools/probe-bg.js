// 背景图链路探针：模拟上传 → 检查 bgImageUrl / --bg-image / 实际渲染
const fs = require("fs");
const path = require("path");
const { JSDOM, VirtualConsole } = require("jsdom");

const target = process.argv[2] || path.join(__dirname, "..", "anime-rewind.html");
const html = fs.readFileSync(target, "utf8");

const vc = new VirtualConsole();
vc.on("error", (...a) => console.log("[console.error]", a.map(String).join(" ")));
const dom = new JSDOM(html, {
  runScripts: "dangerously",
  pretendToBeVisual: true,
  url: "https://local.test/index.html",
  virtualConsole: vc
});
const win = dom.window, doc = win.document;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 一张 2x2 红色 PNG
const PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFUlEQVR42mP8z8BQz0AEYBxVSF+FABJADveWkH6oAAAAAElFTkSuQmCC";

function report(tag) {
  const root = doc.documentElement;
  const layer = doc.querySelector("#bg-layer");
  const overlay = doc.querySelector("#bg-overlay");
  console.log("=== " + tag + " ===");
  console.log("  theme            :", root.getAttribute("data-theme"));
  console.log("  settings.bg_image:", JSON.stringify(win.eval("settings.bg_image")));
  console.log("  bgImageUrl len   :", String(win.eval("bgImageUrl")).length);
  console.log("  --bg-image       :", root.style.getPropertyValue("--bg-image").slice(0, 50));
  console.log("  --bg-blur        :", root.style.getPropertyValue("--bg-blur"));
  console.log("  --bg-overlay     :", root.style.getPropertyValue("--bg-overlay"));
  console.log("  layer display    :", layer && layer.style.display);
  const cs = win.getComputedStyle(layer);
  console.log("  computed bgImage :", cs.backgroundImage.slice(0, 50));
  console.log("  computed filter  :", cs.filter, "| transform:", cs.transform);
  console.log("  overlay computed :", win.getComputedStyle(overlay).backgroundColor);
  console.log("  body background  :", win.getComputedStyle(doc.body).backgroundColor);
  console.log("  #view background :", win.getComputedStyle(doc.querySelector("#view")).backgroundColor);
  console.log("  #main background :", win.getComputedStyle(doc.querySelector("#main")).backgroundColor);
}

(async () => {
  await new Promise((r) => (doc.readyState === "complete" ? r() : win.addEventListener("load", r)));
  await sleep(800);

  console.log("Repo.mode =", win.eval("Repo.mode"));
  report("初始（默认深色）");

  // 场景 A：浅色主题 + 已上传
  await win.eval(`(async () => {
    settings.theme = "light";
    await Repo.setAsset("bg_test", ${JSON.stringify(PNG)});
    settings.bg_image = "bg_test";
    saveSettings();
    await refreshBgImage();
    applyAppearance();
  })()`);
  report("A 浅色主题 + 已上传");

  // 场景 B：bg_image 指向不存在的 asset（导入路径会产生的状态）
  await win.eval(`(async () => {
    settings.bg_image = "bg_missing_key";
    saveSettings();
    await refreshBgImage();
    applyAppearance();
  })()`);
  report("B bg_image 指向不存在的 asset");

  // 场景 C：切回深色
  win.eval('settings.theme="dark";applyAppearance()');
  report("C 切回深色主题");

  // 场景 D：存储容量
  console.log("=== D localStorage 容量 ===");
  for (const mb of [1, 2, 3, 4, 5]) {
    const s = "x".repeat(mb * 1024 * 1024);
    try { win.localStorage.setItem("probe", s); win.localStorage.removeItem("probe"); console.log("  " + mb + "MB: OK"); }
    catch (e) { console.log("  " + mb + "MB: 失败 " + e.name); break; }
  }
  process.exit(0);
})();