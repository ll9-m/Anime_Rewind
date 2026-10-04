/* 放映厅外部播放器专项测试
 *
 * 重点不在「iframe 能不能显示」（jsdom 里永远显示不出来），
 * 而在 URL 解析的正确性与安全性 —— 这是唯一能真正测的部分，
 * 也是出错代价最高的部分：解析错 → 用户粘什么都是白屏；
 * 安全性失守 → javascript: 伪协议能进 iframe。
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

(async () => {
  const dom = new JSDOM(html, { runScripts:"dangerously", url:"https://x.test/", pretendToBeVisual:true });
  const win = dom.window, doc = win.document;
  await new Promise(r => setTimeout(r, 900));
  const ev = code => win.eval(`(async () => { ${code} })()`);
  const evSync = code => win.eval(code);

  // ---------- 1. YouTube 各形态 ----------
  const cases = [
    ["https://www.youtube.com/watch?v=dQw4w9WgXcQ",            "dQw4w9WgXcQ", "youtube-nocookie.com/embed/dQw4w9WgXcQ"],
    ["https://youtu.be/dQw4w9WgXcQ",                            "dQw4w9WgXcQ", "youtube-nocookie.com/embed/dQw4w9WgXcQ"],
    ["https://www.youtube.com/embed/dQw4w9WgXcQ",               "dQw4w9WgXcQ", "youtube-nocookie.com/embed/dQw4w9WgXcQ"],
    ["https://www.youtube.com/shorts/dQw4w9WgXcQ",              "dQw4w9WgXcQ", "youtube-nocookie.com/embed/dQw4w9WgXcQ"],
    ["https://m.youtube.com/watch?v=dQw4w9WgXcQ&t=30s",        "dQw4w9WgXcQ", "youtube-nocookie.com/embed/dQw4w9WgXcQ"]
  ];
  for (const [input, vid, mustContain] of cases) {
    const r = evSync(`resolveEmbed(${JSON.stringify(input)})`);
    check("YouTube 解析: " + input.slice(0, 52),
      r.ok && r.src.includes(mustContain), JSON.stringify(r.src || r.reason));
  }
  // 播放列表要保留
  const pl = evSync('resolveEmbed("https://www.youtube.com/watch?v=abc12345678&list=PL1234567890")');
  check("YouTube 播放列表参数被保留", pl.ok && pl.src.includes("list=PL1234567890"), pl.src);

  // ---------- 2. Bilibili 各形态 ----------
  const bili = [
    ["https://www.bilibili.com/video/BV1GJ411x7h7", "BV1GJ411x7h7", null],
    ["https://www.bilibili.com/video/BV1GJ411x7h7/?p=3", "BV1GJ411x7h7", "p=3"],
    ["https://www.bilibili.com/video/av170001", "170001", null],
    ["https://player.bilibili.com/player.html?bvid=BV1GJ411x7h7", "BV1GJ411x7h7", null]
  ];
  for (const [input, id, extra] of bili) {
    const r = evSync(`resolveEmbed(${JSON.stringify(input)})`);
    check("Bilibili 解析: " + input.slice(0, 50),
      r.ok && r.src.startsWith("https://player.bilibili.com/player.html") && r.src.includes(id)
      && (!extra || r.src.includes(extra)),
      r.src || r.reason);
  }

  // ---------- 3. 通用网页原样透传 ----------
  const g = evSync('resolveEmbed("https://example.com/watch/abc")');
  check("未知站点原样透传", g.ok && g.src === "https://example.com/watch/abc" && g.changed === false, JSON.stringify(g));

  // ---------- 4. 缺协议头自动补 ----------
  const np = evSync('resolveEmbed("www.bilibili.com/video/BV1GJ411x7h7")');
  check("缺 https:// 自动补全并正确解析", np.ok && np.src.includes("BV1GJ411x7h7"), np.src || np.reason);

  // ---------- 5. 安全：伪协议必须被拒 ----------
  for (const evil of ["javascript:alert(1)", "JavaScript:alert(1)", "  javascript:alert(1)  ", "data:text/html,<script>alert(1)</script>"]) {
    const r = evSync(`normalizeStreamURL(${JSON.stringify(evil)})`);
    check("伪协议被拒: " + JSON.stringify(evil).slice(0, 44), r === "", "返回 " + JSON.stringify(r));
  }
  const evilEmbed = evSync('resolveEmbed("javascript:alert(1)")');
  check("resolveEmbed 拒绝 javascript:", evilEmbed.ok === false, JSON.stringify(evilEmbed));

  // ---------- 6. 空值与垃圾输入不抛异常 ----------
  for (const junk of ["", "   ", "not a url", "://", "https://", "http://%%%"]) {
    const r = evSync(`resolveEmbed(${JSON.stringify(junk)})`);
    check("垃圾输入安全失败: " + JSON.stringify(junk).slice(0, 30), r.ok === false, JSON.stringify(r));
  }

  // ---------- 7. changed 标记正确（告知用户链接被转换过） ----------
  const yc = evSync('resolveEmbed("https://youtu.be/dQw4w9WgXcQ")');
  check("YouTube 链接标记为已转换 changed=true", yc.ok && yc.changed === true, JSON.stringify({ ok: yc.ok, changed: yc.changed }));
  const bc = evSync('resolveEmbed("https://www.bilibili.com/video/BV1GJ411x7h7")');
  check("Bilibili 分享链接标记为已转换", bc.ok && bc.changed === true, JSON.stringify({ ok: bc.ok, changed: bc.changed }));
  const vc = evSync('resolveEmbed("https://vimeo.com/123456789")');
  check("Vimeo 转为 player.vimeo.com", vc.ok && vc.src === "https://player.vimeo.com/video/123456789" && vc.changed === true,
    JSON.stringify({ ok: vc.ok, src: vc.src, changed: vc.changed }));
  // 已经就是播放器地址时不应再改
  const vc2 = evSync('resolveEmbed("https://player.vimeo.com/video/123456789")');
  check("Vimeo 播放器地址原样透传", vc2.ok && vc2.changed === false, JSON.stringify({ ok: vc2.ok, src: vc2.src, changed: vc2.changed }));

  // ---------- 8. 页面 UI 真的渲染出来了 ----------
  await ev('settings.module_theater = true; go("theater");');
  await new Promise(r => setTimeout(r, 300));
  check("放映厅有片源输入框", !!doc.querySelector("#st-url"));
  check("放映厅有播放按钮", !!doc.querySelector('[data-st="play"]'));
  check("放映厅有新标签打开按钮", !!doc.querySelector('[data-st="open"]'));
  check("放映厅有状态诊断条", !!doc.querySelector("#st-status"));
  check("播放器容器默认隐藏", doc.querySelector("#st-mount").hidden === true);
  check("无片源时「新标签打开」禁用", doc.querySelector('[data-st="open"]').disabled === true);
  check("状态条说明了嵌入限制（不是空白）",
    /禁止被第三方网站嵌入/.test(doc.querySelector("#st-status").textContent),
    doc.querySelector("#st-status").textContent.slice(0, 60));

  // ---------- 9. 真实点击：输入非法网址 → 报错，不崩 ----------
  const input = doc.querySelector("#st-url");
  input.value = "javascript:alert(1)";
  doc.querySelector('[data-st="play"]').click();
  await new Promise(r => setTimeout(r, 200));
  check("输入 javascript: 后点播放 → 报错且不创建 iframe",
    /无效|无法识别/.test(doc.querySelector("#st-status").textContent) && !doc.querySelector(".stream-frame"),
    doc.querySelector("#st-status").textContent.slice(0, 60));

  // ---------- 10. 真实点击：输入合法 B 站网址 → 生成 iframe 并持久化 ----------
  input.value = "https://www.bilibili.com/video/BV1GJ411x7h7";
  doc.querySelector('[data-st="play"]').click();
  await new Promise(r => setTimeout(r, 300));
  const frame = doc.querySelector(".stream-frame");
  check("点击播放后创建了 iframe", !!frame);
  check("iframe 指向 B 站播放器", frame && frame.src.includes("player.bilibili.com"), frame ? frame.src : "无");
  check("播放器容器已显示", doc.querySelector("#st-mount").hidden === false);
  check("片源已持久化到 settings", evSync("settings.stream_url") === "https://www.bilibili.com/video/BV1GJ411x7h7",
    String(evSync("settings.stream_url")));
  check("iframe 带 allowfullscreen", frame && frame.hasAttribute("allowfullscreen"));
  check("iframe 带 sandbox（隔离第三方脚本）", frame && frame.hasAttribute("sandbox"), frame ? frame.getAttribute("sandbox") : "");
  check("iframe referrerpolicy 为 no-referrer", frame && frame.getAttribute("referrerpolicy") === "no-referrer");

  // ---------- 11. 重复点击不叠加 iframe ----------
  doc.querySelector('[data-st="play"]').click();
  await new Promise(r => setTimeout(r, 200));
  doc.querySelector('[data-st="play"]').click();
  await new Promise(r => setTimeout(r, 200));
  check("连点播放后页面中只有 1 个 iframe", doc.querySelectorAll(".stream-frame").length === 1,
    "实际 " + doc.querySelectorAll(".stream-frame").length);

  // ---------- 12. 清除按钮 ----------
  const clearBtn = doc.querySelector('[data-st="clear"]');
  check("有片源时清除按钮可见", !!clearBtn && clearBtn.hidden === false, "存在=" + !!clearBtn + " hidden=" + (clearBtn && clearBtn.hidden));
  check("清除按钮始终存在于 DOM（靠 hidden 切换）", !!clearBtn);
  if (clearBtn && clearBtn.hidden === false) {
    clearBtn.click();
    await new Promise(r => setTimeout(r, 250));
    check("清除后设置被置空", evSync("settings.stream_url") === "", String(evSync("settings.stream_url")));
    check("清除后播放器容器隐藏", doc.querySelector("#st-mount").hidden === true);
    check("清除后 iframe 被移除", !doc.querySelector(".stream-frame"));
    check("清除后输入框清空", doc.querySelector("#st-url").value === "");
    check("清除后按钮重新隐藏", doc.querySelector('[data-st="clear"]').hidden === true);
    check("清除后「新标签打开」重新禁用", doc.querySelector('[data-st="open"]').disabled === true);
  }

  // ---------- 13. 设置持久化后重新进入页面能恢复 ----------
  await ev('settings.stream_url = "https://youtu.be/dQw4w9WgXcQ"; saveSettings(); go("home"); go("theater");');
  await new Promise(r => setTimeout(r, 350));
  check("重新进入放映厅时片源已回填",
    doc.querySelector("#st-url").value === "https://youtu.be/dQw4w9WgXcQ",
    doc.querySelector("#st-url").value);
  check("回填后「新标签打开」可用", doc.querySelector('[data-st="open"]').disabled === false);

  // ---------- 14. 回车键触发播放 ----------
  const inp2 = doc.querySelector("#st-url");
  inp2.value = "https://www.bilibili.com/video/BV1GJ411x7h7";
  inp2.dispatchEvent(new win.KeyboardEvent("keydown", { key:"Enter", bubbles:true }));
  await new Promise(r => setTimeout(r, 300));
  check("回车键可触发播放", !!doc.querySelector(".stream-frame"));

  console.log("\n通过 " + pass + " / " + (pass + fail));
  if (errs.length) { console.log("\n失败项："); errs.forEach(e => console.log("  · " + e)); }
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error("测试脚本异常:", e); process.exit(2); });
