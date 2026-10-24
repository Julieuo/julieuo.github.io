// 把一小节的简谱 token 画成谱面：数字、高低音点、减时线、增时线、装饰记号、力度。

const ORN_SYMBOL = { tr: "tr", w: "∽", lw: "∾", "/": "↗", "\\": "↘", o: "○", ">": ">" };

function parseSuffix(suffix) {
  let oct = 0, under = 0, dots = 0, tie = false;
  const tags = [];
  const rest = suffix.replace(/!([a-z^>/\\]+)/g, (_, t) => {
    tags.push(t);
    return "";
  });
  for (const ch of rest) {
    if (ch === "'") oct++;
    else if (ch === ",") oct--;
    else if (ch === "_") under++;
    else if (ch === ".") dots++;
    else if (ch === "~") tie = true;
  }
  return { oct, under, dots, tie, tags };
}

function parsePitch(text) {
  const m = text.match(/^([#b♯♭]?)([0-7])([',]*)$/);
  if (!m) return null;
  return { acc: m[1] === "#" || m[1] === "♯" ? "♯" : m[1] ? "♭" : "", deg: m[2], oct: parseSuffix(m[3]).oct };
}

// token 文本 -> 显示用的结构
function classify(t) {
  const text = t.text;
  if (text === "-") return { kind: "dash", dur: 1 };
  if (text === "~") return { kind: "tie" };
  if (text === ")") return { kind: "tupletEnd" };
  if (/^\(\d$/.test(text)) return { kind: "tupletStart", n: text[1] };
  if (text.startsWith("{")) {
    return { kind: "grace", pitches: text.slice(1, -1).trim().split(/\s+/).map(parsePitch).filter(Boolean) };
  }
  if (text.startsWith("@")) return { kind: "dir", text: text.slice(1) };
  if (text.startsWith("<")) {
    const m = text.match(/^<([^>]*)>(.*)$/);
    const s = parseSuffix(m[2]);
    const pitches = m[1].trim().split(/\s+/).map(parsePitch).filter(Boolean);
    return { kind: "note", pitches, ...s, dur: Math.pow(2, -s.under) * (2 - Math.pow(2, -s.dots)) };
  }
  const m = text.match(/^([#b♯♭]?)([0-7])(.*)$/);
  if (!m) return { kind: "dir", text };
  const s = parseSuffix(m[3]);
  const acc = m[1] === "#" || m[1] === "♯" ? "♯" : m[1] ? "♭" : "";
  return { kind: "note", pitches: [{ acc, deg: m[2], oct: s.oct }], ...s, dur: Math.pow(2, -s.under) * (2 - Math.pow(2, -s.dots)) };
}

const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

function dotsEl(n, cls) {
  const d = el("span", `jp-oct ${cls}`);
  for (let i = 0; i < Math.abs(n); i++) d.append(el("i"));
  return d;
}

// 一个音（或和弦、休止）的竖向块：上方记号、高音点、数字、减时线、低音点
// 一个音（或和弦、休止）的竖向块。数字层底部对齐：和弦最下面那个音和单音在同一水平线上，
// 和弦其余的音往上叠；装饰记号和高音点紧贴在各自的音上方
function noteBox(item, graces, tuplet) {
  const box = el("span", "jp-note");
  box.dataset.key = item.key;
  box.append(el("span", "jp-marks")); // 速度、换调等，之后由 attachPending 填进来

  const body = el("span", "jp-body");
  if (graces) {
    const g = el("span", "jp-grace");
    g.dataset.key = graces.key;
    for (const p of graces.pitches) {
      const gn = el("span", "jp-gnote");
      if (p.oct > 0) gn.append(dotsEl(p.oct, "up"));
      gn.append(el("span", "jp-gdigit", p.acc + p.deg));
      if (p.oct < 0) gn.append(dotsEl(p.oct, "down"));
      g.append(gn);
    }
    body.append(g);
  }

  if (item.tags?.includes("arp")) body.append(el("span", "jp-arp")); // 琶音：和弦左边的竖波浪线
  const core = el("span", "jp-core");
  const top = el("span", "jp-top");
  if (tuplet) top.append(el("span", "jp-tup", tuplet));
  if (item.tags?.includes("^")) top.append(el("span", "jp-ferm", "⌒"));
  for (const t of item.tags || []) if (ORN_SYMBOL[t]) top.append(el("span", `jp-orn jp-orn-${t === "tr" ? "tr" : "sym"}`, ORN_SYMBOL[t]));
  if (top.childElementCount) core.append(top);

  // 和弦从高到低竖着排
  const stack = el("span", "jp-stack");
  // 按实际音高从高到低排，不管文本里怎么写，最低的音都在最下面
  const height = (p) => p.oct * 7 + +p.deg + (p.acc === "♯" ? 0.5 : p.acc === "♭" ? -0.5 : 0);
  const pitches = item.kind === "dash" ? [{ acc: "", deg: "–", oct: 0 }] : item.pitches.slice().sort((a, b) => height(b) - height(a));
  pitches.forEach((p, idx) => {
    const n = el("span", "jp-pitch");
    if (p.oct > 0) n.append(dotsEl(p.oct, "up"));
    const digit = el("span", "jp-digit");
    if (p.acc) digit.append(el("sup", "jp-acc", p.acc));
    digit.append(document.createTextNode(p.deg));
    n.append(digit);
    // 最下面那个音的低音点画在减时线下面，其余的紧贴数字
    if (idx < pitches.length - 1 && p.oct < 0) n.append(dotsEl(p.oct, "down"));
    stack.append(n);
  });
  core.append(stack);
  body.append(core);
  if (item.dots) body.append(el("span", "jp-aug", "·".repeat(item.dots)));
  if (item.tie) body.append(el("span", "jp-tie", "⁀"));
  box.append(body);

  // 减时线由 layoutBar 按组画，插在低音点前面
  const lastLow = pitches.at(-1).oct;
  box._low = dotsEl(lastLow < 0 ? lastLow : 0, "down jp-low");
  box.append(box._low);
  return box;
}

function dirText(d) {
  if (/^(ppp|pp|p|mp|mf|f|ff|fff|sf|sfz|fz|fp)$/.test(d)) return { row: "dyn", text: d };
  if (d === "<") return { row: "dyn", text: "<", cls: "hair" };
  if (d === ">") return { row: "dyn", text: ">", cls: "hair" };
  if (d === "!") return null;
  if (/^q\s*=/i.test(d)) return { row: "top", text: `♩=${d.replace(/^q\s*=/i, "")}` };
  if (/^1\s*=/.test(d)) return { row: "top", text: d };
  if (/^\d+\/\d+$/.test(d)) return { row: "time", text: d };
  return null;
}

// toks: [{line, col, text}] -> 这一小节里每个音块和它在小节里的起拍位置
// 返回 {items: [{onset, el}], len}，由调用方按起拍位置把各声部对齐
export function layoutBar(toks) {
  const items = [];
  let pendingGrace = null;
  let pendingTuplet = null;
  let pendingTop = []; // 速度、换调、换拍号，贴到下一个音上方
  let pendingDyn = []; // 力度、渐强渐弱，贴到下一个音下方
  let scale = 1;
  const scales = [];
  let beat = 0;
  const eps = 1e-6;
  let group = null; // 同一拍里连着减时线的一组音 {beat, members: [{box, under}]}

  // 第 k 条线：相邻的音也有第 k 条线就连过去，否则只画在这个音自己下面
  const closeGroup = () => {
    if (!group) return;
    const ms = group.members;
    ms.forEach((m, j) => {
      for (let k = 1; k <= m.under; k++) {
        const line = el("i", "jp-line");
        if (j > 0 && ms[j - 1].under >= k) line.classList.add("l");
        if (j < ms.length - 1 && ms[j + 1].under >= k) line.classList.add("r");
        m.box.insertBefore(line, m.box._low);
      }
    });
    group = null;
  };
  const attachPending = (box) => {
    if (pendingTop.length) {
      const m = box.querySelector(":scope > .jp-marks");
      for (const t of pendingTop) m.append(t);
    }
    if (pendingDyn.length) {
      const d = el("span", "jp-dyn");
      for (const t of pendingDyn) d.append(t);
      box.append(d);
    }
    pendingTop = [];
    pendingDyn = [];
  };

  for (const t of toks) {
    const item = { ...classify(t), key: `${t.line}:${t.col}` };
    if (item.kind === "dir") {
      const d = dirText(item.text);
      if (!d) continue;
      if (d.row === "dyn") pendingDyn.push(el("span", `jp-dyn-mark ${d.cls || ""}`, d.text));
      else if (d.row === "time") {
        const [a, b] = d.text.split("/");
        const f = el("span", "jp-time");
        f.append(el("span", "", a), el("span", "", b));
        pendingTop.push(f);
      } else pendingTop.push(el("span", "jp-mark", d.text));
      continue;
    }
    if (item.kind === "grace") { pendingGrace = item; continue; }
    if (item.kind === "tupletStart") {
      scales.push(scale);
      scale *= { 2: 1.5, 3: 2 / 3, 4: 0.75, 5: 0.8, 6: 4 / 6, 7: 4 / 7 }[item.n] ?? 1;
      pendingTuplet = item.n;
      continue;
    }
    if (item.kind === "tupletEnd") { scale = scales.pop() ?? 1; continue; }
    if (item.kind === "tie") {
      items.at(-1)?.el.querySelector(".jp-body")?.append(el("span", "jp-tie", "⁀"));
      continue;
    }
    const box = noteBox(item, pendingGrace, pendingTuplet);
    attachPending(box);
    pendingGrace = null;
    pendingTuplet = null;
    const startBeat = beat;
    beat += item.dur * scale;
    items.push({ onset: startBeat, el: box });

    const under = item.kind === "note" ? item.under || 0 : 0;
    if (under > 0) {
      if (!group || Math.floor(startBeat + eps) !== group.beat) {
        closeGroup();
        group = { beat: Math.floor(startBeat + eps), members: [] };
      }
      group.members.push({ box, under });
      if (Math.abs(beat - Math.round(beat)) < eps) closeGroup();
    } else {
      closeGroup();
    }
  }
  closeGroup();
  if (pendingTop.length || pendingDyn.length) {
    const box = el("span", "jp-note jp-empty");
    box.append(el("span", "jp-marks"));
    attachPending(box);
    items.push({ onset: beat, el: box });
  }
  return { items, len: beat };
}
