/* UI 套系专项测试（像素风 / 科技感）
 *
 * 三个必测点，都是「看起来做了但其实没生效」的高发区：
 * 1) data-skin 属性真的写到了 <html> 上（否则整套 CSS 都不生效）
 * 2) 科技风开关点得动 —— 自定义套系最容易出的死法是替换了 DOM 却丢了事件
 * 3) 像素风真的 0 圆角 + 硬投影，而不是"稍微方一点"
 */
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const HTML = path.join(__dirname, "..", "anime-rewind.html");
const html = fs.readFileSync(HTML, "utf8");

let pass = 0, fail = 0;
const errs = [];
function check(name, cond, detail){
  if(cond){ pass++; console.log("PASS " + name); }
  else { fail++; errs.push(name + (detail ? " — " + detail : "")); console.log("FAIL " + name + (detail ? "  → " + detail : "")); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const dom = new JSDOM(html, { runScripts:"dangerously", url:"https://x.test/", pretendToBeVisual:true });
  const win = dom.window, doc = win.document;
  await sleep(900);
  const ev = code => win.eval(`(async () => { ${code} })()`);
  const evSync = code => win.eval(code);

  // ---------- 1. 常量与默认值 ----------
  check("UI_SKINS 含三套", JSON.stringify(await ev("return UI_SKINS;")) === '["archive","pixel","holo"]',
    JSON.stringify(await ev("return UI_SKINS;")));
  check("默认套系是 archive", (await ev("return DEFAULT_SETTINGS.ui_skin;")) === "archive");
  check("html 标签带 data-skin", /<html[^>]*data-skin="archive"/.test(html));
  check("CSS 定义了三种 data-skin",
    /\[data-skin="archive"\]/.test(html) && /\[data-skin="pixel"\]/.test(html) && /\[data-skin="holo"\]/.test(html));

  // ---------- 2. 切换套系真的改属性 ----------
  for (const skin of ["pixel", "holo", "archive"]) {
    await ev(`settings.ui_skin = "${skin}"; applyAppearance();`);
    const got = doc.documentElement.getAttribute("data-skin");
    check("切换到 " + skin + " 后 html[data-skin] 正确", got === skin, String(got));
  }
  // 非法值回落到 archive，不能是 undefined
  await ev('settings.ui_skin = "不存在的套系"; applyAppearance();');
  check("非法套系回落为 archive", doc.documentElement.getAttribute("data-skin") === "archive",
    String(doc.documentElement.getAttribute("data-skin")));

  // ---------- 3. 像素风 CSS 硬约束 ----------
  check("像素风圆角为 0", /\[data-skin="pixel"\]\{[^}]*--r-sm:0px;[^}]*--r-lg:0px/.test(html));
  check("像素风用硬投影（非模糊）", /\[data-skin="pixel"\]\{[^}]*--shadow:4px 4px 0 var\(--px-ink\)/.test(html));
  check("像素风硬边框 3px", /--px-border:3px/.test(html));
  check("像素风定义了有限调色板（PICO-8）", /--px-red:#ff004d/.test(html) && /--px-green:#00e436/.test(html));
  check("像素风启用 image-rendering:pixelated", /\[data-skin="pixel"\]\{[^}]*image-rendering:pixelated/.test(html));
  check("像素风背景是抖动网点（非平滑渐变）",
    /\[data-skin="pixel"\] body::before\{[^}]*repeating-conic-gradient/.test(html));
  check("像素风关闭 transition（逐帧 snap）", /\[data-skin="pixel"\] \.btn,\n\[data-skin="pixel"\] \.panel,\n\[data-skin="pixel"\] \.tk\{ transition:none;/.test(html.replace(/\r\n/g,"\n")));
  check("像素风标题有硬阴影", /\[data-skin="pixel"\] h1,[\s\S]{0,200}?text-shadow:3px 3px 0 var\(--px-ink\)/.test(html));
  check("像素风进度条是像素血条", /repeating-linear-gradient\(90deg, var\(--px-green\) 0 6px/.test(html));
  check("像素风尊重 prefers-reduced-motion",
    /\[data-skin="pixel"\] \*,[\s\S]{0,120}?animation:none !important/.test(html));
  check("像素风加载了像素字体", /Press\+Start\+2P/.test(html) && /VT323/.test(html));

  // ---------- 4. 科技风 CSS 硬约束 ----------
  check("科技风故障动画用 steps()（顿挫而非平滑）", /animation:holo-glitch \.5s steps\(2,end\)/.test(html));
  check("科技风按钮有 clip-path 故障层", /@keyframes holo-glitch\{[\s\S]{0,200}?clip-path:inset\(/.test(html));
  check("科技风描边用 conic-gradient", /\.holo-field \.hf-edge\{[\s\S]{0,200}?conic-gradient/.test(html));
  check("科技风描边动画仅在 focus 时运行", /\.holo-field:focus-within \.hf-edge\{ animation:holo-edge-spin/.test(html));
  check("科技风能量环仅在 hover/focus 时旋转", /\.holo-switch:hover \.hs-ring,[\s\S]{0,80}?animation:holo-spin/.test(html));
  check("科技风原示例的常驻动画已被改掉（不引入 4s 无限旋转）",
    !/animation:\s*rotate\s+4s/.test(html), "仍存在常驻 rotate 4s 动画");
  check("科技风尊重 prefers-reduced-motion", /@media \(prefers-reduced-motion:reduce\)\{\s*\[data-skin="holo"\] \.btn:hover::after\{ animation:none; \}/.test(html));
  check("科技风不隐藏原 input（保证可点）", /\.holo-switch > input\{[^}]*opacity:0[^}]*cursor:pointer/.test(html));
  check("开关带无障碍文本", /\.sr-only\{/.test(html));

  // ---------- 5. 故障按钮需要 data-label ----------
  check("syncSkinLabels 已定义", typeof evSync("syncSkinLabels") === "function");
  await ev('settings.ui_skin = "holo"; go("library");');
  await sleep(400);
  const labels = await ev('return Array.from(document.querySelectorAll("#view .btn")).map(b=>b.dataset.label).filter(Boolean);');
  check("按钮已注入 data-label（故障层需要）", labels.length > 0, "注入 " + labels.length + " 个");
  // data-label 不应含 SVG 的文本节点残留
  check("data-label 是纯文字（不含图标）",
    labels.every(l => typeof l === "string" && l.length > 0 && l.length < 40),
    JSON.stringify(labels.slice(0, 5)));

  // ---------- 6. 科技风开关：点得动（最关键） ----------
  await ev('settings.module_quotes = true; go("settings");');
  await sleep(400);
  // 切到「功能开关」分区，那里有多个 checkbox
  const modTab = doc.querySelector('[data-sec="modules"]');
  check("设置页有「功能开关」分区", !!modTab);
  if (modTab) modTab.click();
  await sleep(400);

  await ev('settings.ui_skin = "holo"; applyAppearance(); rerender();');
  await sleep(400);
  const switches = doc.querySelectorAll(".holo-switch");
  check("科技风下 checkbox 被升级为全息开关", switches.length > 0, "实际 " + switches.length);
  if (switches.length) {
    const sw = switches[0];
    const input = sw.querySelector("input[type=checkbox]");
    check("开关内保留真实 input（不是纯装饰）", !!input);
    check("开关 input 保留 data-set", input && !!input.dataset.set, input ? input.dataset.set : "");
    check("开关有轨道 label", !!sw.querySelector(".hs-track"));
    check("开关有滑块", !!sw.querySelector(".hs-thumb"));
    check("开关有能量环", !!sw.querySelector(".hs-ring"));
    check("开关轨道 label 指向 input（for=id 一致）",
      input && input.id && sw.querySelector(".hs-track").getAttribute("for") === input.id,
      input ? (input.id + " vs " + sw.querySelector(".hs-track").getAttribute("for")) : "");

    // 真实点击：这是最容易被自定义套系改死的地方
    const key = input.dataset.set;
    const before = await ev(`return settings[${JSON.stringify(key)}];`);
    input.click();                 // 真实点击
    await sleep(400);
    const after = await ev(`return settings[${JSON.stringify(key)}];`);
    check("点击全息开关能真实改到 settings." + key, before !== after, before + " → " + after);
    // 切回原值，避免影响后续
    input.click();
    await sleep(350);
  }

  // ---------- 7. 归档套系下不残留全息装饰 ----------
  await ev('settings.ui_skin = "archive"; applyAppearance(); rerender();');
  await sleep(400);
  check("档案馆套系下不再有 .holo-switch", doc.querySelectorAll(".holo-switch").length === 0,
    "残留 " + doc.querySelectorAll(".holo-switch").length);
  check("档案馆套系下 checkbox 恢复正常", doc.querySelectorAll(".checkline input[type=checkbox]").length > 0);
  // 且仍可点击
  const plain = doc.querySelector(".checkline input[type=checkbox]");
  if (plain) {
    const k = plain.dataset.set;
    const b = await ev(`return settings[${JSON.stringify(k)}];`);
    plain.click();
    await sleep(350);
    const a = await ev(`return settings[${JSON.stringify(k)}];`);
    check("档案馆套系下开关仍可用", b !== a, b + " → " + a);
    plain.click();
    await sleep(300);
  }

  // ---------- 8. 像素套系下结构不塌 ----------
  await ev('settings.ui_skin = "pixel"; applyAppearance(); go("library");');
  await sleep(400);
  check("像素套系下片库正常渲染", doc.querySelectorAll("#view .card, #view .state-box, #view table, #view .filterbar").length > 0);
  check("像素套系下侧栏正常渲染", !!doc.querySelector("#sidebar"));
  check("像素套系下按钮仍有文字（不是被 ::after 吞掉）",
    Array.from(doc.querySelectorAll("#view .btn")).some(b => b.textContent.trim().length > 0));

  // ---------- 9. 三套 × 三主题不报错 ----------
  let crashed = 0;
  for (const skin of ["archive", "pixel", "holo"]) {
    for (const theme of ["dark", "light", "glass"]) {
      try {
        await ev(`settings.ui_skin = "${skin}"; settings.theme = "${theme}"; applyAppearance(); go("home");`);
        await sleep(120);
      } catch (e) { crashed++; }
    }
  }
  check("3 套系 × 3 主题 = 9 种组合均不抛异常", crashed === 0, crashed + " 种组合崩溃");

  // ---------- 10. 套系随设置持久化 ----------
  await ev('settings.ui_skin = "pixel"; saveSettings();');
  await ev('loadSettings(); applyAppearance();');
  await sleep(200);
  check("套系设置可持久化并恢复", doc.documentElement.getAttribute("data-skin") === "pixel",
    String(doc.documentElement.getAttribute("data-skin")));

  console.log("\n通过 " + pass + " / " + (pass + fail));
  if (errs.length) { console.log("\n失败项："); errs.forEach(e => console.log("  · " + e)); }
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error("测试脚本异常:", e); process.exit(2); });
