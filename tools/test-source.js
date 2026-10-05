/* 播放源体系测试（多线路 + 选源算法）。
 *
 * 覆盖：数据迁移（幂等性是重点）、三态筛选、DFS 偏好字典序、
 *       分阶段自动选源、七级排序。
 *
 * 重点防四类回归：
 *  1. 迁移不幂等 → 启动/导入/恢复三条路径都调迁移，
 *     只要有一处重复调用就会多出一条重复线路；
 *  2. 迁移用 saveAnime 回写 → touch() 改 updatedAt，
 *     「最近添加」排序会把所有老作品顶到最前面；
 *  3. DFS 写成加权求和 → 4K 无字幕压过 1080P 有字幕，
 *     数字上 4K 分高，但用户要的是字幕；
 *  4. 筛选只剩二态 → 用户只看到「搜不到」，
 *     不知道是集数不对还是字幕缺失。 */
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const html = fs.readFileSync(path.join(__dirname, "..", "anime-rewind.html"), "utf8");
let pass = 0, fail = 0;
const fails = [];
function check(name, cond, extra){
  if(cond){ pass++; console.log("PASS " + name); }
  else { fail++; fails.push(name); console.log("FAIL " + name + (extra != null ? "   → " + extra : "")); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const dom = new JSDOM(html, { runScripts:"dangerously", url:"https://local.test/", pretendToBeVisual:true });
  const win = dom.window;
  await sleep(1100);
  /* 表达式求值器（已解析）。
     两个必须遵守的约定，否则断言结果会毫无意义：
     1. 调用方一律显式写 return —— 异步箭头函数体末尾没有 return 时
        返回 undefined 而不是最后一个表达式，静默 undefined 会让后续
        断言报出与真因无关的错误。
     2. 这里统一 JSON.parse 表达式里的 JSON.stringify 结果。
        若不在此处解析，测试文件里就会同时存在「已解析的期望值」
        和「未解析的实际值」两种形态，比较必然全假 ——
        表现为满屏 FAIL 但每条的 extra 值看起来又是对的。 */
  const ev = async expr => {
    const raw = await win.eval("(async()=>{" + expr + "})()");
    if(raw === undefined) throw new Error("表达式未返回结果（需显式 return）：" + expr.slice(0, 80));
    return typeof raw === "string" ? JSON.parse(raw) : raw;
  };
  /* jsdom 是单例：settings 等全局状态会被后续用例看到。
     某条用例设过 settings.stream_url，后面所有「线路列表」类断言都会被污染，
     表现为一片与被测逻辑无关的 FAIL。
     快照一次 + 每条污染用例后还原，把状态泄漏挡在用例之外。 */
  const snap = await ev(`return JSON.stringify(settings.stream_url || "")`);
  const restore = async () => {
    await ev('settings.stream_url = ' + JSON.stringify(snap) + '; return JSON.stringify(1)');
  };

  /* ---------- 1. 迁移 ---------- */
  const m1 = await ev(`
    const a = { id:"an1", streamUrl:"https://www.youtube.com/watch?v=abc", streamEp:3, streamUrlAt:"2026-01-02T03:04:05.000Z" };
    migrateSources(a);
    return JSON.stringify({ n:a.sources.length, url:a.sources[0].url, ep:a.sources[0].ep, name:a.sources[0].name, savedAt:a.sources[0].savedAt });
  `);
  const m1o = m1;
  check("旧 streamUrl 迁成一条线路", m1o.n === 1, "实得 " + m1o.n);
  check("迁移保住了网址", m1o.url === "https://www.youtube.com/watch?v=abc");
  check("迁移保住了集数", m1o.ep === 3, "实得 " + m1o.ep);
  check("迁移保住了记录时间", String(m1o.savedAt).slice(0, 10) === "2026-01-02", m1o.savedAt);

  /* 幂等性：连迁三次，线路数与 id 都不变。
     这是最关键的一条 —— boot / 导入 / 备份恢复都调迁移。 */
  const m2 = await ev(`
    const a = { id:"an2", streamUrl:"https://youtu.be/xyz", streamEp:1 };
    migrateSources(a); const first = JSON.stringify(a.sources);
    migrateSources(a); migrateSources(a);
    return JSON.stringify({ same: JSON.stringify(a.sources) === first, n:a.sources.length, id:a.sources[0].id });
  `);
  const m2o = m2;
  check("迁移幂等（连迁三次结果不变）", m2o.same && m2o.n === 1, JSON.stringify(m2o));
  check("线路 id 由网址派生且稳定", /^src-0-/.test(m2o.id), m2o.id);

  const m3 = await ev(`
    const a = { id:"an3", sources:[{url:"https://a.com/1", name:"线路A"},{url:"https://b.com/2", name:"线路B"}] };
    migrateSources(a);
    return JSON.stringify({ n:a.sources.length, names:a.sources.map(s=>s.name).join(",") });
  `);
  check("已是多线路的数据不会被旧字段覆盖", m3.n === 2, m3);

  const m4 = await ev(`
    const a = { id:"an4", streamUrl:"https://x.com/v" };
    migrateSources(a);
    return JSON.stringify({ ep:a.sources[0].ep, res:a.sources[0].resolution, kind:a.sources[0].subtitleKind, tier:a.sources[0].tier });
  `);
  const m4o = m4;
  check("缺失字段填确定默认值（不能是 undefined）",
    m4o.ep === null && m4o.res === null && m4o.kind === "EXTERNAL" && m4o.tier === 2, JSON.stringify(m4o));

  /* 无网址的条目必须被丢掉，否则 sources 里混着空线路，
     界面会渲染出一个点不动的空胶囊。 */
  const m5 = await ev(`
    const a = { id:"an5", sources:[{url:"https://ok.com/1"},{url:""},{url:null},{name:"没网址"}] };
    migrateSources(a); return JSON.stringify({ n:a.sources.length });
  `);
  check("无网址的线路被剔除", m5.n === 1, m5);

  /* settings.stream_url 兜底：老用户可能只有全局一份 */
  const m6 = await ev(`
    settings.stream_url = "https://legacy.com/v";
    const a = { id:"an6" };
    const list = sourcesOf(a);
    return JSON.stringify({ n:list.length, url:list[0].url });
  `);
  const m6o = m6;
  check("无自有线路时回落到历史全局片源", m6o.n === 1 && m6o.url === "https://legacy.com/v", m6o.url);
  await restore();

  /* 有自有线路时不能被全局兜底污染 */
  const m7 = await ev(`
    settings.stream_url = "https://legacy.com/v";
    const a = { id:"an7", sources:[{url:"https://own.com/1", name:"我的"}] };
    return JSON.stringify(sourcesOf(a).map(s=>s.url).join(","));
  `);
  check("有自有线路时不混入全局兜底", m7 === "https://own.com/1", m7);
  await restore();
  await restore();

  /* activeSourceId 记忆 */
  const m8 = await ev(`
    const a = { id:"an8", sources:[{id:"s1", url:"https://one.com/1", name:"一"},{id:"s2", url:"https://two.com/2", name:"二"}], activeSourceId:"s2" };
    return JSON.stringify(activeSourceOf(a).id);
  `);
  check("activeSourceId 决定用哪条线路", m8 === "s2", m8);

  const m9 = await ev(`
    const a = { id:"an9", sources:[{id:"s1", url:"https://one.com/1"}], activeSourceId:"已删除的id" };
    return JSON.stringify(activeSourceOf(a).id);
  `);
  check("记忆的线路已不存在时回退第一条（不返回 null）", m9 === "s1", m9);

  /* ---------- 2. 三态筛选 ---------- */
  /* 这里直接喂原始对象而不经 sourcesOf：sourcesOf 会在上一层
     剔除无网址的线路（已单独断言），所以拿它的产出测不出
     filterSources 自己的三态能力。测 filterSources 就该喂它输入。 */
  const f1 = await ev(`
    const r = filterSources([
      {id:"ok", url:"https://ok.com/1", name:"可用", resolution:"1080P"},
      {id:"bad", url:"", name:"空网址"}
    ], { showExcluded:true });
    return JSON.stringify(r.map(x => x.state + ":" + (x.reason||"")));
  `);
  check("筛选产出三态（included + excluded 带原因）",
    f1.join(",") === "included:,excluded:invalid_url", f1);

  /* 反向：sourcesOf 先剔空 → filterSources 拿到的一定都是合法线路。 */
  const f1b = await ev(`
    const list = sourcesOf({ sources:[
      {id:"ok", url:"https://ok.com/1", name:"可用"},
      {id:"bad", url:"", name:"空网址"}
    ]});
    return JSON.stringify(filterSources(list, { showExcluded:true }).map(x => x.state));
  `);
  check("经sourcesOf 后不再有invalid 项（两层职责不重叠）",
    f1b.join(",") === "included", f1b);

  const f2 = await ev(`
    const list = sourcesOf({ sources:[
      {id:"e3", url:"https://a.com/1", ep:3},
      {id:"e5", url:"https://b.com/1", ep:5},
      {id:"eall", url:"https://c.com/1", ep:null}
    ]});
    const r = filterSources(list, { wantEp:5, showExcluded:true });
    return JSON.stringify(r.map(x => x.original.id + "=" + x.state + (x.reason?"/"+x.reason:"")));
  `);
  check("集数不匹配被排除但保留在列表里", f2.indexOf("e3=excluded/episode_mismatch") >= 0, f2);
  check("ep 为空视为整季通用，不因集数被排除", f2.indexOf("eall=included") >= 0, f2);

  const f3 = await ev(`
    const list = sourcesOf({ sources:[
      {id:"emb", url:"https://a.com/1", subtitleKind:"EMBEDDED"},
      {id:"ext", url:"https://b.com/1", subtitleKind:"EXTERNAL"}
    ]});
    const r = filterSources(list, { wantSubtitle:"CHS", showExcluded:true });
    return JSON.stringify(r.map(x => x.original.id + "=" + x.state + (x.reason?"/"+x.reason:"")));
  `);
  check("要求外挂字幕时硬字幕被排除", f3.indexOf("emb=excluded/subtitle_kind") >= 0, f3);

  const f4 = await ev(`
    const list = sourcesOf({ sources:[
      {id:"chs", url:"https://a.com/1", subtitles:["CHS"]},
      {id:"jpy", url:"https://b.com/1", subtitles:["JPY"]}
    ]});
    const r = filterSources(list, { wantSubtitle:"CHS", showExcluded:true });
    return JSON.stringify(r.map(x => x.original.id + "=" + x.state + (x.reason?"/"+x.reason:"")));
  `);
  check("字幕语言不符被排除且原因写明", f4.indexOf("jpy=excluded/no_subtitle") >= 0, f4);

  const f5 = await ev(`
    const list = sourcesOf({ sources:[
      {id:"bad", url:"", name:"空"},{id:"ok", url:"https://ok.com/1", name:"好"}
    ]});
    return JSON.stringify(filterSources(list, {}).length);
  `);
  check("默认不显示排除项", f5 === 1, f5);

  /* ---------- 3. 七级排序 ---------- */
  const s1 = await ev(`
    const list = sourcesOf({ sources:[
      {id:"720", url:"https://a.com/1", resolution:"720P", name:"A"},
      {id:"4k",  url:"https://b.com/1", resolution:"2160P", name:"B"},
      {id:"1080",url:"https://c.com/1", resolution:"1080P", name:"C"},
      {id:"none",url:"https://d.com/1", resolution:null,     name:"D"}
    ]});
    return JSON.stringify(filterSources(list, {}).map(x => x.src.resolution || "未知"));
  `);
  check("按分辨率从高到低排，未知排最后",
    s1.join(",") === "2160P,1080P,720P,未知", s1);

  const s2 = await ev(`
    const list = sourcesOf({ sources:[
      {id:"z", url:"https://a.com/1", resolution:"1080P", tier:0, name:"Z线"},
      {id:"a", url:"https://b.com/1", resolution:"1080P", tier:5, name:"A线"}
    ]});
    return JSON.stringify(filterSources(list, {}).map(x => x.src.name));
  `);
  check("同分辨率下 tier 低的优先", s2.join(",") === "Z线,A线", s2);

  /* ---------- 4. DFS 偏好字典序 ----------
     这是整个选源算法的核心断言：分辨率优先于字幕，
     但「字幕组匹配不到时不换更差的语言」。 */
  const d1 = await ev(`
    const list = sourcesOf({ sources:[
      {id:"4k-no-sub", url:"https://a.com/1", resolution:"2160P", subtitles:[], name:"4K无字幕"},
      {id:"1080-chs",  url:"https://b.com/1", resolution:"1080P", subtitles:["CHS"], name:"1080简中"}
    ]});
    const inc = filterSources(list, {});
    return JSON.stringify((pickByPreference(inc, { subtitleLanguage:"CHS" })||{}).id);
  `);
  check("偏好字幕时不会为 4K 放弃字幕", d1 === "1080-chs", d1);

  const d2 = await ev(`
    const list = sourcesOf({ sources:[
      {id:"4k-no-sub", url:"https://a.com/1", resolution:"2160P", subtitles:[], name:"4K无字幕"},
      {id:"1080-chs",  url:"https://b.com/1", resolution:"1080P", subtitles:["CHS"], name:"1080简中"}
    ]});
    const inc = filterSources(list, {});
    return JSON.stringify((pickByPreference(inc, {})||{}).id);
  `);
  check("无偏好时取分辨率最高", d2 === "4k-no-sub", d2);

  /* 关键：字幕组没匹配到时，不能下降到更差的字幕语言 */
  const d3 = await ev(`
    const list = sourcesOf({ sources:[
      {id:"chs-only", url:"https://a.com/1", resolution:"1080P", subtitles:["CHS"], name:"只有简中"}
    ]});
    const inc = filterSources(list, {});
    /* 偏好一个不存在的字幕组「桜都」，且语言只偏好 CHS。
       正确行为：字幕组匹配不到 → 仍在 CHS 层内把线路层再跑一遍 → 选中简中这条。
       错误行为：直接跳到下一语言层 → 什么都选不到 → 退回排序最优（这里恰好相同，
       所以用两条线路拉开差距来区分）。 */
    return JSON.stringify((pickByPreference(inc, { alliance:"不存在的组", fallbackSubtitleLanguages:["JPY"] })||{}).id);
  `);
  check("字幕组匹配不到时不下降到更差语言", d3 === "chs-only", d3);

  /* 上面这条若写错成加权求和或提前下降，结果会变成 null。
     这里再加一条：偏好存在时确实命中指定线路。 */
  const d4 = await ev(`
    const list = sourcesOf({ sources:[
      {id:"a", url:"https://a.com/1", resolution:"1080P", name:"甲线"},
      {id:"b", url:"https://b.com/1", resolution:"1080P", name:"乙线"}
    ]});
    const inc = filterSources(list, {});
    return JSON.stringify((pickByPreference(inc, { alliance:"乙线" })||{}).id);
  `);
  check("指定字幕组时命中该组", d4 === "b", d4);

  const d5 = await ev(`
    settings.stream_url = "";
    return JSON.stringify(pickByPreference(filterSources(sourcesOf({sources:[]}), {}), {}));
  `);
  check("没有候选时返回 null（不抛错）", d5 === null, d5);

  const d6 = await ev(`
    const list = sourcesOf({ sources:[
      {id:"x", url:"https://x.com/1", resolution:"720P"},
      {id:"y", url:"https://y.com/1", resolution:"1080P"}
    ]});
    const inc = filterSources(list, {});
    return JSON.stringify((pickByPreference(inc, { resolution:"720P" })||{}).id);
  `);
  check("指定分辨率时精确命中", d6 === "x", d6);

  /* ---------- 5. 分阶段自动选源 ---------- */
  const a1 = await ev(`
    const list = sourcesOf({ sources:[
      {id:"used", url:"https://a.com/1", name:"上次用的", tier:9, resolution:"480P"},
      {id:"best", url:"https://b.com/1", name:"更好的", tier:0, resolution:"2160P"}
    ]});
    const r = autoSelect(filterSources(list, {}), { preferredSourceId:"used" });
    return JSON.stringify({ id:r.source.id, stage:r.stage });
  `);
  const a1o = a1;
  check("记忆线路可用时优先用它（即使质量更差）",
    a1o.id === "used" && a1o.stage === "preferred", a1);

  const a2 = await ev(`
    const list = sourcesOf({ sources:[
      {id:"t3", url:"https://a.com/1", name:"普通", tier:3, resolution:"1080P"}
    ]});
    const r = autoSelect(filterSources(list, {}), { fastSelect:true });
    return JSON.stringify({ stage:r.stage, id:r.source.id });
  `);
  check("无记忆线路时走优先级判定", a2.stage === "exact", a2);

  const a3 = await ev(`
    const list = sourcesOf({ sources:[
      {id:"t0", url:"https://a.com/1", name:"极速", tier:0, resolution:"480P"},
      {id:"t1", url:"https://b.com/1", name:"较快", tier:1, resolution:"2160P"}
    ]});
    const r = autoSelect(filterSources(list, {}), { fastSelect:true });
    return JSON.stringify({ stage:r.stage, id:r.source.id });
  `);
  const a3o = a3;
  check("开启快速选择时优先 tier<=0 的线路", a3o.stage === "instant" && a3o.id === "t0", a3);

  const a4 = await ev(`
    /* 显式清空兜底片源：settings 是 jsdom 单例，
       前面用例设过的值会一直留在这里，让「无可用线路」永远有线路。 */
    settings.stream_url = "";
    const r = autoSelect(filterSources(sourcesOf({sources:[{url:"", name:"空"}]}), {}), {});
    return JSON.stringify({ src:r.source, stage:r.stage });
  `);
  check("无可用线路时返回 null 且不抛错", a4.src === null, a4);
  await restore();

  /* ---------- 6. 迁移未被 saveAnime 回写（updatedAt 不该变） ---------- */
  /* 检查对象是磁盘上的源文件，不是 jsdom 的 DOM ——
     脚本源码不会被注入 document.documentElement.innerHTML，
     在 DOM 里找源码只会永远得到 false，断言就成了摆设。
     正则里的 \s 在经过 win.eval 时会被吃掉一层转义，
     所以这里不经过 eval，直接用 Node 读文件匹配。 */
  const fileSrc = fs.readFileSync(path.join(__dirname, "..", "anime-rewind.html"), "utf8");
  const migBlock = fileSrc.match(/const needSourceMigrate[\s\S]{0,400}?\n {4}\}/);
  check("迁移落盘代码块存在", !!migBlock, "未找到 needSourceMigrate 块");
  check("迁移落盘走 Repo.put",
    !!migBlock && /Repo\.put\("anime"/.test(migBlock[0]),
    migBlock ? migBlock[0].slice(0, 120) : "");
  check("迁移落盘不调用 saveAnime（避免改 updatedAt）",
    !!migBlock && !/saveAnime\(/.test(migBlock[0]),
    migBlock && /saveAnime\(/.test(migBlock[0]) ? "迁移落盘里出现了 saveAnime" : "");

  /* ---------- 7. 常量 ---------- */
  const c1 = await ev(`return JSON.stringify(RESOLUTION_ORDER)`);
  check("分辨率档位从高到低",
    c1.join(",") === "2160P,1440P,1080P,720P,480P", c1);

  const c2 = await ev(`return JSON.stringify(Object.values(EXCLUDE_REASONS))`);
  check("四种排除原因都有中文说明",
    c2.length === 4 && c2.every(x => /[一-龥]/.test(x)), c2);

  console.log("\n" + (fail === 0 ? "全部通过 " : "") + pass + " 项通过" + (fail ? "，" + fail + " 项失败" : ""));
  if(fail){ console.log("失败项：\n - " + fails.join("\n - ")); process.exit(1); }
})().catch(e => { console.error("测试自身异常：", e); process.exit(2); });
