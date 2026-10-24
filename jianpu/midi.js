// 导出标准 MIDI 文件（格式 1，每个声部一个音轨）。

import { GM_PROGRAM } from "./audio.js";
import { DEFAULT_LEVEL } from "./jianpu.js";

const PPQ = 480;

function varLen(n) {
  const bytes = [n & 0x7f];
  while ((n >>= 7)) bytes.unshift((n & 0x7f) | 0x80);
  return bytes;
}

function textMeta(type, s) {
  const b = [...new TextEncoder().encode(s)];
  return [0xff, type, ...varLen(b.length), ...b];
}

function track(events) {
  // events: {tick, order, data}；同一时刻先关音再开音
  events.sort((a, b) => a.tick - b.tick || a.order - b.order);
  const bytes = [];
  let last = 0;
  for (const e of events) {
    bytes.push(...varLen(e.tick - last), ...e.data);
    last = e.tick;
  }
  bytes.push(0, 0xff, 0x2f, 0);
  return [0x4d, 0x54, 0x72, 0x6b, ...u32(bytes.length), ...bytes];
}

const u32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const u16 = (n) => [(n >> 8) & 255, n & 255];
const tick = (beat) => Math.max(0, Math.round(beat * PPQ));

export function buildMidi(score, settings, include) {
  const tracks = [];
  const conductor = [{ tick: 0, order: 0, data: textMeta(0x03, score.meta.title || "简谱") }];
  for (const t of score.tempos) {
    const us = Math.round(60e6 / (t.bpm * settings.tempoFactor));
    conductor.push({ tick: tick(t.beat), order: 1, data: [0xff, 0x51, 0x03, (us >> 16) & 255, (us >> 8) & 255, us & 255] });
  }
  for (const ts of score.timeSigs) {
    conductor.push({ tick: tick(ts.beat), order: 1, data: [0xff, 0x58, 0x04, ts.num, Math.round(Math.log2(ts.den)), 24, 8] });
  }
  tracks.push(track(conductor));

  let channel = 0;
  const nextChannel = () => {
    if (channel === 9) channel++; // 第 10 通道是打击乐
    const ch = channel % 16;
    channel++;
    return ch;
  };
  score.parts.forEach((part, i) => {
    if (!include(i)) return;
    const ps = settings.parts[i];
    const shift = settings.transpose + 12 * ps.octave;
    // 泛音单独放一个音轨，用吉他泛音的音色
    const groups = [
      { name: part.name, program: GM_PROGRAM[ps.instrument] ?? 0, events: part.events.filter((e) => !e.h) },
      { name: `${part.name}（泛音）`, program: 31, events: part.events.filter((e) => e.h) },
    ];
    for (const g of groups) {
      if (!g.events.length) continue;
      const ch = nextChannel();
      const ev = [
        { tick: 0, order: 0, data: textMeta(0x03, g.name) },
        { tick: 0, order: 0, data: [0xc0 | ch, g.program] },
        { tick: 0, order: 0, data: [0xb0 | ch, 7, Math.min(127, Math.round(ps.volume * 100))] },
      ];
      for (const e of g.events) {
        const vel = Math.max(1, Math.min(127, Math.round((e.v ?? DEFAULT_LEVEL) * 115)));
        for (const m of e.m) {
          const note = m + shift;
          if (note < 0 || note > 127) continue;
          ev.push({ tick: tick(e.t), order: 2, data: [0x90 | ch, note, vel] });
          ev.push({ tick: Math.max(tick(e.t) + 1, tick(e.t + e.d)), order: 1, data: [0x80 | ch, note, 0] });
        }
      }
      tracks.push(track(ev));
    }
  });

  const header = [0x4d, 0x54, 0x68, 0x64, ...u32(6), ...u16(1), ...u16(tracks.length), ...u16(PPQ)];
  return new Blob([new Uint8Array([...header, ...tracks.flat()])], { type: "audio/midi" });
}
