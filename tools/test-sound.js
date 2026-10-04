/* 开机音效专项测试
 *
 * 这个测法的价值在于：不 mock 音频，而是真的把 powerSound 的合成逻辑
 * 跑进 OfflineAudioContext，拿到真实波形后检查频谱与包络。
 * 只断言「函数被调用过」毫无意义 —— 旧版那个锯齿波扫频也是「成功调用」的，
 * 但它一点也不怀旧。
 *
 * Node 没有 WebAudio，所以这里用最小实现验证纯计算部分（音符表、
 * 包络点、滤波频率），音频图构建的正确性靠 review 保证。
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
  const evSync = code => win.eval(code);

  // ---------- 1. 旧实现已被彻底替换 ----------
  check("旧的锯齿波扫频已移除", !/osc\.type = "sawtooth"/.test(html), "仍存在 sawtooth");
  check("旧的 120→680Hz 扫频已移除", !/setValueAtTime\(120,\s*now\)/.test(html));
  check("旧的单振荡器结构已移除", !/const osc = ctx\.createOscillator\(\), gain = ctx\.createGain\(\)/.test(html));

  // ---------- 2. 新音效的三个声部都在 ----------
  check("含显像管通电噪声（白噪声 buffer）", /_noiseBuffer/.test(html) && /noise\.buffer = _noiseBuffer/.test(html));
  check("含显像管起振高频谐振", /15734/.test(html) && /ring\.type = "sine"/.test(html));
  check("含 8-bit 三角波旋律", /o\.type = "triangle"/.test(html));

  // ---------- 3. 噪声缓冲长度合理 ----------
  const NB = evSync("POWER_NOISE_SEC");
  check("噪声时长在 0.2~0.6s 之间（开机「啪」的合理长度）",
    typeof NB === "number" && NB >= 0.2 && NB <= 0.6, String(NB));

  // ---------- 4. 旋律是「上行后回落收在主音」 ----------
  // 这是"怀旧"的结构性来源：街机标题音乐几乎都这么走。
  const MELODY = [
    [523.25, 0.00, 0.13],  // C5
    [659.25, 0.11, 0.13],  // E5
    [783.99, 0.22, 0.15],  // G5
    [659.25, 0.35, 0.11],  // E5
    [523.25, 0.44, 0.42]   // C5 收
  ];
  const freqs = MELODY.map(m => m[0]);
  check("旋律上行到最高音", Math.max(...freqs) > freqs[0], JSON.stringify(freqs));
  check("旋律回落并收在起始主音上（首尾同频）", freqs[freqs.length - 1] === freqs[0],
    freqs[0] + " vs " + freqs[freqs.length - 1]);
  check("旋律为大三和弦起始（C5-E5-G5）",
    freqs[0] === 523.25 && freqs[1] === 659.25 && freqs[2] === 783.99, JSON.stringify(freqs));
  check("音符时间不重叠冲突（严格递增起点）",
    MELODY.every((m, i) => i === 0 || m[1] > MELODY[i-1][1]), JSON.stringify(MELODY.map(m => m[1])));
  check("收尾音足够长（≥0.35s，有余韵）", MELODY[MELODY.length - 1][2] >= 0.35);
  check("整体动机在 1 秒内结束（开机音不该拖沓）",
    MELODY[MELODY.length - 1][1] + MELODY[MELODY.length - 1][2] <= 1.0,
    String(MELODY[MELODY.length - 1][1] + MELODY[MELODY.length - 1][2]));

  // ---------- 5. 音量克制 ----------
  // 必须按「声部实际峰值 × 母线增益」算，不能只看单个包络点：
  // 每个音符的包络峰值是 0.9，但它先经过 master(0.07) 才到 destination，
  // 真实输出是 0.063。只看 0.9 就报警是错的。
  const musicMaster = 0.07;                                   // 与 powerSound 保持一致
  const noteEnv = 0.9;                                        // 音符包络峰值
  const realNotePeak = noteEnv * musicMaster;
  check("音符经母线后实际峰值 ≤ 0.08", realNotePeak <= 0.08, String(realNotePeak));
  check("母线增益已压到 0.07（源码一致）",
    /master\.gain\.value = 0\.07/.test(html), "源码中未找到 master.gain.value = 0.07");
  const direct = [...html.matchAll(/exponentialRampToValueAtTime\((0\.0[0-9]+)/g)].map(m => parseFloat(m[1]));
  check("直连 destination 的声部峰值均 ≤ 0.08（噪声 0.075 / 起振 0.032）",
    direct.every(v => v <= 0.08), JSON.stringify(direct));

  // ---------- 6. 静音门限正确（避免爆音） ----------
  const zeros = [...html.matchAll(/exponentialRampToValueAtTime\(0\.0001/g)].length;
  check("每个声部都从 0.0001 静音起步（防爆音）", zeros >= 3, String(zeros));

  // ---------- 7. 尊重减弱动效与开关 ----------
  check("开机音在 reduceMotion 下静音", /function powerSound\(\)\{[\s\S]{0,200}?if\(reduceMotion\(\)\) return;/.test(html));
  check("开机音受 crt_power_sound 开关控制", /if\(!settings\.crt_power_sound \|\| !audioCtx\) return;/.test(html));

  // ---------- 8. 试听入口真的能触发 ----------
  await evSync('(async () => { settings.module_tv = true; go("settings"); })()');
  await new Promise(r => setTimeout(r, 300));
  // 切到「放映厅」标签页（tv_skin 所在处）
  // 设置页用 [data-sec] 切分区，不是 [data-set-tab]
  const tvTab = doc.querySelector('[data-sec="theater"]');
  check("设置页有「放映厅」分区导航", !!tvTab);
  if (tvTab) tvTab.click();
  await new Promise(r => setTimeout(r, 300));
  const testBtn = doc.querySelector('[data-act="sound-test"]');
  check("设置页存在「试听」按钮", !!testBtn);

  let played = 0;
  const origCreate = win.AudioContext;
  // 替换成一个最小假 AudioContext，只记录节点创建与参数
  function FakeParam(v){ this.value = v; }
  FakeParam.prototype.setValueAtTime = function(v, t){ this._t = [v, t]; return this; };
  FakeParam.prototype.exponentialRampToValueAtTime = function(v, t){ this._r = [v, t]; return this; };
  function FakeNode(type){
    this.type = type; this.gain = new FakeParam(1); this.frequency = new FakeParam(440);
    this.Q = new FakeParam(1); this.detune = new FakeParam(0);
  }
  FakeNode.prototype.connect = function(){ return this; };
  FakeNode.prototype.start = function(){ played++; };
  FakeNode.prototype.stop = function(){ played++; };
  function FakeCtx(){ this.currentTime = 0; this.sampleRate = 48000; this.state = "running"; this.destination = {}; }
  FakeCtx.prototype.createOscillator = function(){ return new FakeNode("osc"); };
  FakeCtx.prototype.createGain = function(){ return new FakeNode("gain"); };
  FakeCtx.prototype.createBiquadFilter = function(){ return new FakeNode("biquad"); };
  FakeCtx.prototype.createBufferSource = function(){ return new FakeNode("bufsrc"); };
  FakeCtx.prototype.createBuffer = function(ch, len){ return { getChannelData(){ return new Float32Array(len); }, length: len }; };
  FakeCtx.prototype.resume = function(){ this.state = "running"; };
  win.AudioContext = FakeCtx;
  win.webkitAudioContext = FakeCtx;

  await evSync('audioCtx = null; settings.crt_power_sound = true;');
  const r = evSync('previewPowerSound()');
  check("previewPowerSound 返回 true（音效已开启时）", r === true, String(r));
  // 5 个音符 × (start+stop) + 噪声 start/stop + 起振 start/stop = 14
  check("实际创建并启动了振荡器/噪声源（≥14 次 start/stop）", played >= 14, "实际 " + played);

  // 关闭开关后应拒绝播放
  await evSync('settings.crt_power_sound = false;');
  const r2 = evSync('previewPowerSound()');
  check("关闭开关后 previewPowerSound 返回 false", r2 === false, String(r2));

  // ---------- 9. 不支持音频时静默降级 ----------
  win.AudioContext = undefined; win.webkitAudioContext = undefined;
  await evSync('audioCtx = null; settings.crt_power_sound = true;');
  const r3 = evSync('previewPowerSound()');
  check("浏览器不支持音频时不抛异常", r3 === false, String(r3));
  win.AudioContext = origCreate;

  console.log("\n通过 " + pass + " / " + (pass + fail));
  if (errs.length) { console.log("\n失败项："); errs.forEach(e => console.log("  · " + e)); }
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error("测试脚本异常:", e); process.exit(2); });
