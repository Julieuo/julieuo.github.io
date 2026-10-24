// 播放与渲染：用 soundfont-player 加载 General MIDI 音色，加载失败时退回简单合成器。

import { makeClock, DEFAULT_LEVEL } from "./jianpu.js";

// [音色名, 显示名, GM 音色号]
export const INSTRUMENTS = [
  ["flute", "长笛 / 笛子", 73],
  ["piccolo", "短笛 / 梆笛", 72],
  ["shakuhachi", "尺八（近似箫）", 77],
  ["pan_flute", "排箫", 75],
  ["recorder", "竖笛", 74],
  ["ocarina", "陶笛（近似埙）", 79],
  ["koto", "古筝", 107],
  ["shamisen", "三味线（近似琵琶）", 106],
  ["banjo", "班卓（近似柳琴、阮）", 105],
  ["dulcimer", "扬琴", 15],
  ["sitar", "西塔琴", 104],
  ["orchestral_harp", "竖琴", 46],
  ["acoustic_guitar_nylon", "古典吉他", 24],
  ["violin", "小提琴（近似二胡）", 40],
  ["fiddle", "民间提琴（近似二胡，另一种）", 110],
  ["viola", "中提琴（近似中胡）", 41],
  ["cello", "大提琴", 42],
  ["contrabass", "低音提琴", 43],
  ["string_ensemble_1", "弦乐合奏", 48],
  ["pizzicato_strings", "弦乐拨奏", 45],
  ["shanai", "唢呐", 111],
  ["accordion", "手风琴（近似笙）", 21],
  ["harmonica", "口琴", 22],
  ["oboe", "双簧管", 68],
  ["clarinet", "单簧管", 71],
  ["bassoon", "大管", 70],
  ["soprano_sax", "高音萨克斯", 64],
  ["alto_sax", "中音萨克斯", 65],
  ["tenor_sax", "次中音萨克斯", 66],
  ["trumpet", "小号", 56],
  ["trombone", "长号", 57],
  ["french_horn", "圆号", 60],
  ["tuba", "大号", 58],
  ["acoustic_grand_piano", "钢琴", 0],
  ["electric_piano_1", "电钢琴", 4],
  ["church_organ", "管风琴", 19],
  ["marimba", "马林巴", 12],
  ["xylophone", "木琴", 13],
  ["glockenspiel", "钟琴", 9],
  ["music_box", "八音盒", 10],
  ["voice_oohs", "人声（呜）", 53],
  ["choir_aahs", "合唱（啊）", 52],
  ["acoustic_bass", "贝斯", 32],
];
export const GM_PROGRAM = Object.fromEntries(INSTRUMENTS.map(([id, , p]) => [id, p]));

// 按声部名猜乐器和八度
const NAME_RULES = [
  [/低音提琴|倍大提琴|贝斯|bass/i, "contrabass", -1],
  [/大提琴|革胡|cello/i, "cello", -1],
  [/中提琴|viola/i, "viola", 0],
  [/小提琴|violin/i, "violin", 0],
  [/中胡/, "viola", 0],
  [/胡/, "violin", 0],
  [/短笛|梆笛|piccolo/i, "piccolo", 1],
  [/长笛|flute/i, "flute", 0],
  [/排箫/, "pan_flute", 0],
  [/笛/, "flute", 1],
  [/箫/, "shakuhachi", 0],
  [/埙/, "ocarina", 0],
  [/琵琶/, "shamisen", 0],
  [/筝/, "koto", 0],
  [/扬琴/, "dulcimer", 0],
  [/柳琴|阮|月琴|三弦/, "banjo", 0],
  [/竖琴|harp/i, "orchestral_harp", 0],
  [/吉他|guitar/i, "acoustic_guitar_nylon", 0],
  [/唢呐/, "shanai", 0],
  [/笙/, "accordion", 0],
  [/手风琴/, "accordion", 0],
  [/口琴/, "harmonica", 0],
  [/双簧管|oboe/i, "oboe", 0],
  [/单簧管|黑管|clarinet/i, "clarinet", 0],
  [/大管|巴松|bassoon/i, "bassoon", -1],
  [/次中音萨克斯/, "tenor_sax", -1],
  [/萨克斯|sax/i, "alto_sax", 0],
  [/小号|trumpet/i, "trumpet", 0],
  [/长号|trombone/i, "trombone", -1],
  [/圆号|horn/i, "french_horn", 0],
  [/大号|tuba/i, "tuba", -1],
  [/钢琴|piano/i, "acoustic_grand_piano", 0],
  [/马林巴/, "marimba", 0],
  [/木琴/, "xylophone", 0],
  [/钟琴|铝板琴/, "glockenspiel", 1],
  [/吟唱|伴唱|和声|合唱|choir/i, "choir_aahs", 0],
  [/人声|演唱|独唱|领唱|歌|voice|vocal/i, "voice_oohs", 0],
];
const FALLBACK_ORDER = ["acoustic_grand_piano", "flute", "violin", "cello", "clarinet", "koto"];

export function defaultInstrument(name, index) {
  for (const [re, inst, oct] of NAME_RULES) if (re.test(name)) return { instrument: inst, octave: oct };
  return { instrument: FALLBACK_ORDER[index % FALLBACK_ORDER.length], octave: 0 };
}

function withTimeout(promise, ms) {
  return Promise.race([promise, new Promise((_, rej) => setTimeout(() => rej(new Error("音色加载超时")), ms))]);
}

async function loadInstrument(ctx, name, destination) {
  if (window.Soundfont) {
    try {
      const inst = await withTimeout(
        window.Soundfont.instrument(ctx, name, { soundfont: "FluidR3_GM", format: "mp3", destination }),
        30000
      );
      return inst;
    } catch (err) {
      console.warn(`音色 ${name} 加载失败，改用合成器`, err);
    }
  }
  return makeSynth(ctx, destination);
}

function makeSynth(ctx, destination) {
  const nodes = new Set();
  return {
    fallback: true,
    play(midi, when, { duration = 0.5, gain = 1 } = {}) {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = "triangle";
      o.frequency.value = 440 * Math.pow(2, (midi - 69) / 12);
      const end = when + duration;
      g.gain.setValueAtTime(0, when);
      g.gain.linearRampToValueAtTime(0.35 * gain, when + 0.015);
      g.gain.setTargetAtTime(0.22 * gain, when + 0.015, 0.15);
      g.gain.setTargetAtTime(0, end, 0.06);
      o.connect(g).connect(destination);
      o.start(when);
      o.stop(end + 0.4);
      nodes.add(o);
      o.onended = () => nodes.delete(o);
    },
    stop() {
      for (const o of nodes) {
        try { o.stop(); } catch {}
      }
      nodes.clear();
    },
  };
}

// 某个声部当前是否发声（考虑静音与独奏）
export function isAudible(settings, i) {
  const anySolo = settings.parts.some((p) => p.solo);
  const p = settings.parts[i];
  return anySolo ? p.solo : !p.mute;
}

const HARMONIC_INSTRUMENT = "guitar_harmonics"; // 泛音用的音色
const hasHarmonics = (part) => part.events.some((e) => e.h);

// 总线上加一个压缩器，几个声部同时 ff 时不至于爆音
function makeMaster(ctx) {
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -10;
  comp.knee.value = 10;
  comp.ratio.value = 4;
  comp.attack.value = 0.005;
  comp.release.value = 0.2;
  comp.connect(ctx.destination);
  return comp;
}

// 收集要演奏的音符，按时间排序；时间单位为秒（相对乐曲开头）
function collectNotes(score, settings, clock, fromBeat, toBeat, include) {
  const endSec = clock.toSec(toBeat);
  const notes = [];
  score.parts.forEach((part, i) => {
    if (!include(i)) return;
    const ps = settings.parts[i];
    const shift = settings.transpose + 12 * ps.octave;
    for (const e of part.events) {
      if (e.t < fromBeat - 1e-9 || e.t >= toBeat - 1e-9) continue;
      const when = clock.toSec(e.t);
      const end = Math.min(clock.toSec(e.t + e.d), endSec);
      const gain = (e.v ?? DEFAULT_LEVEL) / DEFAULT_LEVEL;
      for (const m of e.m) {
        const midi = m + shift;
        if (midi >= 21 && midi <= 108) notes.push({ part: i, when, dur: Math.max(0.04, end - when), midi, gain, h: !!e.h });
      }
    }
  });
  notes.sort((a, b) => a.when - b.when);
  return notes;
}

// 节拍器：范围内每一拍的时间（秒）；小节第一拍重音。弱起小节从后往前数，最后一拍正好接到下一小节线
function collectBeats(score, clock, fromBeat, toBeat) {
  const out = [];
  const bars = score.bars;
  for (let k = 0; k < bars.length; k++) {
    const b = bars[k];
    const next = k + 1 < bars.length ? bars[k + 1] : score.length;
    if (next <= fromBeat + 1e-9 || b >= toBeat - 1e-9) continue;
    let ts = score.timeSigs[0];
    for (const t of score.timeSigs) if (t.beat <= b + 1e-6) ts = t;
    const unit = 4 / ts.den;
    const total = Math.max(1, Math.round((next - b) / unit));
    const shift = total < ts.num ? ts.num - total : 0;
    for (let j = 0; j < total; j++) {
      const beat = b + j * unit;
      if (beat >= toBeat - 1e-9) break;
      if (beat < fromBeat - 1e-9) continue;
      out.push({ click: true, when: clock.toSec(beat), accent: (j + shift) % ts.num === 0 });
    }
  }
  return out;
}

export class Engine {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.parts = []; // 每个声部 {gain, instrument, inst, harm}
    this.timer = null;
    this.raf = null;
    this.onTick = null; // (beat, pass) 每帧调用
    this.onEnd = null;
    this.playing = false;
    this.clicks = new Set();
    this.onCountIn = null; // (第几拍, 一共几拍, 这一拍在小节里数第几)
  }

  ensureContext() {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.master = makeMaster(this.ctx);
    }
    return this.ctx;
  }

  // 为每个声部准备音色（已加载的直接复用）
  async prepare(score, settings) {
    const ctx = this.ensureContext();
    const jobs = settings.parts.map(async (ps, i) => {
      let slot = this.parts[i];
      if (!slot) {
        const gain = ctx.createGain();
        gain.connect(this.master);
        slot = this.parts[i] = { gain, instrument: null, inst: null, harm: null };
      }
      if (slot.instrument !== ps.instrument || !slot.inst) {
        slot.instrument = ps.instrument;
        slot.inst = null;
        const inst = await loadInstrument(ctx, ps.instrument, slot.gain);
        if (slot.instrument === ps.instrument) slot.inst = inst;
      }
      if (!slot.harm && hasHarmonics(score.parts[i])) slot.harm = await loadInstrument(ctx, HARMONIC_INSTRUMENT, slot.gain);
    });
    await Promise.all(jobs);
    this.parts.length = settings.parts.length;
    return this.parts.some((p) => p?.inst?.fallback);
  }

  updateMix(settings) {
    if (!this.ctx) return;
    settings.parts.forEach((ps, i) => {
      const slot = this.parts[i];
      if (!slot) return;
      const v = isAudible(settings, i) ? ps.volume : 0;
      slot.gain.gain.setTargetAtTime(v, this.ctx.currentTime, 0.02);
    });
  }

  // 从 startAt 播到 rangeEnd；之后从 rangeStart 到 rangeEnd 再重复，总共 repeats 遍（0 = 一直循环）
  // countIn：先打预备拍再开始演奏，{bars: n} 按起点处的拍号打 n 小节，{beats: n} 打 n 拍；null 不打
  // metronome：演奏过程中每拍打一下“嗒”（小节第一拍重一些）
  async play(score, settings, { rangeStart, rangeEnd, startAt = rangeStart, repeats = 1, countIn = null, metronome = false }) {
    this.stop();
    const ctx = this.ensureContext();
    await ctx.resume();
    const usedFallback = await this.prepare(score, settings);
    this.updateMix(settings);

    const clock = makeClock(score.tempos, settings.tempoFactor);
    const notes = collectNotes(score, settings, clock, rangeStart, rangeEnd, () => true);
    if (metronome) {
      notes.push(...collectBeats(score, clock, rangeStart, rangeEnd));
      notes.sort((a, b) => a.when - b.when);
    }
    const rs = clock.toSec(rangeStart);
    const re = clock.toSec(rangeEnd);
    const ss = clock.toSec(Math.max(rangeStart, Math.min(startAt, rangeEnd)));
    const L = re - rs;
    if (L < 0.05) repeats = 1;
    const startBeat = Math.max(rangeStart, Math.min(startAt, rangeEnd));
    let ts = score.timeSigs[0];
    for (const t of score.timeSigs) if (t.beat <= startBeat + 1e-6) ts = t;
    // 预备拍按谱面速度打，不算延长记号带来的放慢
    const base = makeClock(score.baseTempos ?? score.tempos, settings.tempoFactor);
    const unit = 4 / ts.den; // 一拍等于几个四分音符
    const clickGap = base.toSec(startBeat + unit) - base.toSec(startBeat);
    const clicks = !countIn ? 0 : countIn.bars ? Math.round(countIn.bars) * ts.num : Math.max(0, Math.round(countIn.beats) || 0);
    // 拍数不是整小节时从小节中间数起，让最后一拍正好接到起点：4/4 拍预备 6 拍就数 “3 4 | 1 2 3 4”
    const firstLabel = (ts.num - (clicks % ts.num)) % ts.num;
    const labelOf = (i) => ((i + firstLabel) % ts.num) + 1;
    const countStart = ctx.currentTime + 0.2;
    for (let i = 0; i < clicks; i++) this.click(countStart + i * clickGap, i === 0 || labelOf(i) === 1);
    const T0 = countStart + clicks * clickGap;
    // 第 k 遍里，乐曲时间 s 秒对应的 AudioContext 时间 = passBase(k) + s
    const passBase = (k) => (k === 0 ? T0 - ss : T0 + (re - ss) + (k - 1) * L - rs);
    const totalEnd = repeats === 0 ? Infinity : passBase(repeats - 1) + re;

    let pass = 0;
    let idx = notes.findIndex((n) => n.when >= ss - 1e-6);
    if (idx < 0) idx = notes.length;
    this.playing = true;

    const schedule = () => {
      const horizon = ctx.currentTime + 0.6;
      for (;;) {
        if (idx >= notes.length) {
          if (repeats !== 0 && pass + 1 >= repeats) break;
          if (passBase(pass + 1) + rs >= horizon) break;
          pass++;
          idx = 0;
          continue;
        }
        const n = notes[idx];
        const at = passBase(pass) + n.when;
        if (at >= horizon) break;
        if (n.click) {
          this.click(at, n.accent, 0.55);
        } else {
          const slot = this.parts[n.part];
          const inst = n.h ? slot?.harm || slot?.inst : slot?.inst;
          if (inst) inst.play(n.midi, at, { duration: n.dur, gain: n.gain });
        }
        idx++;
      }
    };
    schedule();
    this.timer = setInterval(schedule, 100);

    const firstEnd = T0 + (re - ss);
    const tick = () => {
      if (!this.playing) return;
      const now = ctx.currentTime;
      if (now < T0) {
        // 预备拍：报第几拍
        const k = Math.max(1, Math.min(clicks, Math.floor((now - countStart) / clickGap) + 1));
        this.onCountIn?.(k, clicks, labelOf(k - 1));
        this.raf = requestAnimationFrame(tick);
        return;
      }
      if (now > totalEnd + 0.4) {
        this.stop();
        this.onEnd?.();
        return;
      }
      const k = now < firstEnd ? 0 : 1 + Math.floor((now - firstEnd) / L);
      const sec = Math.max(k === 0 ? ss : rs, Math.min(re, now - passBase(k)));
      this.onTick?.(clock.toBeat(sec), k);
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
    return usedFallback;
  }

  // 预备拍和节拍器的“嗒”声：重拍高一些、响一些；level 是整体音量（节拍器比预备拍轻）
  click(when, accent, level = 1) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = "square";
    o.frequency.value = accent ? 1760 : 1175;
    g.gain.setValueAtTime(0, when);
    g.gain.linearRampToValueAtTime((accent ? 0.35 : 0.22) * level, when + 0.002);
    g.gain.exponentialRampToValueAtTime(0.001, when + 0.06);
    o.connect(g).connect(this.master);
    o.start(when);
    o.stop(when + 0.08);
    this.clicks.add(o);
    o.onended = () => this.clicks.delete(o);
  }

  stop() {
    for (const o of this.clicks) {
      try { o.stop(); } catch {}
    }
    this.clicks.clear();
    this.playing = false;
    clearInterval(this.timer);
    cancelAnimationFrame(this.raf);
    for (const slot of this.parts) {
      try { slot?.inst?.stop(); } catch {}
      try { slot?.harm?.stop(); } catch {}
    }
  }

  // 离线渲染成 WAV；include(i) 决定哪些声部参与
  async renderWav(score, settings, fromBeat, toBeat, include) {
    const clock = makeClock(score.tempos, settings.tempoFactor);
    const startSec = clock.toSec(fromBeat);
    const lengthSec = clock.toSec(toBeat) - startSec + 2;
    const rate = 44100;
    const ctx = new OfflineAudioContext(2, Math.ceil(lengthSec * rate), rate);
    const master = makeMaster(ctx);
    const insts = {};
    await Promise.all(
      settings.parts.map(async (ps, i) => {
        if (!include(i)) return;
        const gain = ctx.createGain();
        gain.gain.value = ps.volume;
        gain.connect(master);
        insts[i] = { inst: await loadInstrument(ctx, ps.instrument, gain) };
        if (hasHarmonics(score.parts[i])) insts[i].harm = await loadInstrument(ctx, HARMONIC_INSTRUMENT, gain);
      })
    );
    const notes = collectNotes(score, settings, clock, fromBeat, toBeat, include);
    for (const n of notes) {
      const slot = insts[n.part];
      const inst = n.h ? slot?.harm || slot?.inst : slot?.inst;
      inst?.play(n.midi, n.when - startSec + 0.05, { duration: n.dur, gain: n.gain });
    }
    const buffer = await ctx.startRendering();
    return encodeWav(buffer);
  }
}

function encodeWav(buffer) {
  const ch = buffer.numberOfChannels;
  const len = buffer.length;
  const data = new DataView(new ArrayBuffer(44 + len * ch * 2));
  const str = (o, s) => [...s].forEach((c, i) => data.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF");
  data.setUint32(4, 36 + len * ch * 2, true);
  str(8, "WAVE");
  str(12, "fmt ");
  data.setUint32(16, 16, true);
  data.setUint16(20, 1, true);
  data.setUint16(22, ch, true);
  data.setUint32(24, buffer.sampleRate, true);
  data.setUint32(28, buffer.sampleRate * ch * 2, true);
  data.setUint16(32, ch * 2, true);
  data.setUint16(34, 16, true);
  str(36, "data");
  data.setUint32(40, len * ch * 2, true);
  const chans = [...Array(ch)].map((_, c) => buffer.getChannelData(c));
  // 音色采样本身偏轻，统一放大 3 倍；放大后峰值超过 0.98 时再按比例压下来，防止削波
  let peak = 0;
  for (const c of chans) for (let i = 0; i < len; i++) peak = Math.max(peak, Math.abs(c[i]));
  const norm = peak * 3 > 0.98 ? 0.98 / peak : 3;
  let o = 44;
  for (let i = 0; i < len; i++) {
    for (let c = 0; c < ch; c++) {
      const v = Math.max(-1, Math.min(1, chans[c][i] * norm));
      data.setInt16(o, v < 0 ? v * 0x8000 : v * 0x7fff, true);
      o += 2;
    }
  }
  return new Blob([data], { type: "audio/wav" });
}
