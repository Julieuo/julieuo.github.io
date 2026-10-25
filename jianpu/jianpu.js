// 简谱文本解析：文本 -> 每个声部的音符事件（单位：拍，四分音符 = 1 拍）。
// 格式见 FORMAT.md。

const HEADER_KEYS = {
  标题: "title", title: "title",
  调号: "key", 调: "key", key: "key",
  拍号: "time", time: "time",
  速度: "tempo", tempo: "tempo",
  顺序: "order", 演奏顺序: "order", order: "order",
};

const DEGREE_SEMITONES = [0, 0, 2, 4, 5, 7, 9, 11]; // 下标 1..7
const LETTER_PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const TUPLET_FACTOR = { 2: 3 / 2, 3: 2 / 3, 4: 3 / 4, 5: 4 / 5, 6: 4 / 6, 7: 4 / 7 };

// 力度 -> 响度（mf = 0.75；播放时按 响度 / 0.75 作为音量倍数）
const DYNAMICS = { ppp: 0.3, pp: 0.4, p: 0.52, mp: 0.64, mf: 0.75, f: 0.88, ff: 1.0, fff: 1.1 };
export const DEFAULT_LEVEL = DYNAMICS.mf;
const HAIRPIN_STEP = 0.2; // 渐强/渐弱没写终点力度时，变化这么多
const ACCENT = 1.3; // 重音、sf
const FERMATA_STRETCH = 1.8; // 延长记号：这段时间放慢到 1/1.8
const ORN_NOTE_SEC = 0.075; // 颤音、波音、滑音里每个小音的时长（秒）
const KNOWN_TAGS = new Set(["tr", "w", "lw", "^", ">", "/", "\\", "o", "arp"]);
const ARP_NOTE_SEC = 0.04; // 琶音：和弦里相邻两个音之间隔多久（秒）

// "1=bB" / "1=♭B" / "Bb" / "#F" -> 音高类 0..11；无法识别时返回 null
export function keyToPc(str) {
  let s = String(str).replace(/^\s*1\s*[=＝]\s*/, "").trim();
  const m = s.match(/[A-G]/) || s.match(/[a-g]/);
  if (!m) return null;
  const letter = m[0].toUpperCase();
  const rest = s.slice(0, m.index) + s.slice(m.index + 1);
  let acc = 0;
  for (const ch of rest) {
    if (ch === "#" || ch === "♯") acc += 1;
    else if (ch === "b" || ch === "♭") acc -= 1;
  }
  return (((LETTER_PC[letter] + acc) % 12) + 12) % 12;
}

function parseTime(str) {
  const m = String(str).match(/(\d+)\s*\/\s*(\d+)/);
  return m ? { num: +m[1], den: +m[2] } : null;
}

// 后缀里的 ' , _ . ~
function parseSuffix(suffix) {
  let oct = 0, under = 0, dots = 0, tie = false;
  for (const ch of suffix) {
    if (ch === "'") oct++;
    else if (ch === ",") oct--;
    else if (ch === "_") under++;
    else if (ch === ".") dots++;
    else if (ch === "~") tie = true;
  }
  const dur = Math.pow(2, -under) * (2 - Math.pow(2, -dots));
  return { oct, dur, tie };
}

function noteMidi(acc, deg, oct, tonic) {
  return tonic + DEGREE_SEMITONES[deg] + acc + 12 * oct;
}

const TOKEN_RE = new RegExp(
  [
    "(?<comment>//.*$)",
    "(?<directive>@\\S+)",
    "(?<section>\\$[^\\s|]+)",
    "(?<bar>\\|\\||\\|:|:\\||\\|\\]|\\|)",
    "(?<grace>\\{[^}]*\\})",
    "(?<chord><[^>]*>(?:[',_.~]|![a-z^>/\\\\]+)*)",
    "(?<tupletStart>\\((?=\\d\\s))(?<tupletN>\\d)",
    "(?<tupletEnd>\\))",
    "(?<paren>\\()",
    "(?<note>[#b♯♭]?[0-7](?:[',_.~]|![a-z^>/\\\\]+)*)",
    "(?<dash>-)",
    "(?<tie>~)",
    "(?<space>\\s+)",
  ].join("|"),
  "y"
);

function tokenizeLine(line, lineNo, errors) {
  const tokens = [];
  let pos = 0;
  TOKEN_RE.lastIndex = 0;
  while (pos < line.length) {
    TOKEN_RE.lastIndex = pos;
    const m = TOKEN_RE.exec(line);
    if (!m) {
      errors.push({ line: lineNo, msg: `看不懂的字符 “${line[pos]}”` });
      pos++;
      continue;
    }
    pos = TOKEN_RE.lastIndex;
    const g = m.groups;
    if (g.space || g.comment) continue;
    const type = Object.keys(g).find((k) => g[k] !== undefined && k !== "tupletN");
    tokens.push({ type, text: m[0], n: g.tupletN ? +g.tupletN : undefined, line: lineNo, col: m.index, len: m[0].length });
  }
  return tokens;
}

// 把后缀里的 !tr !^ 这类标记拆出来
function splitTags(suffix, tok, errors) {
  const tags = [];
  const rest = suffix.replace(/!([a-z^>/\\\\]+)/g, (_, t) => {
    if (KNOWN_TAGS.has(t)) tags.push(t);
    else errors.push({ line: tok.line, msg: `看不懂的标记 “!${t}”` });
    return "";
  });
  return { rest, tags };
}

// "#4'" 这类不带时值的音 -> {acc, deg, oct}
function parsePitch(text) {
  const nm = text.match(/^([#b♯♭]?)([1-7])([',]*)$/);
  if (!nm) return null;
  const acc = nm[1] === "#" || nm[1] === "♯" ? 1 : nm[1] ? -1 : 0;
  return { acc, deg: +nm[2], oct: parseSuffix(nm[3]).oct };
}

// 一个音符/和弦 token -> {pitches: [{acc,deg,oct}], dur, tie, tags}；休止时 pitches 为空
function parseNoteToken(tok, errors) {
  if (tok.type === "note") {
    const m = tok.text.match(/^([#b♯♭]?)([0-7])(.*)$/);
    const acc = m[1] === "#" || m[1] === "♯" ? 1 : m[1] ? -1 : 0;
    const deg = +m[2];
    const { rest, tags } = splitTags(m[3], tok, errors);
    const s = parseSuffix(rest);
    return { pitches: deg === 0 ? [] : [{ acc, deg, oct: s.oct }], dur: s.dur, tie: s.tie, tags };
  }
  // 和弦 <...>后缀
  const m = tok.text.match(/^<([^>]*)>(.*)$/);
  const { rest, tags } = splitTags(m[2], tok, errors);
  const s = parseSuffix(rest);
  const pitches = [];
  for (const part of m[1].trim().split(/\s+/).filter(Boolean)) {
    const p = parsePitch(part);
    if (p) pitches.push(p);
    else errors.push({ line: tok.line, msg: `和弦里看不懂 “${part}”` });
  }
  return { pitches, dur: s.dur, tie: s.tie, tags };
}

function parseGrace(tok, errors) {
  const pitches = [];
  for (const part of tok.text.slice(1, -1).trim().split(/\s+/).filter(Boolean)) {
    const p = parsePitch(part);
    if (p) pitches.push(p);
    else errors.push({ line: tok.line, msg: `倚音里看不懂 “${part}”` });
  }
  return pitches;
}

// 展开 |: ... :|（各演奏两遍）
function expandRepeats(tokens) {
  const out = [];
  let repeatStart = 0;
  for (const tok of tokens) {
    if (tok.type === "bar" && tok.text === "|:") {
      repeatStart = out.length;
      out.push({ ...tok, text: "|" });
    } else if (tok.type === "bar" && tok.text === ":|") {
      out.push({ ...tok, text: "|" });
      const body = out.slice(repeatStart);
      out.push(...body);
      repeatStart = out.length;
    } else {
      out.push(tok);
    }
  }
  return out;
}

export function parseScore(text) {
  const errors = [];
  const warnings = [];
  const meta = { title: "", key: "1=C", time: "4/4", tempo: 90, order: [] };
  const parts = [];
  let current = null;

  const lines = String(text).split(/\r?\n/);
  lines.forEach((raw, i) => {
    const lineNo = i + 1;
    const line = raw.trim();
    if (!line) return;
    const partMatch = line.match(/^\[(.+?)\]\s*$/);
    if (partMatch) {
      current = { name: partMatch[1].trim(), tokens: [] };
      parts.push(current);
      return;
    }
    if (!current) {
      const hm = line.match(/^([^\s:：]+)\s*[:：]\s*(.*)$/);
      if (hm && HEADER_KEYS[hm[1]]) {
        const k = HEADER_KEYS[hm[1]];
        const v = hm[2].trim();
        if (k === "tempo") meta.tempo = parseFloat(v) || meta.tempo;
        else if (k === "order") meta.order = v.split(/[\s,，、]+/).filter(Boolean);
        else meta[k] = v;
        return;
      }
      if (line.startsWith("//")) return;
      current = { name: "旋律", tokens: [] };
      parts.push(current);
    }
    current.tokens.push(...tokenizeLine(raw, lineNo, errors));
  });

  const tonic0 = keyToPc(meta.key);
  if (tonic0 === null) errors.push({ line: 0, msg: `调号 “${meta.key}” 看不懂，按 1=C 处理` });
  const time0 = parseTime(meta.time) || { num: 4, den: 4 };

  // 按书写顺序给每个音符标上当时的调，并把 token 按段落分组
  const sectionOrderSeen = [];
  for (const part of parts) {
    let tonic = 60 + (tonic0 ?? 0);
    part.sections = new Map();
    let sec = "";
    part.sections.set(sec, []);
    for (const tok of part.tokens) {
      if (tok.type === "section") {
        sec = tok.text.slice(1).replace(/[:：]$/, "");
        if (!part.sections.has(sec)) part.sections.set(sec, []);
        if (!sectionOrderSeen.includes(sec)) sectionOrderSeen.push(sec);
        continue;
      }
      if (tok.type === "directive") {
        const d = tok.text.slice(1);
        if (/^1\s*=/.test(d)) {
          const pc = keyToPc(d);
          if (pc === null) errors.push({ line: tok.line, msg: `调号 “${d}” 看不懂` });
          else {
            tonic = 60 + pc;
            part.sections.get(sec).push({ ...tok, keyChange: true }); // 留在 token 流里，谱面上才画得出 “1=G”
          }
          continue;
        }
        if (/^q\s*=/i.test(d)) {
          const bpm = parseFloat(d.replace(/^q\s*=/i, ""));
          if (!(bpm > 0)) errors.push({ line: tok.line, msg: `速度 “${d}” 看不懂` });
          else part.sections.get(sec).push({ ...tok, bpm });
          continue;
        }
        if (parseTime(d)) {
          part.sections.get(sec).push({ ...tok, time: parseTime(d) });
          continue;
        }
        if (DYNAMICS[d] !== undefined) {
          part.sections.get(sec).push({ ...tok, dyn: DYNAMICS[d] });
          continue;
        }
        if (d === "sf" || d === "sfz" || d === "fz") {
          part.sections.get(sec).push({ ...tok, accent: true });
          continue;
        }
        if (d === "fp") {
          part.sections.get(sec).push({ ...tok, accent: true, dyn: DYNAMICS.p, dynAfterNote: true });
          continue;
        }
        if (d === "<" || d === ">" || d === "!") {
          part.sections.get(sec).push({ ...tok, hairpin: d });
          continue;
        }
        errors.push({ line: tok.line, msg: `看不懂的指令 “${tok.text}”` });
        continue;
      }
      part.sections.get(sec).push({ ...tok, tonic });
    }
  }

  // 演奏顺序
  let order = meta.order.length ? meta.order.slice() : sectionOrderSeen.slice();
  const hasPrelude = parts.some((p) => p.sections.get("").some((t) => t.type !== "bar"));
  if (hasPrelude) order.unshift("");
  for (const s of order) {
    if (s && !sectionOrderSeen.includes(s)) errors.push({ line: 0, msg: `顺序里的段落 “${s}” 在谱里没找到` });
  }
  if (!order.length) order = [""];

  // 逐段计算事件；每段长度取各声部最长，短的声部用休止补齐
  const out = parts.map((p) => ({
    name: p.name, events: [], bars: [], barSpans: [], noteCount: 0,
    dyn: { level: DEFAULT_LEVEL, hairpin: 0, points: [{ beat: 0, level: DEFAULT_LEVEL, ramp: false }] },
  }));
  const fermatas = [];
  const tempos = [{ beat: 0, bpm: meta.tempo }];
  const timeSigs = [{ beat: 0, ...time0 }];
  const sectionMarks = [];
  let offset = 0;

  for (const secName of order) {
    let secLen = 0;
    parts.forEach((p, pi) => {
      const toks = expandRepeats(p.sections.get(secName) || []);
      const ctx = { tempos, timeSigs, fermatas, recordMeta: pi === 0, errors, warnings, time: p.time || time0 };
      const len = evalTokens(toks, offset, out[pi], ctx);
      out[pi].written = (out[pi].written || 0) + len;
      p.time = ctx.time;
      secLen = Math.max(secLen, len);
    });
    if (secName) sectionMarks.push({ beat: offset, name: secName });
    offset += secLen;
  }

  // 小节起点：取小节线最多的声部
  let bars = [0];
  for (const p of out) {
    const b = [0, ...p.bars.filter((x) => x > 0 && x < offset)];
    if (b.length > bars.length) bars = b;
  }
  bars = [...new Set(bars.map((b) => Math.round(b * 1e6) / 1e6))].sort((a, b) => a - b);
  for (const p of out) {
    p.length = p.events.reduce((m, e) => Math.max(m, e.t + e.d), 0);
    delete p.bars;
  }

  const mismatchedBars = checkPartsAligned(out, errors, dedupeByBeat(timeSigs));

  tempos.sort((a, b) => a.beat - b.beat);
  const finalTempos = applyFermatas(dedupeByBeat(tempos), fermatas);
  const clock = makeClock(finalTempos);
  for (const p of out) {
    applyDynamics(p, offset);
    p.events = expandOrnaments(p.events, clock);
    delete p.dyn;
  }

  return {
    meta: { ...meta, tonicPc: tonic0 ?? 0, order },
    parts: out,
    length: offset,
    bars,
    tempos: finalTempos,
    baseTempos: dedupeByBeat(tempos),
    timeSigs: dedupeByBeat(timeSigs),
    sectionMarks,
    errors,
    warnings,
    mismatchedBars,
  };
}

// 同一小节各声部的拍数必须相等，否则后面的音全都会错开。
// 按起点时间对齐来比：只在各声部这一小节起点相同、长度不同的地方报，
// 不会因为前面一处错位就把后面每一小节都连带标出来。返回 [{bar, parts, text}]
function checkPartsAligned(parts, errors, timeSigs) {
  if (parts.length < 2) return [];
  const bars = parts.map((p) => p.barSpans.filter((x) => x.end - x.start > 1e-6));
  let ref = 0;
  bars.forEach((b, i) => { if (b.length > bars[ref].length) ref = i; });
  const fmt = (x) => String(+x.toFixed(3));
  const out = [];
  bars[ref].forEach((rb, k) => {
    const spans = bars.map((b) => b.find((x) => Math.abs(x.start - rb.start) < 1e-6) || null);
    const idx = spans.map((sp, i) => (sp ? i : -1)).filter((i) => i >= 0);
    if (idx.length < 2) return;
    const lens = spans.map((sp) => (sp ? sp.end - sp.start : null));
    const vals = idx.map((i) => lens[i]);
    if (Math.max(...vals) - Math.min(...vals) < 1e-6) return;
    // 先看谁和拍号不符；都不符（比如散板）就看谁和大多数声部不一样
    let ts = timeSigs[0];
    for (const t of timeSigs) if (t.beat <= rb.start + 1e-6) ts = t;
    const expect = (ts.num * 4) / ts.den;
    let odd = idx.filter((i) => Math.abs(lens[i] - expect) > 1e-6);
    if (!odd.length || odd.length === idx.length) {
      const counts = new Map();
      for (const i of idx) counts.set(fmt(lens[i]), (counts.get(fmt(lens[i])) || 0) + 1);
      const common = [...counts].sort((a, b) => b[1] - a[1])[0][0];
      odd = idx.filter((i) => fmt(lens[i]) !== common);
    }
    const rest = idx.filter((i) => !odd.includes(i));
    const text = `${odd.map((i) => `${parts[i].name} ${fmt(lens[i])} 拍`).join("，")}${rest.length ? `，其他 ${fmt(lens[rest[0]])} 拍` : ""}`;
    errors.push({
      line: spans[odd[0]].toks[0]?.line ?? 0,
      msg: `第 ${k + 1} 小节各声部拍数不同（${idx.map((i) => `${parts[i].name} ${fmt(lens[i])} 拍`).join("，")}），从这里起各声部会错开；也可能是多写或漏写了一条小节线`,
    });
    out.push({ bar: k + 1, parts: odd.map((i) => parts[i].name), text });
  });
  const counts = bars.map((b) => b.length);
  if (new Set(counts).size > 1) {
    errors.push({ line: 0, msg: `各声部的小节数不一样：${parts.map((p, i) => `${p.name} ${counts[i]} 小节`).join("，")}` });
  }
  return out;
}

function dedupeByBeat(list) {
  const m = new Map();
  for (const x of list) m.set(Math.round(x.beat * 1e6), x);
  return [...m.values()].sort((a, b) => a.beat - b.beat);
}

// 计算一个声部一个段落的事件，返回该段长度（拍）
function evalTokens(tokens, offset, part, ctx) {
  const { tempos, timeSigs, recordMeta, errors, warnings } = ctx;
  let cursor = 0;
  let barStart = 0;
  let barIdx = 0;
  let barToks = []; // 这一小节里写的 token，用来按小节显示谱子和在谱面上编辑
  // close：结束这一小节的小节线在文本里的位置（最后一小节没有小节线时为 null），谱面编辑往空小节里插音时用
  const flushBar = (barTok = null) => {
    if (cursor - barStart > 1e-6 || barToks.length) {
      part.barSpans.push({
        start: offset + barStart, end: offset + cursor, toks: barToks,
        close: barTok ? { line: barTok.line, col: barTok.col, text: barTok.text } : null,
      });
    }
    barToks = [];
  };
  let last = null; // 上一个音符事件（休止时为 null）
  let pendingTie = false;
  let scale = 1;
  const tupletStack = [];
  let graces = null; // 等着贴到下一个音前面的倚音
  let graceTok = null;
  let fermata = null; // 最近一个延长记号，后面的 - 会把它延长
  const dyn = part.dyn;
  const setLevel = (level, ramp) => {
    dyn.points.push({ beat: offset + cursor, level, ramp });
    dyn.level = level;
  };

  for (const tok of tokens) {
    if (tok.type !== "bar" && tok.col !== undefined) barToks.push({ line: tok.line, col: tok.col, text: tok.text });
    switch (tok.type) {
      case "bar": {
        const len = cursor - barStart;
        const expect = (ctx.time.num * 4) / ctx.time.den;
        if (barIdx > 0 && len > 1e-6 && Math.abs(len - expect) > 1e-6) {
          warnings.push({ line: tok.line, msg: `${part.name}：这一小节是 ${+len.toFixed(3)} 拍，拍号应为 ${+expect.toFixed(3)} 拍` });
        }
        if (len > 1e-6) {
          part.bars.push(offset + cursor);
          barIdx++;
        }
        flushBar(tok);
        barStart = cursor;
        break;
      }
      case "directive":
        if (tok.hairpin) {
          if (dyn.hairpin) {
            // 上一个渐强/渐弱还没结束，先按默认幅度收尾
            setLevel(clampLevel(dyn.level + dyn.hairpin * HAIRPIN_STEP), true);
            dyn.hairpin = 0;
          }
          if (tok.hairpin !== "!") {
            setLevel(dyn.level, false);
            dyn.hairpin = tok.hairpin === "<" ? 1 : -1;
          }
        }
        if (tok.accent) part.pendingAccent = true;
        if (tok.dyn !== undefined) {
          if (tok.dynAfterNote) part.pendingLevel = tok.dyn;
          else {
            setLevel(tok.dyn, !!dyn.hairpin);
            dyn.hairpin = 0;
          }
        }
        if (tok.time) ctx.time = tok.time;
        if (tok.bpm) tempos.push({ beat: offset + cursor, bpm: tok.bpm });
        if (tok.time && recordMeta) timeSigs.push({ beat: offset + cursor, ...tok.time });
        break;
      case "tupletStart":
        tupletStack.push(scale);
        scale *= TUPLET_FACTOR[tok.n] ?? 1;
        if (!TUPLET_FACTOR[tok.n]) errors.push({ line: tok.line, msg: `不支持 ${tok.n} 连音` });
        break;
      case "tupletEnd":
        if (tupletStack.length) scale = tupletStack.pop();
        else warnings.push({ line: tok.line, msg: "这里的 “)” 不是连音的结尾，已忽略" });
        break;
      case "paren":
        warnings.push({ line: tok.line, msg: "这里的 “(” 不是连音记号，已忽略（连音要写成 “(3 ” 这样，括号、数字、空格）" });
        break;
      case "dash":
        if (last) last.d += scale;
        if (fermata && Math.abs(fermata.end - (offset + cursor)) < 1e-6) fermata.end += scale;
        cursor += scale;
        break;
      case "grace":
        graces = parseGrace(tok, errors);
        graceTok = tok;
        break;
      case "tie":
        pendingTie = true;
        break;
      case "note":
      case "chord": {
        const n = parseNoteToken(tok, errors);
        const dur = n.dur * scale;
        const midis = n.pitches.map((p) => noteMidi(p.acc, p.deg, p.oct, tok.tonic));
        if (n.tags.includes("^")) {
          fermata = { start: offset + cursor, end: offset + cursor + dur };
          ctx.fermatas.push(fermata);
        } else fermata = null;
        if (!midis.length) {
          last = null;
          pendingTie = false;
          graces = null;
        } else if (
          pendingTie && last &&
          Math.abs(last.t + last.d - (offset + cursor)) < 1e-6 &&
          last.m.length === midis.length && last.m.every((x, i) => x === midis[i])
        ) {
          last.d += dur;
        } else {
          let accent = n.tags.includes(">") ? ACCENT : 1;
          if (part.pendingAccent) {
            accent = ACCENT;
            part.pendingAccent = false;
          }
          if (graces?.length) {
            // 倚音从主音的时值里借时间，每个最多 1/8 拍
            const g = Math.min(0.125, (dur * 0.4) / graces.length);
            graces.forEach((p, k) => {
              part.events.push({ t: offset + cursor + k * g, d: g, m: [noteMidi(p.acc, p.deg, p.oct, tok.tonic)], accent: 0.85, line: graceTok.line, col: graceTok.col, len: graceTok.len });
            });
          }
          const lead = graces?.length ? Math.min(0.125, (dur * 0.4) / graces.length) * graces.length : 0;
          last = {
            t: offset + cursor + lead, d: dur - lead, m: midis, line: tok.line, col: tok.col, len: tok.len, accent,
            orn: n.tags.filter((t) => t !== "^" && t !== ">"),
            tonic: tok.tonic, p0: n.pitches[0],
          };
          part.events.push(last);
          part.noteCount += midis.length + (graces?.length || 0);
          graces = null;
          if (part.pendingLevel !== undefined) {
            cursor += dur;
            setLevel(part.pendingLevel, false);
            cursor -= dur;
            part.pendingLevel = undefined;
          }
        }
        pendingTie = n.tie && midis.length > 0;
        cursor += dur;
        break;
      }
    }
  }
  flushBar();
  if (tupletStack.length) errors.push({ line: tokens.at(-1)?.line ?? 0, msg: "连音少了 “)”" });
  return cursor;
}

function clampLevel(v) {
  return Math.max(0.2, Math.min(1.2, v));
}

// 按力度点给每个音算响度；渐强/渐弱在两个点之间线性变化
function applyDynamics(part, endBeat) {
  const dyn = part.dyn;
  if (dyn.hairpin) dyn.points.push({ beat: endBeat, level: clampLevel(dyn.level + dyn.hairpin * HAIRPIN_STEP), ramp: true });
  const pts = dyn.points.slice().sort((a, b) => a.beat - b.beat);
  const levelAt = (t) => {
    let i = 0;
    while (i + 1 < pts.length && pts[i + 1].beat <= t + 1e-9) i++;
    const a = pts[i], b = pts[i + 1];
    if (b && b.ramp && b.beat > a.beat) return a.level + ((b.level - a.level) * (t - a.beat)) / (b.beat - a.beat);
    return a.level;
  };
  for (const e of part.events) {
    e.v = levelAt(e.t) * (e.accent ?? 1);
    delete e.accent;
  }
}

// 延长记号：在它覆盖的那段时间里把速度放慢（各声部的拍子仍然对齐）
function applyFermatas(tempos, fermatas) {
  if (!fermatas.length) return tempos;
  const spans = [];
  for (const f of fermatas.sort((a, b) => a.start - b.start)) {
    const lastSpan = spans.at(-1);
    if (lastSpan && f.start <= lastSpan.end + 1e-9) lastSpan.end = Math.max(lastSpan.end, f.end);
    else spans.push({ ...f });
  }
  const bpmAt = (beat) => {
    let b = tempos[0].bpm;
    for (const t of tempos) if (t.beat <= beat + 1e-9) b = t.bpm;
    return b;
  };
  const inSpan = (beat) => spans.some((s) => s.start <= beat + 1e-9 && beat < s.end - 1e-9);
  const beats = new Set(tempos.map((t) => t.beat));
  for (const s of spans) beats.add(s.start).add(s.end);
  return dedupeByBeat([...beats].map((beat) => ({ beat, bpm: bpmAt(beat) / (inSpan(beat) ? FERMATA_STRETCH : 1) })));
}

// 调内相邻的音（step = +1 上方，-1 下方）
function neighborMidi(p, tonic, step) {
  let deg = p.deg + step, oct = p.oct;
  if (deg > 7) { deg = 1; oct++; }
  if (deg < 1) { deg = 7; oct--; }
  return noteMidi(0, deg, oct, tonic);
}

// 把颤音、波音、滑音展开成一串短音；泛音标上 h
function expandOrnaments(events, clock) {
  const out = [];
  for (const e of events) {
    const orn = e.orn || [];
    const tonic = e.tonic, p0 = e.p0;
    delete e.orn; delete e.tonic; delete e.p0;
    if (orn.includes("o")) {
      e.h = true;
      e.v *= 0.8;
    }
    if (orn.includes("arp") && e.m.length > 1) {
      // 琶音：和弦从低到高依次奏出，最后一起延续到原来的结尾
      const u = ARP_NOTE_SEC / Math.max(1e-3, clock.toSec(e.t + 1) - clock.toSec(e.t));
      const step = Math.min(u, e.d / (e.m.length + 1));
      e.m.slice().sort((a, b) => a - b).forEach((m, i) => out.push({ ...e, t: e.t + i * step, d: e.d - i * step, m: [m] }));
      continue;
    }
    if (!orn.length || !p0) {
      out.push(e);
      continue;
    }
    // ORN_NOTE_SEC 秒对应多少拍（在这个音的位置）
    const unit = ORN_NOTE_SEC / Math.max(1e-3, clock.toSec(e.t + 1) - clock.toSec(e.t));
    const main = e.m[0];
    const rest = e.m.slice(1);
    let t = e.t;
    const end = e.t + e.d;
    const push = (m, d, v = e.v) => out.push({ ...e, t, d, m: [m], v });
    if (rest.length) out.push({ ...e, m: rest }); // 和弦里其余的音照常保持

    if (orn.includes("/") && e.d > unit * 3) {
      push(main - 2, unit, e.v * 0.7); t += unit;
      push(main - 1, unit, e.v * 0.8); t += unit;
    }
    if (orn.includes("tr") && end - t > unit * 2) {
      const up = neighborMidi(p0, tonic, 1);
      let k = 0;
      while (end - t > unit * 1.5) {
        push(k % 2 ? up : main, unit);
        t += unit;
        k++;
      }
      push(main, end - t);
      continue;
    }
    if ((orn.includes("w") || orn.includes("lw")) && end - t > unit * 3) {
      const nb = neighborMidi(p0, tonic, orn.includes("w") ? 1 : -1);
      push(main, unit); t += unit;
      push(nb, unit); t += unit;
    }
    if (orn.includes("\\") && end - t > unit * 5) {
      const tail = Math.min(unit * 3, (end - t) * 0.35);
      push(main, end - t - tail); t = end - tail;
      for (let k = 1; k <= 3; k++) {
        push(main - k, tail / 3, e.v * (1 - 0.15 * k));
        t += tail / 3;
      }
      continue;
    }
    push(main, end - t);
  }
  return out;
}

// 拍 -> 秒（考虑速度变化与整体速度倍率）
export function makeClock(tempos, factor = 1) {
  const segs = [];
  let sec = 0;
  for (let i = 0; i < tempos.length; i++) {
    const start = tempos[i].beat;
    const spb = 60 / (tempos[i].bpm * factor);
    segs.push({ beat: start, sec, spb });
    const next = tempos[i + 1];
    if (next) sec += (next.beat - start) * spb;
  }
  const toSec = (beat) => {
    let s = segs[0];
    for (const x of segs) if (x.beat <= beat + 1e-9) s = x;
    return s.sec + (beat - s.beat) * s.spb;
  };
  const toBeat = (secs) => {
    let s = segs[0];
    for (const x of segs) if (x.sec <= secs + 1e-9) s = x;
    return s.beat + (secs - s.sec) / s.spb;
  };
  return { toSec, toBeat };
}
