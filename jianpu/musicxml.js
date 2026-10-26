// 简谱 -> MusicXML（五线谱）。从 parseScore 的结果出发，按谱面上显示的小节（反复已展开）逐声部转换。
// 支持：音高（按当时的调写成五线谱音名）、时值、附点、增时线、延音线、和弦、连音、倚音、休止、
// 力度与渐强渐弱、换调、换拍号、换速度、颤音、波音、延长记号、重音、泛音、琶音。滑音不写。

import { keyToPc } from "./jianpu.js";

const LETTERS = ["C", "D", "E", "F", "G", "A", "B"];
const NAT = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const DEG = [0, 0, 2, 4, 5, 7, 9, 11];
const DIV = 480; // 每个四分音符的刻度数，能整除 2、3、4、5、6、8
const FIFTHS_SHARP = { 0: 0, 7: 1, 2: 2, 9: 3, 4: 4, 11: 5, 6: 6, 1: 7 };
const FIFTHS_FLAT = { 0: 0, 5: -1, 10: -2, 3: -3, 8: -4, 1: -5, 6: -6, 11: -7 };
const SHARPS = ["F", "C", "G", "D", "A", "E", "B"];
const FLATS = ["B", "E", "A", "D", "G", "C", "F"];
const TUPLET = { 2: [2, 3], 3: [3, 2], 4: [4, 3], 5: [5, 4], 6: [6, 4], 7: [7, 4] }; // 实际 / 正常
const DYNAMICS = new Set(["ppp", "pp", "p", "mp", "mf", "f", "ff", "fff", "sf", "sfz", "fz", "fp"]);
// 拍数 -> 音符类型，按“用的音符最少”排序
const TYPES = [
  [8, "breve", 0], [6, "whole", 1], [4, "whole", 0], [3, "half", 1], [3.5, "half", 2], [2, "half", 0],
  [1.5, "quarter", 1], [1.75, "quarter", 2], [1, "quarter", 0], [0.75, "eighth", 1], [0.5, "eighth", 0],
  [0.375, "16th", 1], [0.25, "16th", 0], [0.125, "32nd", 0], [0.0625, "64th", 0],
];
const EPS = 1e-6;

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// "1=D" / "1=bB" -> {letter, fifths, tonicMidi}
function keyInfo(str) {
  const s = String(str).replace(/^\s*1\s*[=＝]\s*/, "").trim();
  const m = s.match(/[A-Ga-g]/);
  const letter = m ? m[0].toUpperCase() : "C";
  const rest = m ? s.slice(0, m.index) + s.slice(m.index + 1) : "";
  const flats = /[b♭]/.test(rest);
  const pc = keyToPc(str) ?? 0;
  const fifths = flats ? FIFTHS_FLAT[pc] ?? FIFTHS_SHARP[pc] ?? 0 : FIFTHS_SHARP[pc] ?? FIFTHS_FLAT[pc] ?? 0;
  return { letter, fifths, tonicMidi: 60 + pc };
}

function keyAlter(fifths, step) {
  if (fifths > 0 && SHARPS.slice(0, fifths).includes(step)) return 1;
  if (fifths < 0 && FLATS.slice(0, -fifths).includes(step)) return -1;
  return 0;
}

// 简谱音 -> 五线谱音名：按调的音阶字母顺序推字母，再用升降号凑到正确的音高
function spell(p, key) {
  const midi = key.tonicMidi + DEG[p.deg] + p.acc + 12 * p.oct;
  const step = LETTERS[(LETTERS.indexOf(key.letter) + p.deg - 1) % 7];
  let octave = Math.floor(midi / 12) - 1;
  let alter = midi - ((octave + 1) * 12 + NAT[step]);
  if (alter > 6) { octave++; alter -= 12; } else if (alter < -6) { octave--; alter += 12; }
  return { step, alter, octave };
}

function parseSuffix(suffix) {
  const tags = [];
  const rest = suffix.replace(/!([a-z^>/\\]+)/g, (_, t) => { tags.push(t); return ""; });
  let oct = 0, under = 0, dots = 0, tie = false;
  for (const ch of rest) {
    if (ch === "'") oct++;
    else if (ch === ",") oct--;
    else if (ch === "_") under++;
    else if (ch === ".") dots++;
    else if (ch === "~") tie = true;
  }
  return { oct, dur: Math.pow(2, -under) * (2 - Math.pow(2, -dots)), tie, tags };
}

function parsePitch(text) {
  const m = text.match(/^([#b♯♭]?)([1-7])([',]*)$/);
  if (!m) return null;
  return { acc: m[1] === "#" || m[1] === "♯" ? 1 : m[1] ? -1 : 0, deg: +m[2], oct: parseSuffix(m[3]).oct };
}

// 每个声部：第 k 小节里的 token 文本（和网页 buildBarCells 一样的分法）
function cellsOf(score) {
  const bars = score.bars;
  const barAt = (beat) => {
    let k = 0;
    while (k + 1 < bars.length && bars[k + 1] <= beat + 1e-9) k++;
    return k + 1;
  };
  return score.parts.map((part) => {
    const cells = Array.from({ length: bars.length }, () => []);
    let pending = [];
    for (const span of part.barSpans) {
      if (span.end - span.start <= EPS) { pending.push(...span.toks); continue; }
      cells[barAt(span.start + EPS) - 1].push(...pending, ...span.toks);
      pending = [];
    }
    if (pending.length) cells[cells.length - 1].push(...pending);
    return cells.map((c) => c.map((t) => t.text));
  });
}

// 第一遍：token -> 音项 {rest, pitches, beats, written, tuplet, grace, tags, tieStart, dirs}
function itemsOf(measures) {
  const out = [];
  let last = null; // 上一个音项（跨小节），增时线延长它
  for (const toks of measures) {
    const items = [];
    let dirs = [];
    let grace = null;
    let scale = 1;
    const stack = [];
    let tupletN = null, tupletFirst = false;
    let pendingTie = false;
    for (const t of toks) {
      if (t === "-") {
        if (last && (items.includes(last) || !items.length)) {
          if (items.includes(last)) last.beats += scale;
          else {
            // 小节开头的增时线：上一小节的音延续过来，用延音线连
            last.tieStart = true;
            const cont = { rest: last.rest, pitches: last.pitches, beats: scale, written: scale, tags: [], dirs, tieStop: true };
            dirs = [];
            items.push(cont);
            last = cont;
          }
        } else {
          const r = { rest: true, pitches: [], beats: scale, written: scale, tags: [], dirs };
          dirs = [];
          items.push(r);
          last = r;
        }
        continue;
      }
      if (t === "~") { pendingTie = true; continue; }
      if (/^\(\d$/.test(t)) { stack.push(scale); scale *= (TUPLET[t[1]] ? TUPLET[t[1]][1] / TUPLET[t[1]][0] : 1); tupletN = TUPLET[t[1]] ? +t[1] : null; tupletFirst = true; continue; }
      if (t === ")") { scale = stack.pop() ?? 1; if (last && last.tuplet) last.tuplet.stop = true; tupletN = null; continue; }
      if (t.startsWith("{")) { grace = t.slice(1, -1).trim().split(/\s+/).map(parsePitch).filter(Boolean); continue; }
      if (t.startsWith("@")) { dirs.push(t.slice(1)); continue; }
      let pitches, s;
      if (t.startsWith("<")) {
        const m = t.match(/^<([^>]*)>(.*)$/);
        if (!m) continue;
        s = parseSuffix(m[2]);
        pitches = m[1].trim().split(/\s+/).map(parsePitch).filter(Boolean);
      } else {
        const m = t.match(/^([#b♯♭]?)([0-7])(.*)$/);
        if (!m) continue;
        s = parseSuffix(m[3]);
        const deg = +m[2];
        pitches = deg === 0 ? [] : [{ acc: m[1] === "#" || m[1] === "♯" ? 1 : m[1] ? -1 : 0, deg, oct: s.oct }];
      }
      const item = {
        rest: !pitches.length, pitches, beats: s.dur * scale, written: s.dur, tags: s.tags, dirs, grace,
        tuplet: tupletN ? { n: tupletN, start: tupletFirst } : null,
        tieStop: pendingTie && last && !last.rest && !item_isRest(pitches),
        tieStart: s.tie,
      };
      if (item.tieStop && last) last.tieStart = true;
      dirs = [];
      grace = null;
      tupletFirst = false;
      pendingTie = false;
      items.push(item);
      last = item;
    }
    if (dirs.length) items.push({ dirsOnly: true, dirs });
    out.push(items);
  }
  return out;
}
const item_isRest = (pitches) => !pitches.length;

// 把一段时值拆成能写出来的音符（最多几个，用延音线连）
function chunks(beats) {
  const out = [];
  let b = beats;
  for (let guard = 0; b > EPS && guard < 16; guard++) {
    const t = TYPES.find(([v]) => v <= b + EPS);
    if (!t) break;
    out.push(t);
    b -= t[0];
  }
  return out.length ? out : [[beats, "quarter", 0]];
}

function typeOf(beats) {
  let best = TYPES[0];
  for (const t of TYPES) if (Math.abs(t[0] - beats) < Math.abs(best[0] - beats)) best = t;
  return best;
}

function directionXml(d, st, firstPart) {
  const x = [];
  const dyn = d.match(/^(ppp|pp|p|mp|mf|f|ff|fff|sf|sfz|fz|fp)$/);
  if (dyn) {
    if (st.wedge) { x.push(`<direction placement="below"><direction-type><wedge type="stop"/></direction-type></direction>`); st.wedge = null; }
    x.push(`<direction placement="below"><direction-type><dynamics><${dyn[1]}/></dynamics></direction-type></direction>`);
  } else if (d === "<" || d === ">") {
    if (st.wedge) x.push(`<direction placement="below"><direction-type><wedge type="stop"/></direction-type></direction>`);
    st.wedge = d;
    x.push(`<direction placement="below"><direction-type><wedge type="${d === "<" ? "crescendo" : "diminuendo"}"/></direction-type></direction>`);
  } else if (d === "!") {
    if (st.wedge) { x.push(`<direction placement="below"><direction-type><wedge type="stop"/></direction-type></direction>`); st.wedge = null; }
  } else if (/^q\s*=/i.test(d)) {
    const bpm = parseFloat(d.replace(/^q\s*=/i, ""));
    if (bpm > 0 && firstPart) x.push(`<direction placement="above"><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>${bpm}</per-minute></metronome></direction-type><sound tempo="${bpm}"/></direction>`);
  } else if (/^1\s*=/.test(d)) {
    // 和现在一样的调号、拍号不再重复画（谱子里常常每页开头都写一遍）
    const k = keyInfo(d);
    if (k.fifths !== st.key.fifths) x.push(`<attributes><key><fifths>${k.fifths}</fifths></key></attributes>`);
    st.key = k;
  } else if (/^\d+\s*\/\s*\d+$/.test(d)) {
    const time = d.replace(/\s+/g, "");
    if (time !== st.time) {
      const [n, den] = time.split("/").map((v) => parseInt(v));
      x.push(`<attributes><time><beats>${n}</beats><beat-type>${den}</beat-type></time></attributes>`);
      st.time = time;
    }
  }
  return x.join("");
}

function noteXml(item, key, part) {
  const x = [];
  const emitGrace = () => {
    for (const g of item.grace || []) {
      const p = spell(g, key);
      x.push(`<note><grace slash="yes"/><pitch><step>${p.step}</step>${p.alter ? `<alter>${p.alter}</alter>` : ""}<octave>${p.octave}</octave></pitch><voice>1</voice><type>16th</type>${accidental(p, key)}</note>`);
    }
  };
  const accidental = (p, k) => {
    if (p.alter === keyAlter(k.fifths, p.step)) return "";
    return `<accidental>${p.alter === 1 ? "sharp" : p.alter === -1 ? "flat" : p.alter === 2 ? "double-sharp" : p.alter === -2 ? "flat-flat" : "natural"}</accidental>`;
  };
  const notations = (first, lastChunk, chunkTieStart, chunkTieStop) => {
    const n = [];
    if (chunkTieStop) n.push(`<tied type="stop"/>`);
    if (chunkTieStart) n.push(`<tied type="start"/>`);
    if (first && item.tuplet?.start) n.push(`<tuplet type="start" bracket="yes"/>`);
    if (lastChunk && item.tuplet?.stop) n.push(`<tuplet type="stop"/>`);
    if (first) {
      const orn = [];
      if (item.tags.includes("tr")) orn.push("<trill-mark/>");
      if (item.tags.includes("w")) orn.push("<inverted-mordent/>");
      if (item.tags.includes("lw")) orn.push("<mordent/>");
      if (orn.length) n.push(`<ornaments>${orn.join("")}</ornaments>`);
      if (item.tags.includes(">")) n.push(`<articulations><accent/></articulations>`);
      if (item.tags.includes("o")) n.push(`<technical><harmonic><natural/></harmonic></technical>`);
      if (item.tags.includes("arp")) n.push(`<arpeggiate/>`);
    }
    if (lastChunk && item.tags.includes("^")) n.push(`<fermata/>`);
    return n.length ? `<notations>${n.join("")}</notations>` : "";
  };
  const tm = item.tuplet ? `<time-modification><actual-notes>${TUPLET[item.tuplet.n][0]}</actual-notes><normal-notes>${TUPLET[item.tuplet.n][1]}</normal-notes></time-modification>` : "";
  // 连音里的音不拆，按写出来的时值定类型；其余按能画出来的音符拆开，用延音线连
  const parts = item.tuplet ? [[item.beats, ...typeOf(item.written).slice(1)]] : chunks(item.beats);
  emitGrace();
  parts.forEach(([beats, type, dots], ci) => {
    const first = ci === 0, lastChunk = ci === parts.length - 1;
    const dur = Math.max(1, Math.round(beats * DIV));
    const tieStop = (first && item.tieStop) || !first;
    const tieStart = (lastChunk && item.tieStart) || !lastChunk;
    const dotXml = "<dot/>".repeat(dots);
    if (item.rest) {
      x.push(`<note><rest/><duration>${dur}</duration><voice>1</voice><type>${type}</type>${dotXml}${tm}${notations(first, lastChunk, false, false)}</note>`);
      return;
    }
    const ps = item.pitches.map((p) => spell(p, key)).sort((a, b) => (a.octave * 12 + NAT[a.step] + a.alter) - (b.octave * 12 + NAT[b.step] + b.alter));
    ps.forEach((p, pi) => {
      const tieXml = (tieStop && !item.rest ? `<tie type="stop"/>` : "") + (tieStart ? `<tie type="start"/>` : "");
      x.push(`<note>${pi ? "<chord/>" : ""}<pitch><step>${p.step}</step>${p.alter ? `<alter>${p.alter}</alter>` : ""}<octave>${p.octave}</octave></pitch><duration>${dur}</duration>${tieXml}<voice>1</voice><type>${type}</type>${dotXml}${accidental(p, key)}${tm}${pi ? "" : notations(first, lastChunk, tieStart, tieStop)}${pi && (tieStart || tieStop) ? `<notations>${tieStop ? `<tied type="stop"/>` : ""}${tieStart ? `<tied type="start"/>` : ""}</notations>` : ""}</note>`);
    });
  });
  return x.join("");
}

function clefFor(name) {
  return /大提琴|倍司|贝司|低音|bass|cello/i.test(name) ? `<clef><sign>F</sign><line>4</line></clef>` : `<clef><sign>G</sign><line>2</line></clef>`;
}

// score: parseScore 的结果；partIndices: 要导出的声部下标（按顺序）
export function buildMusicXml(score, partIndices, { title } = {}) {
  const allCells = cellsOf(score);
  const nBars = score.bars.length;
  const key0 = keyInfo(score.meta.key);
  const [tn, td] = (score.meta.time.match(/(\d+)\s*\/\s*(\d+)/) || [0, 4, 4]).slice(1).map(Number);
  const partList = [];
  const partsXml = [];
  partIndices.forEach((pi, order) => {
    const part = score.parts[pi];
    const id = `P${order + 1}`;
    partList.push(`<score-part id="${id}"><part-name>${esc(part.name)}</part-name></score-part>`);
    const measures = itemsOf(allCells[pi]);
    const st = { key: key0, time: `${tn}/${td}`, wedge: null };
    const mx = [];
    for (let k = 1; k <= nBars; k++) {
      const items = measures[k - 1] || [];
      const body = [];
      if (k === 1) {
        body.push(`<attributes><divisions>${DIV}</divisions><key><fifths>${key0.fifths}</fifths></key><time><beats>${tn}</beats><beat-type>${td}</beat-type></time>${clefFor(part.name)}</attributes>`);
        if (order === 0) body.push(`<direction placement="above"><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>${score.meta.tempo}</per-minute></metronome></direction-type><sound tempo="${score.meta.tempo}"/></direction>`);
      }
      let hasNote = false;
      for (const it of items) {
        // 同一处连写了几个拍号（比如页首的 @2/4 紧接着 @4/4），只算最后一个；调号同理
        const dirs = (it.dirs || []).filter((d, i, arr) => {
          const isTime = /^\d+\s*\/\s*\d+$/.test(d), isKey = /^1\s*=/.test(d);
          if (!isTime && !isKey) return true;
          return !arr.slice(i + 1).some((e) => (isTime ? /^\d+\s*\/\s*\d+$/.test(e) : /^1\s*=/.test(e)));
        });
        for (const d of dirs) body.push(directionXml(d, st, order === 0));
        if (it.dirsOnly) continue;
        hasNote = true;
        body.push(noteXml(it, st.key, part));
      }
      if (!hasNote) {
        // 这个声部这一小节没写：整小节休止
        const len = (k < nBars ? score.bars[k] : score.length) - score.bars[k - 1];
        body.push(`<note><rest measure="yes"/><duration>${Math.max(1, Math.round(len * DIV))}</duration><voice>1</voice></note>`);
      }
      const barline = k === nBars ? `<barline location="right"><bar-style>light-heavy</bar-style></barline>` : "";
      mx.push(`<measure number="${k}">${body.join("")}${barline}</measure>`);
    }
    partsXml.push(`<part id="${id}">${mx.join("\n")}</part>`);
  });
  const t = title || score.meta.title || "简谱";
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">
<score-partwise version="4.0">
<work><work-title>${esc(t)}</work-title></work>
<identification><encoding><software>简谱乐队</software></encoding></identification>
<part-list>${partList.join("")}</part-list>
${partsXml.join("\n")}
</score-partwise>
`;
}
