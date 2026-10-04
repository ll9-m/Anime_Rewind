// 背景图专项测试：覆盖本次修复的每条路径
// 重点验证「上传了却看不见」的五种成因都已闭合
const fs = require("fs");
const path = require("path");
const { JSDOM, VirtualConsole } = require("jsdom");

const target = process.argv[2] || path.join(__dirname, "..", "anime-rewind.html");
const html = fs.readFileSync(target, "utf8");

const errors = [];
const vc = new VirtualConsole();
vc.on("error", (...a) => errors.push("console.error: " + a.map(String).join(" ")));
vc.on("jsdomError", (e) => {
  const m = String(e && e.message || e);
  if (/Not implemented|Could not parse CSS|getContext/i.test(m)) return;
  errors.push("jsdomError: " + m);
});

const dom = new JSDOM(html, {
  runScripts: "dangerously",
  pretendToBeVisual: true,
  url: "https://local.test/index.html",
  virtualConsole: vc
});
const win = dom.window, doc = win.document;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFUlEQVR42mP8z8BQz0AEYBxVSF+FABJADveWkH6oAAAAAElFTkSuQmCC";

const results = [];
function check(name, fn) {
  try {
    const v = fn();
    results.push([v === true ? "PASS" : "FAIL", name, v === true ? "" : String(v)]);
  } catch (e) {
    results.push(["FAIL", name, String(e && e.message || e)]);
  }
}
const cssVar = (n) => doc.documentElement.style.getPropertyValue(n);
async function acheck(name, fn) {
  try {
    const v = await fn();
    results.push([v === true ? "PASS" : "FAIL", name, v === true ? "" : String(v)]);
  } catch (e) {
    results.push(["FAIL", name, String(e && e.message || e)]);
  }
}
async function upload(key, dataUrl) {
  await win.eval(`(async () => {
    await Repo.setAsset(${JSON.stringify(key)}, ${JSON.stringify(dataUrl)});
    settings.bg_image = ${JSON.stringify(key)};
    saveSettings();
    await refreshBgImage();
    applyAppearance();
  })()`);
}
/* win.eval 不是 async 上下文，里面不能直接 await。
   所有需要 await 的场景一律包成 async IIFE 再取其 promise。
   注意：即使代码体不含 await，包出来的 async 函数返回值仍是 Promise，
   必须 await，否则拿到的是 [object Promise]。 */
function ev(code) {
  return win.eval(`(async () => { ${code} })()`);
}
/* 同步代码用这个，避免无谓的 Promise */
function evSync(code) {
  return win.eval(`(() => { ${code} })()`);
}

(async () => {
  await new Promise((r) => (doc.readyState === "complete" ? r() : win.addEventListener("load", r)));
  await sleep(900);

  // ============ 成因1：深色主题曾硬编码禁用背景图 ============
  check("默认主题是深色（修复前背景图在此主题永不生效的前提）", () =>
    win.eval('settings.theme') === "dark" || win.eval("settings.theme"));

  for (const theme of ["dark", "light", "glass"]) {
    await acheck("「" + theme + "」主题下背景图可渲染", async () => {
      await upload("bg_t_" + theme, PNG);
      await win.eval(`settings.theme=${JSON.stringify(theme)};applyAppearance();`);
      const ok = win.eval("bgRenderable()") === true;
      const on = doc.documentElement.getAttribute("data-bg");
      const img = cssVar("--bg-image");
      return (ok && on === "on" && img.startsWith('url("data:image/')) || `renderable=${ok} data-bg=${on} img=${img.slice(0, 24)}`;
    });
  }

  // ============ 成因2：url('') 静默失效 ============
  await acheck("asset 读不回时 --bg-image 写 none 而非 url('')", async () => {
    await ev('settings.bg_image="bg_nonexistent";saveSettings();await refreshBgImage();applyAppearance();');
    const img = cssVar("--bg-image");
    return img === "none" || `实际写入 ${JSON.stringify(img)}`;
  });
  check("空图时 --bg-on 为 0（整层隐藏，不吃合成）", () => cssVar("--bg-on") === "0" || cssVar("--bg-on"));
  check("空图时 data-bg 为 off", () => doc.documentElement.getAttribute("data-bg") === "off");
  check("空图时 bgLostReason 给出可读原因", () => {
    const r = win.eval("bgLostReason()");
    return (r && r.includes("丢失")) || `实际=${JSON.stringify(r)}`;
  });

  // ============ 成因3：localStorage 容量 ============
  await acheck("压缩函数对 data URL 返回仍是合法 data URL", async () => {
    const out = await win.eval(`compressBgImage(${JSON.stringify(PNG)})`);
    return /^data:image\//.test(out) || String(out).slice(0, 40);
  });
  await acheck("压缩失败时退回原图而非空值", async () => {
    // 非图片 data URL 必须原样返回，不能变成空串
    const out = await win.eval('compressBgImage("data:text/plain;base64,aGVsbG8=")');
    return out === "data:text/plain;base64,aGVsbG8=" || `实际=${String(out).slice(0, 40)}`;
  });
  await acheck("无法解码的 data URL 不抛异常", async () => {
    const out = await win.eval('compressBgImage("data:image/png;base64,!!!not-valid-base64!!!")');
    return typeof out === "string" || typeof out;
  });

  // ============ 成因4：导入后 key 迁移 ============
  await acheck("导入携带背景图时 key 与 asset 对齐", async () => {
    win.eval('payloadBg = ' + JSON.stringify(PNG));
    const stored = await ev(`
      const key = "bg_" + Date.now().toString(36);
      await Repo.setAsset(key, payloadBg);
      if(settings.bg_image && settings.bg_image !== key){ try{ await Repo.delAsset(settings.bg_image); }catch(e){} }
      settings.bg_image = key; saveSettings();
      await refreshBgImage(); applyAppearance();
      return { key, asset: await Repo.getAsset(settings.bg_image), url: bgImageUrl.length };
    `);
    return (stored.url > 0 && stored.asset && stored.key === win.eval("settings.bg_image")) ||
      JSON.stringify(stored);
  });
  await acheck("导入的图可正常渲染", async () => {
    const ok = win.eval("bgRenderable()") === true;
    return ok || "renderable=false";
  });
  win.eval("payloadBg = null");

  // ============ 成因5：遮罩取色随主题 ============
  await upload("bg_overlay", PNG);
  await win.eval('settings.theme="light";applyAppearance();');
  check("浅色主题遮罩用白色提亮（不再压成脏灰）", () => {
    const rgb = cssVar("--bg-overlay-rgb");
    return rgb === "255,255,255" || `实际=${rgb}`;
  });
  await win.eval('settings.theme="dark";applyAppearance();');
  check("深色主题遮罩用深色压暗", () => {
    const rgb = cssVar("--bg-overlay-rgb");
    return rgb === "6,10,16" || `实际=${rgb}`;
  });
  check("玻璃主题遮罩取深色", () => {
    win.eval('settings.theme="glass";applyAppearance();');
    return cssVar("--bg-overlay-rgb") === "6,10,16" || cssVar("--bg-overlay-rgb");
  });

  // ============ 边界可见性 ============
  check("有图时 data-bg=on 触发描边钩子", () => {
    win.eval('settings.theme="light";applyAppearance();');
    return doc.documentElement.getAttribute("data-bg") === "on" || doc.documentElement.getAttribute("data-bg");
  });
  const cssText = html;
  check("CSS 定义了 [data-bg=on] 的图片边框", () => /\[data-bg="on"\]\s*\.bg-layer\{[^}]*box-shadow/.test(cssText));

  // ============ 设置页 UI ============
  await acheck("设置页背景图行不再因深色主题禁用上传", async () => {
    await ev('settings.theme="dark";settings.bg_image="bg_overlay";saveSettings();await refreshBgImage();applyAppearance();go("settings");');
    await sleep(300);
    const btn = doc.querySelector('[data-act="bg-upload"]');
    return (btn && !btn.disabled) || (btn ? "按钮仍 disabled" : "找不到上传按钮");
  });
  check("设置页有背景图缩略图", () => {
    const t = doc.querySelector("#bg-thumb");
    return !!(t && t.querySelector("img")) || "缩略图缺失或无 img";
  });
  check("设置页有背景图状态行", () => {
    const s = doc.querySelector("#bg-status");
    return (s && s.textContent.trim().length > 4) || "状态行缺失";
  });
  check("状态行在图生效时标为 is-ok", () => {
    const s = doc.querySelector("#bg-status");
    return (s && s.className.includes("is-ok")) || "生效态未标记 is-ok";
  });
  check("模糊滑块在有图时可用", () => {
    const r = doc.querySelector('input[data-set="bg_blur"]');
    return (r && !r.disabled) || "模糊滑块被禁用";
  });
  await acheck("移除后状态行回到未上传态", async () => {
    await ev('settings.bg_image="";bgImageUrl="";saveSettings();applyAppearance();rerender();');
    await sleep(200);
    const s = doc.querySelector("#bg-status");
    return (s && s.textContent.includes("尚未上传")) || (s ? s.textContent.slice(0, 40) : "状态行缺失");
  });
  check("无图时模糊滑块禁用（避免调一个无效参数）", () => {
    const r = doc.querySelector('input[data-set="bg_blur"]');
    return (r && r.disabled) || "无图时滑块仍可用";
  });
  await acheck("资产丢失时状态行说明原因", async () => {
    await ev('settings.bg_image="bg_gone";saveSettings();await refreshBgImage();applyAppearance();rerender();');
    await sleep(200);
    const s = doc.querySelector("#bg-status");
    return (s && s.textContent.includes("丢失")) || (s ? s.textContent.slice(0, 40) : "状态行缺失");
  });
  check("图标表含 image 键（缩略图占位用）", () => win.eval('!!ICONS["image"]') === true || "ICONS.image 缺失");

  // ============ 可读性诊断 ============
  await acheck("深色主题下建议遮罩足以应对纯白背景图", async () => {
    await upload("bg_read", PNG);
    const r = await ev(`
      settings.theme = "dark"; applyAppearance();
      const req = bgRequiredOverlay();
      settings.bg_overlay = req; applyAppearance();
      // 纯白背景 + 当前遮罩下的裸露区对比度
      const tint = [6,10,16];
      const mixed = tint.map((c,i) => Math.round(c*req + 255*(1-req)));
      const lin = v => { v/=255; return v<=0.04045 ? v/12.92 : Math.pow((v+0.055)/1.055,2.4); };
      const L = a => 0.2126*lin(a[0]) + 0.7152*lin(a[1]) + 0.0722*lin(a[2]);
      const l1 = L([232,238,245]), l2 = L(mixed);
      return { req, ratio: (Math.max(l1,l2)+0.05)/(Math.min(l1,l2)+0.05) };
    `);
    return (r.req > 0 && r.ratio >= 4.5) || `req=${r.req} ratio=${r.ratio.toFixed(2)}`;
  });
  await acheck("浅色主题下建议遮罩足以应对纯黑背景图", async () => {
    const r = await ev(`
      settings.theme = "light"; applyAppearance();
      const req = bgRequiredOverlay();
      const tint = [255,255,255];
      const mixed = tint.map((c,i) => Math.round(c*req + 0*(1-req)));
      const lin = v => { v/=255; return v<=0.04045 ? v/12.92 : Math.pow((v+0.055)/1.055,2.4); };
      const L = a => 0.2126*lin(a[0]) + 0.7152*lin(a[1]) + 0.0722*lin(a[2]);
      const l1 = L([17,24,32]), l2 = L(mixed);
      return { req, ratio: (Math.max(l1,l2)+0.05)/(Math.min(l1,l2)+0.05) };
    `);
    return (r.req > 0 && r.ratio >= 4.5) || `req=${r.req} ratio=${r.ratio.toFixed(2)}`;
  });
  check("建议遮罩不超过滑块上限 0.92", () => {
    evSync('settings.theme="dark";applyAppearance();');
    const req = win.eval("bgRequiredOverlay()");
    return req <= 0.92 || `建议值 ${req} 超出滑块范围`;
  });
  check("遮罩达标时提示语为「已达标」", () => {
    evSync('settings.theme="dark";settings.bg_overlay=0.92;applyAppearance();');
    const txt = win.eval("bgReadabilityText()");
    return (txt.includes("已达标")) || txt;
  });
  check("遮罩不足时提示语说明已自动兜底并给出实际值", () => {
    evSync('settings.theme="dark";settings.bg_overlay=0.1;applyAppearance();');
    const txt = win.eval("bgReadabilityText()");
    return (txt.includes("已自动加强遮罩") && /0\.\d+/.test(txt)) || txt;
  });
  acheck("实际遮罩取「设定值」与「可读性下限」的较大者", () => {
    evSync('settings.theme="dark";settings.bg_overlay=0.1;applyAppearance();');
    const eff = win.eval("bgEffectiveOverlay()");
    const css = doc.documentElement.style.getPropertyValue("--bg-overlay");
    const ok = Number(eff) > 0.1 && Math.abs(Number(css) - Number(eff)) < 1e-6;
    return ok || `effective=${eff} css=${css}`;
  });
  acheck("兜底后裸露区（纯白背景）对比度达标", () => {
    evSync('settings.theme="dark";settings.bg_overlay=0.1;applyAppearance();');
    const o = win.eval("bgEffectiveOverlay()");
    const tint = [6, 10, 16];
    const mixed = tint.map((c, i) => Math.round(c * o + 255 * (1 - o)));
    const lin = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    const L = (a) => 0.2126 * lin(a[0]) + 0.7152 * lin(a[1]) + 0.0722 * lin(a[2]);
    const l1 = L([232, 238, 245]), l2 = L(mixed);
    const r = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
    return r >= 4.5 || `遮罩 ${o} 时对比度仅 ${r.toFixed(2)}`;
  });
  acheck("用户设定高于下限时不被覆盖（不强制压暗）", () => {
    evSync('settings.theme="dark";settings.bg_overlay=0.9;applyAppearance();');
    const eff = win.eval("bgEffectiveOverlay()");
    const css = doc.documentElement.style.getPropertyValue("--bg-overlay");
    return (Math.abs(Number(eff) - 0.9) < 1e-6 && Math.abs(Number(css) - 0.9) < 1e-6) ||
      `effective=${eff} css=${css}`;
  });
  acheck("遮罩滑块上限已提到 0.92", async () => {
    evSync('settings.theme="light";settings.bg_overlay=0.42;applyAppearance();rerender();');
    await sleep(200);
    const r = doc.querySelector('input[data-set="bg_overlay"]');
    return (r && r.getAttribute("max") === "0.92") || (r ? "max=" + r.getAttribute("max") : "滑块缺失");
  });
  check("状态行含可读性提示节点", () => {
    const n = doc.querySelector(".bg-readability");
    return !!n || "缺少 .bg-readability";
  });
  acheck("拖动遮罩滑块会即时刷新可读性提示（不重渲染）", async () => {
    evSync('settings.theme="dark";settings.bg_overlay=0.2;applyAppearance();rerender();');
    await sleep(250);
    const r = doc.querySelector('input[data-set="bg_overlay"]');
    const before = doc.querySelector(".bg-readability");
    if(!r || !before) return "滑块或提示节点缺失";
    const sameNode = r;
    r.value = "0.9";
    r.dispatchEvent(new win.Event("input", { bubbles: true }));
    const after = doc.querySelector(".bg-readability");
    return (after && sameNode.isConnected) || "拖动后滑块被重渲染替换，手感会断";
  });

  // ============ 回归：主题切换不破坏背景 ============
  await acheck("反复切换主题背景图始终保持生效", async () => {
    await upload("bg_regress", PNG);
    for (const t of ["light", "dark", "glass", "light", "dark"]) {
      await win.eval(`settings.theme=${JSON.stringify(t)};applyAppearance();`);
      if (win.eval("bgRenderable()") !== true) return "切到 " + t + " 后失效";
    }
    return true;
  });
  check("blur=0 时遮罩仍生效（不因零模糊丢遮罩）", () => {
    win.eval('settings.bg_blur=0;applyAppearance();');
    const ok = cssVar("--bg-blur") === "0" && Number(cssVar("--bg-overlay")) > 0;
    win.eval("settings.bg_blur = 8; applyAppearance();");
    return ok || `blur=${cssVar("--bg-blur")} overlay=${cssVar("--bg-overlay")}`;
  });

  // ============ 输出 ============
  const pass = results.filter((r) => r[0] === "PASS").length;
  results.forEach(([st, n, m]) => { if (st === "FAIL") console.log("FAIL " + n + "  → " + m); });
  console.log("\n通过 " + pass + " / " + results.length);
  if (errors.length) {
    console.log("\n控制台错误:");
    errors.forEach((e) => console.log("  " + e));
  } else {
    console.log("\n无控制台 error / 未捕获异常");
  }
  process.exit(pass === results.length && !errors.length ? 0 : 1);
})();