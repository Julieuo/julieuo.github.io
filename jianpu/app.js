// 页面逻辑：上传识别、文本解析、声部设置、播放与导出。

import { parseScore } from "./jianpu.js";
import { Engine, INSTRUMENTS, defaultInstrument, isAudible } from "./audio.js";
import { buildMidi } from "./midi.js";
import { layoutBar } from "./render.js";

const $ = (id) => document.getElementById(id);
const engine = new Engine();

// 静态发布模式（GitHub Pages 这类没有服务器的地方，由 build-static.js 打包）：
// 没有识谱功能，曲库是打包进来的几首谱子，修改只存在本机浏览器里
const STATIC = !!window.JIANPU_STATIC;

const state = {
  files: [], // {name, type, data(base64), preview}
  score: null,
  partSettings: new Map(), // 声部名 -> 设置，修改文本时保留
  backupText: null,
  pos: null, // 暂停或跳转后的播放位置 {beat, pass}
  currentId: null, // 当前文本对应“我的谱子”里的哪一首
  savedText: null, // 上次保存时的文本，用来判断有没有未保存的修改
};

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
};

// ---------- 上传 ----------

const drop = $("drop");
$("file-input").addEventListener("change", (e) => addFiles(e.target.files));
drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
drop.addEventListener("dragleave", () => drop.classList.remove("over"));
drop.addEventListener("drop", (e) => {
  e.preventDefault();
  drop.classList.remove("over");
  addFiles(e.dataTransfer.files);
});

async function addFiles(fileList) {
  const status = $("recognize-status");
  for (const f of fileList) {
    if (/heic|heif/i.test(f.type) || /\.hei[cf]$/i.test(f.name)) {
      status.textContent = `${f.name} 是 HEIC 格式，请先在“照片”里导出为 JPG 再上传。`;
      continue;
    }
    try {
      if (f.type === "application/pdf") {
        state.files.push({ name: f.name, type: f.type, data: await toBase64(f), preview: null });
      } else if (f.type.startsWith("image/")) {
        const img = await prepareImage(f);
        state.files.push({ name: f.name, ...img });
      } else {
        status.textContent = `${f.name} 不是图片或 PDF，已跳过。`;
      }
    } catch (err) {
      status.textContent = `${f.name} 读取失败：${err.message}`;
    }
  }
  $("file-input").value = "";
  renderFiles();
}

function toBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1]);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

// 太大的照片缩小一点再上传（长边不超过 2600 像素）
async function prepareImage(file) {
  const url = URL.createObjectURL(file);
  const img = await new Promise((resolve, reject) => {
    const im = new Image();
    im.onload = () => resolve(im);
    im.onerror = () => reject(new Error("无法打开图片"));
    im.src = url;
  });
  const MAX = 2600;
  const scale = Math.min(1, MAX / Math.max(img.naturalWidth, img.naturalHeight));
  const supported = ["image/jpeg", "image/png", "image/webp", "image/gif"].includes(file.type);
  if (scale === 1 && file.size < 4 * 1024 * 1024 && supported) {
    return { type: file.type, data: await toBase64(file), preview: url };
  }
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(img.naturalWidth * scale);
  canvas.height = Math.round(img.naturalHeight * scale);
  const g = canvas.getContext("2d");
  g.fillStyle = "#fff";
  g.fillRect(0, 0, canvas.width, canvas.height);
  g.drawImage(img, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise((r) => canvas.toBlob(r, "image/jpeg", 0.92));
  return { type: "image/jpeg", data: await toBase64(blob), preview: url };
}

function renderFiles() {
  const ul = $("file-list");
  ul.innerHTML = "";
  state.files.forEach((f, i) => {
    const li = document.createElement("li");
    const thumb = f.preview ? Object.assign(document.createElement("img"), { src: f.preview, alt: "" }) : Object.assign(document.createElement("span"), { className: "pdf", textContent: "PDF" });
    const name = Object.assign(document.createElement("span"), { className: "name", textContent: `${i + 1}. ${f.name}`, title: f.name });
    const rm = Object.assign(document.createElement("button"), { textContent: "✕", title: "移除" });
    rm.onclick = (e) => {
      e.preventDefault();
      state.files.splice(i, 1);
      renderFiles();
    };
    li.append(thumb, name, rm);
    ul.append(li);
  });
  $("recognize-btn").disabled = state.files.length === 0;
}

// ---------- 识别 ----------

$("recognize-btn").addEventListener("click", recognize);

async function recognize() {
  const btn = $("recognize-btn");
  const status = $("recognize-status");
  const raw = $("raw-output");
  const notes = $("recognize-notes");
  btn.disabled = true;
  raw.textContent = "";
  notes.hidden = true;
  $("raw-wrap").hidden = false;
  const started = Date.now();
  let text = "";
  const timer = setInterval(() => {
    const secs = Math.round((Date.now() - started) / 1000);
    const pm = [...text.matchAll(/\[\[(PAGE|CHECK) (\d+)\/(\d+)\]\]/g)].at(-1);
    status.textContent = !pm
      ? `正在识别… ${secs} 秒（复杂的总谱可能要一两分钟）`
      : pm[1] === "CHECK"
        ? `第 ${pm[2]} / ${pm[3]} 页有小节拍数对不上，正在请 Claude 对照原图重看… 已用 ${secs} 秒`
        : `正在逐页识别：第 ${pm[2]} / ${pm[3]} 页… 已用 ${secs} 秒（每页大约一两分钟）`;
  }, 500);

  try {
    const res = await fetch("/api/recognize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        files: state.files.map(({ name, type, data }) => ({ name, type, data })),
        hint: $("hint").value,
        force: $("force").checked,
      }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `服务器错误 ${res.status}`);
    }
    const scoreId = res.headers.get("X-Score-Id");
    const cacheHit = res.headers.get("X-Cache") === "hit";
    const pageCount = +res.headers.get("X-Pages") || 1;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      raw.textContent = text;
      raw.scrollTop = raw.scrollHeight;
    }
    const errIdx = text.indexOf("[[ERROR]]");
    const errMsg = errIdx >= 0 ? text.slice(errIdx + 9).trim() : "";
    // 逐页识别时，合并好的结果在 [[RESULT]] 后面；中途出错就不填文本框
    const resIdx = text.lastIndexOf("[[RESULT]]");
    const body = resIdx >= 0 ? text.slice(resIdx + 10) : pageCount > 1 && !cacheHit ? "" : text;
    const m = body.match(/```(?:jianpu)?\s*\n([\s\S]*?)(?:```|$)/);
    const scoreText = (m ? m[1] : errIdx >= 0 || !body ? "" : body).replace(/\n?\[\[ERROR\]\][\s\S]*$/, "").trim();
    if (scoreText) {
      const editor = $("editor");
      if (editor.value.trim() && editor.value.trim() !== scoreText) {
        state.backupText = editor.value;
        $("restore-btn").hidden = false;
      }
      editor.value = scoreText + "\n";
      state.currentId = errIdx >= 0 ? null : scoreId;
      state.savedText = errIdx >= 0 ? null : editor.value;
      resetHistory();
      onTextChanged();
      refreshLibrary();
    }
    const after = m ? body.slice(m.index + m[0].length).replace(/\[\[ERROR\]\][\s\S]*$/, "").trim() : "";
    if (after) {
      notes.textContent = after;
      notes.hidden = false;
    }
    const secs = Math.round((Date.now() - started) / 1000);
    status.textContent = errMsg
      ? `出错了：${errMsg}`
      : !scoreText
        ? "没有得到简谱文本，请看“识别输出”。"
        : cacheHit
          ? "这份谱子识别过了，直接用了保存的结果，没有消耗 token。想重新识别请勾选“重新识别”。"
          : `识别完成（${secs} 秒），已存进“我的谱子”。请对照原谱检查第 2 步里的文本。`;
  } catch (err) {
    status.textContent = `出错了：${err.message}`;
  } finally {
    clearInterval(timer);
    btn.disabled = state.files.length === 0;
  }
}

// ---------- 文本编辑与解析 ----------

const editor = $("editor");
let parseTimer = null;
editor.addEventListener("input", () => {
  clearTimeout(parseTimer);
  parseTimer = setTimeout(onTextChanged, 300);
});

$("example-btn").addEventListener("click", async () => {
  const text = await (await fetch("examples/dayu.txt")).text();
  if (editor.value.trim() && editor.value !== text) {
    state.backupText = editor.value;
    $("restore-btn").hidden = false;
  }
  editor.value = text;
  state.currentId = null;
  state.savedText = null;
  resetHistory();
  onTextChanged();
});

$("restore-btn").addEventListener("click", () => {
  if (state.backupText == null) return;
  const cur = editor.value;
  editor.value = state.backupText;
  state.backupText = cur;
  resetHistory();
  onTextChanged();
});

function onTextChanged() {
  store.set("jianpu-text", editor.value);
  store.set("jianpu-current", JSON.stringify({ id: state.currentId, saved: state.savedText }));
  updateSaveState();
  const score = parseScore(editor.value);
  state.score = score.parts.some((p) => p.events.length) ? score : null;
  state.lines = editor.value.split("\n");
  state.sorted = score.parts.map((p) => p.events.slice().sort((a, b) => a.t - b.t));
  state.barCells = state.score ? buildBarCells(state.score) : [];
  // 谱面上选中的小节在新文本里不存在了就取消选中
  if (edit.sel && (!state.score || edit.sel.part >= state.score.parts.length || edit.sel.to > state.score.bars.length)) edit.sel = null;
  if (edit.pick && !edit.sel) setPick(null);
  now.page = null;
  now.layout = null;
  $("now-rows").innerHTML = "";
  $("now-playing").hidden = !state.score;
  renderProblems(score);
  renderSummary(score);
  renderParts();
  updateRange();
  updateEditBar();
  const ok = !!state.score;
  for (const id of ["play-btn", "midi-btn", "wav-btn", "wav-each-btn", "pdf-btn"]) $(id).disabled = !ok;
  if (!ok && engine.playing) stopPlayback();
}

function renderSummary(score) {
  const el = $("parse-summary");
  if (!state.score) {
    el.textContent = editor.value.trim() ? "还没有可演奏的音符" : "";
    return;
  }
  const secs = beatToSec(score, score.length);
  el.textContent = `${score.parts.length} 个声部 · ${score.bars.length} 小节 · 约 ${formatTime(secs)} · ${score.meta.key} ${score.meta.time}`;
}

function renderProblems(score) {
  const ul = $("problems");
  ul.innerHTML = "";
  const items = [
    ...score.errors.map((e) => ({ ...e, cls: "error" })),
    ...score.warnings.map((e) => ({ ...e, cls: "warn" })),
  ].slice(0, 200);
  for (const p of items) {
    const li = document.createElement("li");
    li.className = p.cls;
    li.textContent = (p.line ? `第 ${p.line} 行：` : "") + p.msg;
    if (p.line) li.onclick = () => jumpToLine(p.line);
    ul.append(li);
  }
}

function jumpToLine(line) {
  const lines = editor.value.split("\n");
  const start = lines.slice(0, line - 1).reduce((n, l) => n + l.length + 1, 0);
  editor.focus();
  editor.setSelectionRange(start, start + (lines[line - 1] || "").length);
  revealLine(line);
}

// 只把文本框滚到那一行，不抢焦点
function revealLine(line) {
  const lh = parseFloat(getComputedStyle(editor).lineHeight) || 22;
  editor.scrollTop = Math.max(0, (line - 4) * lh);
}

// ---------- 我的谱子 ----------

// 曲库的读写：有服务器时走 /api/library；静态模式下内置的谱子从 library/ 目录读，
// 修改和新保存的谱子记在本机浏览器里（localStorage），所以每个人改的只有自己看得到
const lib = (() => {
  if (!STATIC) {
    const call = async (url, opts) => {
      const res = await fetch(url, opts);
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `服务器错误 ${res.status}`);
      return body;
    };
    return {
      list: () => call("/api/library"),
      get: (id) => call(`/api/library/${id}`),
      put: (id, text) => call(id ? `/api/library/${id}` : "/api/library", { method: id ? "PUT" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) }),
      remove: (id) => call(`/api/library/${id}`, { method: "DELETE" }),
    };
  }
  const KEY = "jianpu-static-lib";
  let base = null; // 打包进来的谱子列表
  const loadBase = async () => (base ||= await (await fetch("library/index.json")).json().catch(() => []));
  const locals = () => { try { return JSON.parse(store.get(KEY) || "{}") || {}; } catch { return {}; } };
  const saveLocals = (m) => store.set(KEY, JSON.stringify(m));
  const titleOf = (text) => (String(text).match(/^\s*(?:标题|title)\s*[:：]\s*(.+)$/im)?.[1] || "").trim() || "未命名";
  const newId = () => [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
  return {
    async list() {
      const b = await loadBase();
      const m = locals();
      const out = b.map((e) => (m[e.id] ? { ...e, title: m[e.id].title, updatedAt: m[e.id].updatedAt, localEdit: true, builtIn: true } : { ...e, builtIn: true }));
      for (const [id, e] of Object.entries(m)) if (!b.some((x) => x.id === id)) out.push({ id, title: e.title, source: "manual", files: [], updatedAt: e.updatedAt, localOnly: true });
      return out.sort((x, y) => String(y.updatedAt).localeCompare(String(x.updatedAt)));
    },
    async get(id) {
      const m = locals();
      let e = null;
      if ((await loadBase()).some((x) => x.id === id)) {
        const res = await fetch(`library/${id}.json`);
        if (!res.ok) throw new Error("这首谱子不存在了");
        e = await res.json();
      }
      if (m[id]) e = { ...(e || { id, source: "manual", notes: "" }), text: m[id].text };
      if (!e) throw new Error("这首谱子不存在了");
      return e;
    },
    async put(id, text) {
      const m = locals();
      id ||= newId();
      m[id] = { text, title: titleOf(text), updatedAt: new Date().toISOString() };
      saveLocals(m);
      return { id };
    },
    // 内置的谱子：删除只是去掉本机的修改，恢复原版
    async remove(id) {
      const m = locals();
      delete m[id];
      saveLocals(m);
      return { ok: true };
    },
  };
})();

function isDirty() {
  return editor.value.trim() !== "" && editor.value !== state.savedText;
}

function updateSaveState() {
  const btn = $("save-btn");
  const label = $("save-state");
  const dirty = isDirty();
  btn.disabled = !dirty;
  btn.textContent = state.currentId ? "保存修改" : "保存到我的谱子";
  label.className = "save-state" + (dirty && state.currentId ? " dirty" : "");
  label.textContent = !editor.value.trim() ? "" : !state.currentId ? "" : dirty ? "有未保存的修改" : "已保存";
  for (const li of $("library-list").children) li.classList.toggle("current", li.dataset.id === state.currentId);
}

$("save-btn").addEventListener("click", async () => {
  const text = editor.value;
  try {
    const body = await lib.put(state.currentId, text);
    state.currentId = body.id;
    state.savedText = text;
    onTextChanged();
    refreshLibrary();
  } catch (err) {
    $("save-state").textContent = `保存失败：${err.message}`;
  }
});

$("download-btn").addEventListener("click", () => {
  if (!editor.value.trim()) return;
  download(new Blob([editor.value], { type: "text/plain;charset=utf-8" }), `${fileBase()}.txt`);
});

async function refreshLibrary() {
  let list = [];
  try {
    list = await lib.list();
  } catch {
    return;
  }
  const ul = $("library-list");
  ul.innerHTML = "";
  $("library-card").hidden = list.length === 0;
  for (const e of list) {
    const li = document.createElement("li");
    li.dataset.id = e.id;
    const info = Object.assign(document.createElement("div"), { className: "info" });
    info.append(Object.assign(document.createElement("div"), { className: "title", textContent: e.title }));
    const from = STATIC
      ? e.localOnly ? "保存在这台电脑的浏览器里" : e.localEdit ? "内置谱子，在这台电脑上改过" : "内置谱子"
      : e.source === "recognized" ? `识别自 ${e.files.join("、")}${e.edited ? "，已修改" : ""}` : "手动保存";
    info.append(Object.assign(document.createElement("div"), { className: "meta", textContent: `${from} · ${formatDate(e.updatedAt)}`, title: from }));
    const open = Object.assign(document.createElement("button"), { textContent: "打开" });
    open.onclick = () => openScore(e.id);
    li.append(info, open);
    if (!(STATIC && e.builtIn && !e.localEdit)) {
      const del = Object.assign(document.createElement("button"), { textContent: STATIC && e.builtIn ? "恢复原版" : "删除", className: "del" });
      del.onclick = () => deleteScore(e);
      li.append(del);
    }
    ul.append(li);
  }
  updateSaveState();
}

async function openScore(id) {
  if (isDirty() && id !== state.currentId && !confirm("现在的文本有修改还没保存，确定打开另一首吗？")) return;
  try {
    const e = await lib.get(id);
    stopPlayback();
    editor.value = e.text;
    state.currentId = e.id;
    state.savedText = e.text;
    $("recognize-notes").textContent = e.notes || "";
    $("recognize-notes").hidden = !e.notes;
    $("from-bar").value = 1;
    resetHistory();
    onTextChanged();
    editor.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (err) {
    alert(`打开失败：${err.message}`);
  }
}

async function deleteScore(e) {
  const msg = STATIC && e.builtIn
    ? `把《${e.title}》恢复成内置的原版吗？你在这台电脑上的修改会丢掉。`
    : STATIC ? `确定删除《${e.title}》吗？它只保存在这台电脑的浏览器里，删了就没有了。` : `确定删除《${e.title}》吗？删除后要重新识别才能找回。`;
  if (!confirm(msg)) return;
  await lib.remove(e.id);
  if (state.currentId === e.id) {
    state.currentId = null;
    state.savedText = STATIC && e.builtIn ? editor.value : null; // 马上重新打开原版，不用再问一遍
    onTextChanged();
    if (STATIC && e.builtIn) await openScore(e.id);
  }
  refreshLibrary();
}

function formatDate(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ---------- 声部设置 ----------

// 每个声部名选过的乐器、八度、音量记在浏览器里，下次打开同名声部直接沿用
const partPrefs = (() => {
  try { return JSON.parse(store.get("jianpu-parts") || "{}") || {}; } catch { return {}; }
})();
function savePartPref(name, ps) {
  partPrefs[name] = { instrument: ps.instrument, octave: ps.octave, volume: ps.volume };
  store.set("jianpu-parts", JSON.stringify(partPrefs));
}

function settingsFor(name, index) {
  if (!state.partSettings.has(name)) {
    const d = defaultInstrument(name, index);
    const saved = partPrefs[name] || {};
    const instrument = INSTRUMENTS.some(([id]) => id === saved.instrument) ? saved.instrument : d.instrument;
    state.partSettings.set(name, {
      instrument,
      octave: Number.isInteger(saved.octave) && Math.abs(saved.octave) <= 2 ? saved.octave : d.octave,
      volume: typeof saved.volume === "number" && saved.volume >= 0 && saved.volume <= 1.5 ? saved.volume : 0.8,
      mute: false,
      solo: false,
    });
  }
  return state.partSettings.get(name);
}

function currentSettings() {
  const score = state.score;
  return {
    tempoFactor: +$("tempo").value / 100,
    transpose: +$("transpose").value,
    parts: score ? score.parts.map((p, i) => settingsFor(p.name, i)) : [],
  };
}

function renderParts() {
  const body = $("parts-body");
  body.innerHTML = "";
  if (!state.score) return;
  state.score.parts.forEach((part, i) => {
    const ps = settingsFor(part.name, i);
    const tr = document.createElement("tr");

    const name = document.createElement("td");
    name.className = "name";
    name.textContent = part.name;
    name.append(Object.assign(document.createElement("small"), { textContent: `${part.noteCount} 个音` }));

    const instTd = document.createElement("td");
    const sel = document.createElement("select");
    for (const [id, label] of INSTRUMENTS) sel.append(new Option(label, id, false, id === ps.instrument));
    sel.onchange = () => { ps.instrument = sel.value; savePartPref(part.name, ps); restartIfPlaying(); };
    instTd.append(sel);

    const octTd = document.createElement("td");
    const oct = document.createElement("select");
    for (let o = -2; o <= 2; o++) oct.append(new Option(o > 0 ? `+${o}` : String(o), o, false, o === ps.octave));
    oct.onchange = () => { ps.octave = +oct.value; savePartPref(part.name, ps); restartIfPlaying(); };
    octTd.append(oct);

    const volTd = document.createElement("td");
    const vol = Object.assign(document.createElement("input"), { type: "range", min: 0, max: 1.5, step: 0.05, value: ps.volume });
    vol.oninput = () => { ps.volume = +vol.value; engine.updateMix(currentSettings()); };
    vol.onchange = () => savePartPref(part.name, ps);
    volTd.append(vol);

    const muteTd = document.createElement("td");
    const mute = toggleButton("静音", ps.mute, (v) => { ps.mute = v; mixChanged(); });
    muteTd.append(mute);

    const soloTd = document.createElement("td");
    const solo = toggleButton("独奏", ps.solo, (v) => { ps.solo = v; mixChanged(); });
    soloTd.append(solo);

    tr.append(name, instTd, octTd, volTd, muteTd, soloTd);
    body.append(tr);
  });
  markSilentRows();
}

function toggleButton(label, pressed, onChange) {
  const b = Object.assign(document.createElement("button"), { textContent: label, className: "toggle" });
  b.setAttribute("aria-pressed", String(pressed));
  b.onclick = () => {
    const v = b.getAttribute("aria-pressed") !== "true";
    b.setAttribute("aria-pressed", String(v));
    onChange(v);
  };
  return b;
}

function mixChanged() {
  engine.updateMix(currentSettings());
  markSilentRows();
}

function markSilentRows() {
  const s = currentSettings();
  [...$("parts-body").children].forEach((tr, i) => tr.classList.toggle("silent", !isAudible(s, i)));
  // 正在演奏面板里只显示能听到的声部
  // 总谱视图里只显示能听到的声部
  now.page = null;
  now.layout = null;
  $("now-rows").innerHTML = "";
  if (state.score) renderNowPlaying(state.pos?.beat ?? barRange().fromBeat);
}

// ----- 正在演奏：总谱视图，各声部同一小节上下对齐，标出正在响的音 -----

const now = { page: null, layout: null, cells: [], marked: [], userScrollUntil: 0, autoScrollTarget: 0, backTimer: null };

// 每个声部：第 k 小节（从 1 开始）里写了哪些 token。
// 同时记下 state.barMeta[i][k-1] = {close, beats, lead, spans}，谱面编辑用：
// close 是结束这一小节的小节线位置，beats 是小节长度，lead 是从前面零时值片段并进来的 token 数，
// spans 是并进这一格的有时值片段数（大于 1 说明这个声部的小节线和总谱对不齐，不让在谱面上改）
function buildBarCells(score) {
  state.barMeta = [];
  return score.parts.map((part, i) => {
    const cells = Array.from({ length: score.bars.length }, () => []);
    const meta = Array.from({ length: score.bars.length }, () => null);
    let pending = [];
    for (const span of part.barSpans) {
      if (span.end - span.start <= 1e-6) {
        pending.push(...span.toks); // 只有记号、没有时值的片段，归到下一小节
        continue;
      }
      const k = barAt(span.start + 1e-6);
      cells[k - 1].push(...pending, ...span.toks);
      if (!meta[k - 1]) meta[k - 1] = { close: span.close, beats: span.end - span.start, lead: pending.length, spans: 1 };
      else meta[k - 1].spans++;
      pending = [];
    }
    if (pending.length) cells[cells.length - 1].push(...pending);
    state.barMeta[i] = meta;
    return cells;
  });
}

// 把小节分成若干行谱表：音越密的小节占的宽度越多，一行放不下就换行。
// width 是谱表可用的像素宽度；屏幕上用谱面区域的宽度，打印时用纸的宽度
function computeLayout(width) {
  const s = state.score;
  const settings = currentSettings();
  const visible = s.parts.map((_, i) => i).filter((i) => isAudible(settings, i));
  const bars = []; // 每小节：各声部的音块 + 合并后的起拍位置
  for (let k = 1; k <= s.bars.length; k++) {
    const parts = {};
    const onsets = new Set([0]);
    for (const i of visible) {
      const lay = layoutBar(state.barCells[i][k - 1]);
      parts[i] = lay;
      for (const it of lay.items) onsets.add(Math.round(it.onset * 1e4) / 1e4);
    }
    bars.push({ parts, slots: [...onsets].sort((a, b) => a - b) });
  }
  const maxSlots = Math.max(4, Math.floor((width - 72) / 27));
  const maxBars = width < 640 ? 3 : 6;
  const systems = [];
  let cur = null;
  bars.forEach((b, idx) => {
    const k = idx + 1;
    const n = b.slots.length;
    if (!cur || cur.slots + n > maxSlots || cur.last - cur.first + 1 >= maxBars) {
      cur = { first: k, last: k, slots: n };
      systems.push(cur);
    } else {
      cur.last = k;
      cur.slots += n;
    }
  });
  return { visible, bars, systems };
}

// 一行谱表：一个 CSS 网格，每个起拍位置一列；同一列里的音同时开始。
// live 为 true 时是屏幕上的谱面：记下每个音块以便播放时高亮，并铺一层可以点选、拖拽的小节格子；打印时不要这些
function renderSystem(sys, layout, live) {
  const s = state.score;
  const { visible, bars } = layout;
  const grid = Object.assign(document.createElement("div"), { className: "sg-system" });
  const cols = ["4.5em"];
  const barCols = {}; // k -> {start, slotCol: Map(onset -> 列号), end}
  for (let k = sys.first; k <= sys.last; k++) {
    const b = bars[k - 1];
    const start = cols.length + 1;
    const slotCol = new Map();
    b.slots.forEach((o, j) => {
      slotCol.set(o, start + j);
      cols.push("minmax(min-content, 1fr)");
    });
    cols.push("2px"); // 小节线
    barCols[k] = { start, slotCol, end: cols.length }; // end：小节线所在的列
  }
  grid.style.gridTemplateColumns = cols.join(" ");
  const place = (node, col, row) => {
    node.style.gridColumn = col;
    node.style.gridRow = row;
    grid.append(node);
    return node;
  };
  const rows = visible.length + 1;

  // 底层：每小节一块（当前小节加底色），每个声部一条分隔线
  for (let k = sys.first; k <= sys.last; k++) {
    const bg = Object.assign(document.createElement("div"), { className: "sg-bg" });
    bg.dataset.bar = k;
    place(bg, `${barCols[k].start} / ${barCols[k].end}`, `1 / ${rows + 1}`);
  }
  visible.forEach((_, r) => place(Object.assign(document.createElement("div"), { className: "sg-rowline" }), "1 / -1", r + 2));

  // 小节号
  for (let k = sys.first; k <= sys.last; k++) {
    const h = Object.assign(document.createElement("div"), { className: "sg-bar", textContent: k });
    const mm = s.mismatchedBars?.find((m) => m.bar === k);
    if (mm) {
      // 写明是哪个声部；如果它被静音或没被独奏，在谱面上看不到，就特别注明
      const hidden = mm.parts.filter((name) => !visible.some((i) => s.parts[i].name === name));
      h.classList.add("bad");
      h.append(Object.assign(document.createElement("span"), {
        className: "bad-note",
        textContent: ` ⚠ ${mm.text}${hidden.length ? `（${hidden.join("、")}已静音，谱面上没显示）` : ""}`,
      }));
      h.title = "这一小节各声部拍数不同，点第 2 步里的红字可以跳到那一行";
    }
    const sec = s.sectionMarks.find((m) => Math.abs(m.beat - s.bars[k - 1]) < 1e-6);
    if (sec) h.append(Object.assign(document.createElement("b"), { textContent: sec.name }));
    place(h, `${barCols[k].start} / ${barCols[k].end}`, 1);
  }

  visible.forEach((i, r) => {
    const row = r + 2;
    place(Object.assign(document.createElement("div"), { className: "sg-name", textContent: s.parts[i].name, title: s.parts[i].name }), 1, row);
    const cells = live ? now.cells[i] || (now.cells[i] = {}) : null;
    for (let k = sys.first; k <= sys.last; k++) {
      const { slotCol, end } = barCols[k];
      const items = bars[k - 1].parts[i].items;
      if (cells) cells[k] = items.map((it) => it.el);
      items.forEach((it, j) => {
        // 每个音从它的起拍列一直占到下一个音开始的列，减时线因此能连起来
        const colOf = (o) => slotCol.get(Math.round(o * 1e4) / 1e4) ?? barCols[k].start;
        const from = colOf(it.onset);
        const next = items[j + 1];
        const to = next ? colOf(next.onset) : end;
        it.el.dataset.part = i;
        it.el.dataset.b = k;
        place(it.el, `${from} / ${Math.max(to, from + 1)}`, row);
      });
    }
  });
  // 小节线：每小节一条，从第一个声部画到最后一个声部，压在音符上面
  for (let k = sys.first; k <= sys.last; k++) {
    place(Object.assign(document.createElement("div"), { className: "sg-barline" }), barCols[k].end, `2 / ${rows + 1}`);
  }
  if (!live) return grid;

  // 最上层：每个声部每小节一个透明格子，点选、拖拽都落在它上面
  visible.forEach((i, r) => {
    for (let k = sys.first; k <= sys.last; k++) {
      const c = Object.assign(document.createElement("div"), { className: "sg-cell" });
      c.dataset.part = i;
      c.dataset.b = k;
      place(c, `${barCols[k].start} / ${barCols[k].end}`, r + 2);
    }
  });

  grid.addEventListener("click", (e) => {
    const c = e.target.closest(".sg-cell");
    if (!c) return;
    if (edit.suppressClick) {
      edit.suppressClick = false;
      return;
    }
    const i = +c.dataset.part, k = +c.dataset.b;
    if (edit.pick) {
      const { mode } = edit.pick;
      setPick(null);
      transferBars(edit.sel, { part: i, bar: k }, mode);
      return;
    }
    selectCell(i, k, e.shiftKey);
    const toks = state.barCells[i]?.[k - 1];
    if (toks?.length) revealLine(toks[0].line);
  });
  grid.addEventListener("dblclick", (e) => {
    const c = e.target.closest(".sg-cell");
    if (!c) return;
    const toks = state.barCells[+c.dataset.part]?.[+c.dataset.b - 1];
    if (toks?.length) jumpToLine(toks[0].line);
  });
  return grid;
}

// 整首谱子的所有谱表行一次画出来，放在可以上下滚动的区域里
function renderNowSystems() {
  const box = $("now-rows");
  box.innerHTML = "";
  now.cells = [];
  now.marked = [];
  $("now-empty").hidden = now.layout.visible.length > 0;
  if (!now.layout.visible.length) return;
  now.layout.systems.forEach((sys, i) => {
    const grid = renderSystem(sys, now.layout, true);
    grid.dataset.sys = i;
    box.append(grid);
    equalizeRows(grid);
  });
  paintSelection();
}

// 自动跟随：把正在演奏的那一行滚到区域顶部附近。用户自己滑动后的几秒内不跟随，免得抢走
const FOLLOW_PAUSE = 3500;
function scrollToSystem(idx, force = false) {
  const box = $("now-rows");
  const el = box.querySelector(`.sg-system[data-sys="${idx}"]`);
  if (!el) return;
  if (!force && performance.now() < now.userScrollUntil) return;
  now.autoScrollTarget = Math.max(0, el.offsetTop - 6);
  box.scrollTo({ top: now.autoScrollTarget, behavior: "smooth" });
}
function currentSystemVisible() {
  const box = $("now-rows");
  const el = box.querySelector(`.sg-system[data-sys="${now.page}"]`);
  if (!el) return true;
  const top = el.offsetTop - box.scrollTop;
  return top + el.offsetHeight > 0 && top < box.clientHeight;
}
function updateBackButton() {
  $("now-back").hidden = !state.score || now.page == null || currentSystemVisible();
}
{
  const box = $("now-rows");
  const touched = () => { now.userScrollUntil = performance.now() + FOLLOW_PAUSE; };
  box.addEventListener("wheel", touched, { passive: true });
  box.addEventListener("touchmove", touched, { passive: true });
  box.addEventListener("pointerdown", touched);
  box.addEventListener("scroll", () => {
    if (now.backTimer) return;
    now.backTimer = requestAnimationFrame(() => { now.backTimer = null; updateBackButton(); });
  }, { passive: true });
  $("now-back").addEventListener("click", () => {
    now.userScrollUntil = 0;
    if (now.page != null) scrollToSystem(now.page, true);
  });
}

// 同一行谱表里，每个声部的记号层和数字层撑到一样高；数字层底部对齐，
// 所以单音和和弦最下面的音在同一水平线上，减时线也都在同一高度
function equalizeRows(grid) {
  const rows = new Map();
  for (const it of grid.querySelectorAll(":scope > .jp-note")) {
    const key = it.dataset.part;
    if (!rows.has(key)) rows.set(key, []);
    rows.get(key).push(it);
  }
  for (const items of rows.values()) {
    for (const zone of ["jp-marks", "jp-body"]) {
      const els = items.map((it) => it.querySelector(`:scope > .${zone}`)).filter(Boolean);
      for (const e of els) e.style.minHeight = "";
      const h = Math.max(0, ...els.map((e) => e.offsetHeight));
      for (const e of els) e.style.minHeight = `${h}px`;
    }
  }
}

function renderNowPlaying(beat) {
  const s = state.score;
  if (!s) return;
  if (!now.layout) now.layout = computeLayout($("now-rows").clientWidth || 700);
  const bar = barAt(beat);
  const idx = Math.max(0, now.layout.systems.findIndex((x) => bar >= x.first && bar <= x.last));
  for (const el of now.marked) el.classList.remove("on", "wait", "cur");
  now.marked = [];
  if (!$("now-rows").children.length) renderNowSystems();
  if (now.page !== idx) {
    now.page = idx;
    scrollToSystem(idx);
    updateBackButton();
  }
  for (const el of $("now-rows").querySelectorAll(`.sg-bg[data-bar="${bar}"]`)) {
    el.classList.add("cur");
    now.marked.push(el);
  }
  now.cells.forEach((row, i) => {
    if (!row) return;
    const ev = eventAt(state.sorted[i] || [], beat);
    if (!ev || ev.col === undefined) return;
    const key = `${ev.line}:${ev.col}`;
    const els = row[barAt(ev.t + 1e-6)] || [];
    let span = null;
    for (const e of els) {
      span = e.dataset.key === key ? e : e.querySelector(`[data-key="${key}"]`);
      if (span) break;
    }
    if (!span) return;
    span.classList.add(beat < ev.t + ev.d ? "on" : "wait");
    now.marked.push(span);
  });
}

window.addEventListener("resize", () => {
  now.page = null;
  now.layout = null;
  $("now-rows").innerHTML = "";
  if (state.score) renderNowPlaying(state.pos?.beat ?? barRange().fromBeat);
});

// 最后一个在 beat 或之前开始的音
function eventAt(events, beat) {
  let lo = 0, hi = events.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (events[mid].t <= beat + 1e-9) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans >= 0 ? events[ans] : null;
}

// ---------- 乐谱编辑：在谱面上选中小节，拖到别的声部 ----------
// 谱子本身就是第 2 步的文本，这里的每个操作都是对文本做替换：
// 目标小节里的音换成来源小节的音；拍号、速度、换调这类影响后面的指令留在原处，不复制也不删。

const edit = { sel: null, pick: null, drag: null, history: [], future: [], suppressClick: false };
const STRUCTURAL_RE = /^@(?:\d+\s*\/\s*\d+|q\s*=|1\s*=)/i; // 换拍号、换速度、换调
const HISTORY_MAX = 100;

const partName = (i) => state.score.parts[i].name;
const barLabel = (a, b) => (a === b ? `第 ${a} 小节` : `第 ${a}–${b} 小节`);

// 第 line 行第 col 列在文本里的下标
function offsetOf(line, col) {
  let o = 0;
  for (let i = 0; i < line - 1; i++) o += state.lines[i].length + 1;
  return o + col;
}

// token 拼回文本：倚音 {…} 紧贴后面的主音，其余用空格隔开
function joinToks(toks) {
  let out = "";
  toks.forEach((t, j) => {
    out += t.text;
    if (j < toks.length - 1 && !t.text.startsWith("{")) out += " ";
  });
  return out;
}

// 这么多拍的休止怎么写
function restText(beats) {
  const out = [];
  let b = beats;
  for (const [txt, d] of [["0", 1], ["0_", 0.5], ["0__", 0.25], ["0___", 0.125]]) {
    while (b >= d - 1e-6) {
      out.push(txt);
      b -= d;
    }
  }
  return out.join(" ") || "0";
}

function cellInfo(i, k) {
  const meta = state.barMeta?.[i]?.[k - 1];
  if (!meta) return null;
  return { meta, toks: (state.barCells[i]?.[k - 1] || []).slice(meta.lead) };
}

// 把第 i 个声部第 k 小节的音换成 srcToks（null 表示换成休止）。
// 返回文本替换 {start, end, text}；没有要改的返回 {skip}；不能改返回 {error}
function replacementFor(i, k, srcToks) {
  const c = cellInfo(i, k);
  if (!c) return { error: `${partName(i)}声部没有第 ${k} 小节` };
  if (c.meta.spans > 1) return { error: `${partName(i)}第 ${k} 小节的小节线和总谱对不齐，请在第 2 步的文本框里修改` };
  const toks = c.toks;
  const isNote = (t) => !STRUCTURAL_RE.test(t.text);
  const first = toks.findIndex(isNote);
  const body = srcToks ? joinToks(srcToks.filter(isNote)) : restText(c.meta.beats);
  if (first < 0) {
    if (!srcToks) return { skip: true };
    // 这一小节没写音，插到结尾小节线的前面
    let at = null;
    if (c.meta.close) at = offsetOf(c.meta.close.line, c.meta.close.col);
    else if (toks.length) at = offsetOf(toks.at(-1).line, toks.at(-1).col) + toks.at(-1).text.length;
    if (at == null) return { error: `${partName(i)}第 ${k} 小节找不到可以插入的位置` };
    const text = editor.value;
    const padL = at > 0 && !/\s/.test(text[at - 1]) ? " " : "";
    const padR = at < text.length && !/\s/.test(text[at]) ? " " : "";
    return { start: at, end: at, text: padL + body + padR };
  }
  let last = toks.length - 1;
  while (!isNote(toks[last])) last--;
  const keep = toks.slice(first, last + 1).filter((t) => !isNote(t)); // 夹在音中间的换拍号等，保留在最前面
  const start = offsetOf(toks[first].line, toks[first].col);
  const end = offsetOf(toks[last].line, toks[last].col) + toks[last].text.length;
  return { start, end, text: joinToks([...keep, { text: body }]) };
}

function setEditStatus(msg, isError = false) {
  const el = $("edit-status");
  el.textContent = msg;
  el.classList.toggle("error", isError);
}

// 一次应用若干处替换；有重叠就整个不做
function applyReplacements(reps, label, selAfter) {
  const list = reps.filter((r) => !r.skip).sort((a, b) => a.start - b.start);
  if (!list.length) return setEditStatus("这些小节本来就没有音，没有修改。");
  for (let j = 1; j < list.length; j++) {
    if (list[j].start < list[j - 1].end) return setEditStatus("来源和目标在文本里重叠了（比如在反复的同一段里），没有修改。", true);
  }
  let text = editor.value;
  for (const r of list.slice().reverse()) text = text.slice(0, r.start) + r.text + text.slice(r.end);
  pushHistory();
  setScoreText(text, selAfter);
  setEditStatus(`${label}。可以撤销。`);
}

// 用程序改过的文本替换文本框内容，并重画谱面；尽量保持谱面滚动的位置
function setScoreText(text, sel) {
  const box = $("now-rows");
  const top = box.scrollTop;
  now.userScrollUntil = performance.now() + FOLLOW_PAUSE;
  editor.value = text;
  edit.sel = sel;
  onTextChanged();
  box.scrollTop = top;
  if (sel) for (let k = sel.from; k <= sel.to; k++) for (const c of cellsAt(sel.part, k)) c.classList.add("flash");
  restartIfPlaying();
}

// 把 src（某声部第 from 到 to 小节）的音放到 target（某声部第 bar 小节起）；mode 为 move 时来源改成休止
function transferBars(src, target, mode) {
  if (!src || !state.score) return;
  const n = src.to - src.from + 1;
  if (src.part === target.part && target.bar <= src.to && target.bar + n - 1 >= src.from) {
    return setEditStatus("目标和来源是同一段，没有修改。", true);
  }
  const reps = [];
  for (let t = 0; t < n; t++) {
    const sc = cellInfo(src.part, src.from + t);
    if (!sc) return setEditStatus(`${partName(src.part)}声部没有第 ${src.from + t} 小节`, true);
    const r = replacementFor(target.part, target.bar + t, sc.toks);
    if (r.error) return setEditStatus(r.error, true);
    reps.push(r);
    if (mode === "move") {
      const m = replacementFor(src.part, src.from + t, null);
      if (m.error) return setEditStatus(m.error, true);
      reps.push(m);
    }
  }
  const verb = mode === "move" ? "移到" : "复制到";
  applyReplacements(
    reps,
    `已把${partName(src.part)}${barLabel(src.from, src.to)}${verb}${partName(target.part)}${barLabel(target.bar, target.bar + n - 1)}`,
    { part: target.part, from: target.bar, to: target.bar + n - 1 },
  );
}

function clearBars(sel) {
  if (!sel) return;
  const reps = [];
  for (let k = sel.from; k <= sel.to; k++) {
    const r = replacementFor(sel.part, k, null);
    if (r.error) return setEditStatus(r.error, true);
    reps.push(r);
  }
  applyReplacements(reps, `已把${partName(sel.part)}${barLabel(sel.from, sel.to)}改为休止`, sel);
}

// ----- 选中 -----

function cellsAt(i, k) {
  return $("now-rows").querySelectorAll(`.sg-cell[data-part="${i}"][data-b="${k}"]`);
}

function selectCell(i, k, extend) {
  const s = edit.sel;
  if (extend && s && s.part === i) edit.sel = { part: i, from: Math.min(s.from, k), to: Math.max(s.to, k) };
  else if (!extend && s && s.part === i && s.from === k && s.to === k) edit.sel = null; // 再点一下取消选中
  else edit.sel = { part: i, from: k, to: k };
  setEditStatus("");
  paintSelection();
}

function paintSelection() {
  const box = $("now-rows");
  for (const c of box.querySelectorAll(".sg-cell.sel")) c.classList.remove("sel");
  const s = edit.sel;
  if (s) for (let k = s.from; k <= s.to; k++) for (const c of cellsAt(s.part, k)) c.classList.add("sel");
  updateEditBar();
}

function setPick(pick) {
  edit.pick = pick;
  $("now-rows").classList.toggle("picking", !!pick);
  updateEditBar();
}

function updateEditBar() {
  const s = edit.sel && state.score ? edit.sel : null;
  for (const id of ["edit-copy-btn", "edit-move-btn", "edit-rest-btn"]) $(id).disabled = !s;
  $("undo-btn").disabled = !edit.history.length;
  $("redo-btn").disabled = !edit.future.length;
  $("edit-copy-btn").setAttribute("aria-pressed", String(edit.pick?.mode === "copy"));
  $("edit-move-btn").setAttribute("aria-pressed", String(edit.pick?.mode === "move"));
  const sel = $("edit-sel");
  if (edit.pick) {
    sel.textContent = `${edit.pick.mode === "move" ? "移动" : "复制"}${partName(s.part)}${barLabel(s.from, s.to)}：请点目标小节（Esc 取消）`;
  } else if (s) {
    sel.textContent = `已选中 ${partName(s.part)}${barLabel(s.from, s.to)}`;
  } else {
    sel.textContent = "";
  }
}

// ----- 撤销 / 重做 -----

function pushHistory() {
  edit.history.push({ text: editor.value, sel: edit.sel });
  if (edit.history.length > HISTORY_MAX) edit.history.shift();
  edit.future = [];
}

function resetHistory() {
  edit.history = [];
  edit.future = [];
  edit.sel = null;
  setPick(null);
  setEditStatus("");
}

function undoEdit() {
  const h = edit.history.pop();
  if (!h) return;
  edit.future.push({ text: editor.value, sel: edit.sel });
  setScoreText(h.text, h.sel);
  setEditStatus("已撤销。");
}

function redoEdit() {
  const h = edit.future.pop();
  if (!h) return;
  edit.history.push({ text: editor.value, sel: edit.sel });
  setScoreText(h.text, h.sel);
  setEditStatus("已重做。");
}

$("undo-btn").addEventListener("click", undoEdit);
$("redo-btn").addEventListener("click", redoEdit);
$("edit-copy-btn").addEventListener("click", () => setPick(edit.pick?.mode === "copy" ? null : { mode: "copy" }));
$("edit-move-btn").addEventListener("click", () => setPick(edit.pick?.mode === "move" ? null : { mode: "move" }));
$("edit-rest-btn").addEventListener("click", () => clearBars(edit.sel));

document.addEventListener("keydown", (e) => {
  if (e.target.closest?.("input, textarea, select, [contenteditable]")) return;
  const mod = e.metaKey || e.ctrlKey;
  if (mod && !e.altKey && e.key.toLowerCase() === "z") {
    e.preventDefault();
    if (e.shiftKey) redoEdit();
    else undoEdit();
  } else if (mod && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "y") {
    e.preventDefault();
    redoEdit();
  } else if (e.key === "Escape" && !mod && (edit.drag || edit.pick || edit.sel)) {
    // 先取消拖拽、选目标、选中；都没有时 Esc 才停止播放（下面的快捷键处理）
    e.stopImmediatePropagation();
    if (edit.drag) cancelDrag();
    else if (edit.pick) setPick(null);
    else {
      edit.sel = null;
      paintSelection();
    }
  }
});

// ----- 拖拽：按住一个小节拖到别的声部上 -----

{
  const box = $("now-rows");
  box.addEventListener("pointerdown", (e) => {
    const cell = e.target.closest(".sg-cell");
    if (!cell || e.button !== 0 || e.pointerType === "touch" || edit.pick) return;
    edit.drag = { cell, x0: e.clientX, y0: e.clientY, id: e.pointerId, started: false, target: null };
  });
  box.addEventListener("pointermove", (e) => {
    const d = edit.drag;
    if (!d) return;
    if (!d.started) {
      if (Math.hypot(e.clientX - d.x0, e.clientY - d.y0) < 6) return;
      beginDrag(d, e);
    }
    moveDrag(d, e);
  });
  const finish = (e, drop) => {
    const d = edit.drag;
    if (!d) return;
    if (!d.started) {
      edit.drag = null;
      return;
    }
    const target = drop ? d.target : null;
    const mode = e.altKey ? "move" : "copy";
    cancelDrag();
    edit.suppressClick = true;
    setTimeout(() => (edit.suppressClick = false), 0);
    if (target) transferBars(d.sel, target, mode);
  };
  box.addEventListener("pointerup", (e) => finish(e, true));
  box.addEventListener("pointercancel", (e) => finish(e, false));
  // 拖的途中按下或松开 Option，提示跟着变
  for (const ev of ["keydown", "keyup"]) {
    document.addEventListener(ev, (e) => {
      if (edit.drag?.started && e.key === "Alt") {
        edit.drag.alt = ev === "keydown";
        moveDrag(edit.drag, null);
      }
    });
  }
}

function beginDrag(d, e) {
  const i = +d.cell.dataset.part, k = +d.cell.dataset.b;
  const s = edit.sel;
  if (!s || s.part !== i || k < s.from || k > s.to) {
    edit.sel = { part: i, from: k, to: k };
    paintSelection();
  }
  d.started = true;
  d.sel = edit.sel;
  d.n = d.sel.to - d.sel.from + 1;
  d.alt = e.altKey;
  d.x = e.clientX;
  d.y = e.clientY;
  $("now-rows").setPointerCapture(d.id);
  d.ghost = Object.assign(document.createElement("div"), { className: "sg-ghost" });
  document.body.append(d.ghost);
  document.body.classList.add("sg-dragging");
  for (let b = d.sel.from; b <= d.sel.to; b++) for (const c of cellsAt(d.sel.part, b)) c.classList.add("dragging");
}

function moveDrag(d, e) {
  if (e) {
    d.x = e.clientX;
    d.y = e.clientY;
    d.alt = e.altKey;
  }
  d.ghost.style.left = `${d.x + 14}px`;
  d.ghost.style.top = `${d.y + 14}px`;
  const under = document.elementFromPoint(d.x, d.y)?.closest(".sg-cell");
  let target = null;
  if (under) {
    const i = +under.dataset.part, k = +under.dataset.b;
    const own = i === d.sel.part && k <= d.sel.to && k + d.n - 1 >= d.sel.from;
    if (!own) target = { part: i, bar: k };
  }
  const changed = (target?.part !== d.target?.part) || (target?.bar !== d.target?.bar);
  if (changed) {
    for (const c of $("now-rows").querySelectorAll(".sg-cell.drop")) c.classList.remove("drop");
    if (target) for (let t = 0; t < d.n; t++) for (const c of cellsAt(target.part, target.bar + t)) c.classList.add("drop");
    d.target = target;
  }
  const verb = d.alt ? "移到" : "复制到";
  const from = `${partName(d.sel.part)}${barLabel(d.sel.from, d.sel.to)}`;
  d.ghost.textContent = target
    ? `${from} → ${verb}${partName(target.part)}${barLabel(target.bar, target.bar + d.n - 1)}`
    : `${from}（拖到别的声部的小节上）`;
  setEditStatus(target ? `松开：${verb}${partName(target.part)}${barLabel(target.bar, target.bar + d.n - 1)}。${d.alt ? "松开 Option 改为复制" : "按住 Option（Alt）改为移动，原小节改成休止"}` : "拖到别的声部的小节上；Esc 取消");
}

function cancelDrag() {
  const d = edit.drag;
  edit.drag = null;
  if (!d?.started) return;
  try { $("now-rows").releasePointerCapture(d.id); } catch {}
  d.ghost.remove();
  document.body.classList.remove("sg-dragging");
  for (const c of $("now-rows").querySelectorAll(".sg-cell.drop, .sg-cell.dragging")) c.classList.remove("drop", "dragging");
  setEditStatus("");
}

// ---------- 播放控制 ----------

for (let t = 12; t >= -12; t--) {
  $("transpose").append(new Option(t === 0 ? "原调" : `${t > 0 ? "升" : "降"} ${Math.abs(t)} 个半音`, t, false, t === 0));
}
$("transpose").addEventListener("change", restartIfPlaying);
$("tempo").addEventListener("input", () => {
  updateTempoLabel();
  renderSummary(state.score || parseScore(""));
});
$("tempo").addEventListener("change", restartIfPlaying);

function updateTempoLabel() {
  const f = +$("tempo").value;
  const bpm = state.score ? Math.round(state.score.meta.tempo * f / 100) : null;
  $("tempo-out").textContent = bpm ? `${f}%（♩=${bpm}）` : `${f}%`;
}

function updateRange() {
  const n = state.score ? state.score.bars.length : 1;
  const from = $("from-bar"), to = $("to-bar");
  from.max = to.max = n;
  const wasFull = +to.value === +to.dataset.n || !to.dataset.n;
  to.dataset.n = n;
  if (wasFull || +to.value > n) to.value = n;
  if (+from.value > n) from.value = 1;
  if (state.pos && state.score && state.pos.beat >= state.score.length) state.pos = null;
  updateTempoLabel();
  renderTimeline();
}

function barCount() {
  return state.score ? state.score.bars.length : 1;
}

// 第 a 到第 b 小节（含）-> 拍
function barRange() {
  const s = state.score;
  const n = s.bars.length;
  const a = Math.min(Math.max(1, parseInt($("from-bar").value) || 1), n);
  const b = Math.min(Math.max(a, parseInt($("to-bar").value) || n), n);
  return { fromBeat: s.bars[a - 1], toBeat: b < n ? s.bars[b] : s.length, fromBar: a, toBar: b };
}

function setRange(a, b) {
  const n = barCount();
  a = Math.min(Math.max(1, a), n);
  b = Math.min(Math.max(1, b), n);
  if (a > b) [a, b] = [b, a];
  $("from-bar").value = a;
  $("to-bar").value = b;
  renderTimeline();
}

function barAt(beat) {
  const bars = state.score.bars;
  let k = 0;
  while (k + 1 < bars.length && bars[k + 1] <= beat + 1e-9) k++;
  return k + 1;
}

function sectionAt(beat) {
  let name = "";
  for (const m of state.score.sectionMarks) if (m.beat <= beat + 1e-9) name = m.name;
  return name;
}

// ----- 进度条 -----

const track = $("tl-track");
const pct = (beat) => `${state.score ? Math.min(100, Math.max(0, (beat / state.score.length) * 100)) : 0}%`;

function renderTimeline() {
  const marks = $("tl-marks");
  marks.innerHTML = "";
  if (!state.score) return;
  const { fromBeat, toBeat } = barRange();
  $("tl-sel").style.left = pct(fromBeat);
  $("tl-sel").style.width = `calc(${pct(toBeat)} - ${pct(fromBeat)})`;
  $("tl-start").style.left = pct(fromBeat);
  $("tl-end").style.left = pct(toBeat);
  if (!engine.playing) updatePosition(state.pos?.beat ?? fromBeat, state.pos?.pass ?? 0);

  const s = state.score;
  const n = s.bars.length;
  const width = track.clientWidth || 600;
  const step = [1, 2, 4, 5, 8, 10, 16, 20, 25, 50, 100].find((k) => (n / k) * 34 <= width) || 200;
  const secBeats = new Set(s.sectionMarks.map((m) => Math.round(m.beat * 1e3)));
  for (let k = 1; k <= n; k += k === 1 ? step - 1 || 1 : step) {
    if (secBeats.has(Math.round(s.bars[k - 1] * 1e3))) continue;
    marks.append(Object.assign(document.createElement("span"), { textContent: k, style: `left:${pct(s.bars[k - 1])}` }));
  }
  for (const m of s.sectionMarks) {
    marks.append(Object.assign(document.createElement("span"), { className: "sec", textContent: m.name, title: `${m.name} 段`, style: `left:${pct(m.beat)}` }));
  }
}
window.addEventListener("resize", renderTimeline);

function beatFromEvent(ev) {
  const r = track.getBoundingClientRect();
  const x = Math.min(Math.max(0, ev.clientX - r.left), r.width);
  return (x / r.width) * state.score.length;
}

let drag = null; // {mode: "start" | "end" | "pending" | "select", x0, anchorBar}
track.addEventListener("pointerdown", (ev) => {
  if (!state.score) return;
  track.setPointerCapture(ev.pointerId);
  const mode = ev.target.id === "tl-start" ? "start" : ev.target.id === "tl-end" ? "end" : "pending";
  drag = { mode, x0: ev.clientX, anchorBar: barAt(beatFromEvent(ev)) };
});
track.addEventListener("pointermove", (ev) => {
  if (!drag) return;
  const beat = beatFromEvent(ev);
  const { fromBar, toBar } = barRange();
  if (drag.mode === "pending" && Math.abs(ev.clientX - drag.x0) > 5) drag.mode = "select";
  if (drag.mode === "start") setRange(Math.min(barAt(beat), toBar), toBar);
  else if (drag.mode === "end") setRange(fromBar, Math.max(barAt(Math.max(0, beat - 1e-3)), fromBar));
  else if (drag.mode === "select") setRange(drag.anchorBar, barAt(beat));
});
track.addEventListener("pointerup", (ev) => {
  if (!drag) return;
  const d = drag;
  drag = null;
  if (d.mode === "pending") {
    // 单击：跳到点中的那一小节
    const bar = barAt(beatFromEvent(ev));
    const { fromBar, toBar } = barRange();
    if (bar < fromBar || bar > toBar) setRange(1, barCount());
    seekTo(state.score.bars[bar - 1]);
  } else {
    state.pos = null;
    renderTimeline();
    if (engine.playing) startPlayback();
  }
});

function seekTo(beat) {
  state.pos = { beat, pass: 0 };
  renderTimeline();
  updatePosition(beat, 0);
  if (engine.playing) startPlayback();
}

for (const id of ["from-bar", "to-bar"]) {
  $(id).addEventListener("change", () => {
    const { fromBar, toBar } = barRange();
    setRange(fromBar, toBar);
    state.pos = null;
    if (engine.playing) startPlayback();
  });
}
$("range-all").addEventListener("click", () => {
  setRange(1, barCount());
  state.pos = null;
  if (engine.playing) startPlayback();
});
$("repeat").addEventListener("change", restartIfPlaying);

function updatePosition(beat, pass) {
  const s = state.score;
  if (!s) return;
  $("tl-head").style.left = pct(beat);
  renderNowPlaying(beat);
  const sec = sectionAt(beat);
  const reps = +$("repeat").value;
  const passText = reps === 1 ? "" : reps === 0 ? ` · 第 ${pass + 1} 遍（循环）` : ` · 第 ${Math.min(pass + 1, reps)}/${reps} 遍`;
  $("position").textContent = `第 ${barAt(beat)} / ${s.bars.length} 小节${sec ? ` · ${sec} 段` : ""}${passText}`;
}

// ----- 播放 / 暂停 / 停止 -----

const playBtn = $("play-btn");
playBtn.addEventListener("click", () => (engine.playing ? pausePlayback() : startPlayback({ countIn: countInSetting() })));

// 预备拍开关、长度和节拍器开关记在浏览器里
const savedCountIn = store.get("jianpu-count-in");
if (savedCountIn !== null) $("count-in").checked = savedCountIn === "1";
$("count-in").addEventListener("change", () => {
  store.set("jianpu-count-in", $("count-in").checked ? "1" : "0");
  $("count-in-len").disabled = !$("count-in").checked;
});
const savedLen = store.get("jianpu-count-in-len");
if (savedLen && [...$("count-in-len").options].some((o) => o.value === savedLen)) $("count-in-len").value = savedLen;
$("count-in-len").disabled = !$("count-in").checked;
$("count-in-len").addEventListener("change", () => store.set("jianpu-count-in-len", $("count-in-len").value));
if (store.get("jianpu-metronome") === "1") $("metronome").checked = true;
$("metronome").addEventListener("change", () => {
  store.set("jianpu-metronome", $("metronome").checked ? "1" : "0");
  restartIfPlaying();
});
$("stop-btn").addEventListener("click", stopPlayback);

// 预备拍设置：{bars: n} 按拍号打 n 小节，{beats: n} 打 n 拍，没勾选就是 null
function countInSetting() {
  if (!$("count-in").checked) return null;
  const [kind, n] = $("count-in-len").value.split(":");
  return kind === "bar" ? { bars: +n } : { beats: +n };
}

// 快捷键：空格 播放/暂停，Esc 停止（光标在文本框、下拉框等控件里时不响应）
document.addEventListener("keydown", (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.target.closest?.("input, textarea, select, button, a, [contenteditable]")) return;
  if (e.code === "Space") {
    e.preventDefault();
    if (!playBtn.disabled) playBtn.click();
  } else if (e.key === "Escape") {
    if (!$("stop-btn").disabled) stopPlayback();
  }
});

// countIn 只在按“播放/继续”时打；播放中换乐器、跳转等重新开始时不打
async function startPlayback({ countIn = null } = {}) {
  if (!state.score) return;
  const { fromBeat, toBeat } = barRange();
  let pos = state.pos;
  if (!pos || pos.beat < fromBeat - 1e-9 || pos.beat >= toBeat - 1e-9) pos = { beat: fromBeat, pass: 0 };
  const reps = +$("repeat").value;
  const remaining = reps === 0 ? 0 : Math.max(1, reps - pos.pass);
  playBtn.disabled = true;
  playBtn.textContent = "加载音色…";
  try {
    const fallback = await engine.play(state.score, currentSettings(), {
      rangeStart: fromBeat, rangeEnd: toBeat, startAt: pos.beat, repeats: remaining, countIn,
      metronome: $("metronome").checked,
    });
    engine.passOffset = pos.pass;
    $("audio-note").textContent = fallback ? "有的乐器音色没能从网络加载，暂时用简单合成音代替。" : "";
    playBtn.textContent = "❚❚ 暂停";
    $("stop-btn").disabled = false;
  } catch (err) {
    playBtn.textContent = "▶ 播放";
    $("audio-note").textContent = `播放失败：${err.message}`;
  } finally {
    playBtn.disabled = false;
  }
}

function pausePlayback() {
  engine.stop();
  $("count-badge").hidden = true;
  playBtn.textContent = "▶ 继续";
}

function stopPlayback() {
  engine.stop();
  $("count-badge").hidden = true;
  state.pos = null;
  playBtn.textContent = "▶ 播放";
  $("stop-btn").disabled = true;
  renderTimeline();
  if (state.score) updatePosition(barRange().fromBeat, 0);
}

let restartTimer = null;
function restartIfPlaying() {
  if (!engine.playing) return;
  clearTimeout(restartTimer);
  restartTimer = setTimeout(startPlayback, 150);
}

engine.onCountIn = (k, n, label) => {
  const badge = $("count-badge");
  badge.hidden = false;
  badge.textContent = `${label}`; // 显示这一拍在小节里数第几，和平时数拍子一样
  $("position").textContent = `预备拍 ${k} / ${n}`;
};

engine.onTick = (beat, pass) => {
  $("count-badge").hidden = true;
  const total = (engine.passOffset || 0) + pass;
  state.pos = { beat, pass: total };
  updatePosition(beat, total);
};
engine.onEnd = () => {
  playBtn.textContent = "▶ 播放";
  $("stop-btn").disabled = true;
  state.pos = null;
  renderTimeline();
  if (state.score) updatePosition(barRange().fromBeat, 0);
};

// ---------- 导出 ----------

function fileBase() {
  return (state.score?.meta.title || "简谱").replace(/[\\/:*?"<>|]/g, "_");
}

function download(blob, name) {
  const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

function audibleParts(settings) {
  return state.score.parts.map((_, i) => i).filter((i) => isAudible(settings, i));
}

$("midi-btn").addEventListener("click", () => {
  const s = currentSettings();
  const on = new Set(audibleParts(s));
  if (!on.size) return ($("export-status").textContent = "没有能听到的声部。");
  download(buildMidi(state.score, s, (i) => on.has(i)), `${fileBase()}.mid`);
});

$("wav-btn").addEventListener("click", () => exportWav(false));
$("wav-each-btn").addEventListener("click", () => exportWav(true));

// ----- 导出 PDF：把整首谱子按纸宽重新排版，交给浏览器的打印对话框（选“存储为 PDF”） -----

const PRINT_WIDTH = 700; // A4 竖放、留 12mm 边距后大约这么宽（像素）

function buildPrintView() {
  const s = state.score;
  const root = Object.assign(document.createElement("div"), { id: "print-root" });
  const head = Object.assign(document.createElement("div"), { className: "print-head" });
  head.append(Object.assign(document.createElement("h1"), { textContent: s.meta.title || "简谱" }));
  const layout = computeLayout(PRINT_WIDTH);
  const names = layout.visible.map((i) => s.parts[i].name).join("、");
  head.append(Object.assign(document.createElement("p"), { className: "print-meta", textContent: `${s.meta.key}　${s.meta.time}　♩=${s.meta.tempo}` }));
  head.append(Object.assign(document.createElement("p"), { className: "print-parts", textContent: names }));
  const back = Object.assign(document.createElement("button"), { className: "print-back", textContent: "返回" });
  back.onclick = closePrintView;
  head.append(back);
  root.append(head);
  if (!layout.visible.length) root.append(Object.assign(document.createElement("p"), { textContent: "所有声部都静音了。" }));
  for (const sys of layout.systems) root.append(renderSystem(sys, layout, false));
  return root;
}

function openPrintView() {
  if (!state.score) return null;
  closePrintView();
  const root = buildPrintView();
  document.body.append(root);
  document.body.classList.add("printing");
  for (const g of root.querySelectorAll(".sg-system")) equalizeRows(g);
  return root;
}

function closePrintView() {
  document.getElementById("print-root")?.remove();
  document.body.classList.remove("printing");
}

$("pdf-btn").addEventListener("click", () => {
  if (!openPrintView()) return;
  $("export-status").textContent = "在打印对话框里选“存储为 PDF”。";
  // 等一帧，让新排的谱面先画出来
  requestAnimationFrame(() => setTimeout(() => window.print(), 50));
});
window.addEventListener("afterprint", closePrintView);

async function exportWav(each) {
  const status = $("export-status");
  const s = currentSettings();
  const on = audibleParts(s);
  if (!on.length) return (status.textContent = "没有能听到的声部。");
  const { fromBeat, toBeat } = barRange();
  const btns = ["wav-btn", "wav-each-btn"].map($);
  btns.forEach((b) => (b.disabled = true));
  try {
    if (each) {
      for (const [k, i] of on.entries()) {
        const name = state.score.parts[i].name;
        status.textContent = `正在生成 ${name}（${k + 1}/${on.length}）…`;
        const blob = await engine.renderWav(state.score, s, fromBeat, toBeat, (j) => j === i);
        download(blob, `${fileBase()}-${name}.wav`);
      }
    } else {
      status.textContent = "正在生成 WAV…";
      const set = new Set(on);
      const blob = await engine.renderWav(state.score, s, fromBeat, toBeat, (j) => set.has(j));
      download(blob, `${fileBase()}.wav`);
    }
    status.textContent = "已导出。";
  } catch (err) {
    status.textContent = `导出失败：${err.message}`;
  } finally {
    btns.forEach((b) => (b.disabled = !state.score));
  }
}

// ---------- 工具 ----------

function beatToSec(score, beat) {
  const f = +$("tempo").value / 100;
  let sec = 0;
  const t = score.tempos;
  for (let i = 0; i < t.length; i++) {
    const end = Math.min(beat, t[i + 1]?.beat ?? Infinity);
    if (end > t[i].beat) sec += ((end - t[i].beat) * 60) / (t[i].bpm * f);
  }
  return sec;
}

function formatTime(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

// ---------- 启动 ----------

if (STATIC) {
  // 没有识谱：藏起第 1 步，后面的步骤号往前挪
  $("upload-card").hidden = true;
  $("text-card").querySelector(".step").textContent = "1";
  $("play-card").querySelector(".step").textContent = "2";
  document.querySelector(".top p").textContent = "选一首谱子，分声部练习或全部合奏；也可以在谱面上把旋律换给别的声部。";
  $("text-card").querySelector("h2 small").textContent = "可以直接修改；“保存”只存在这台电脑的浏览器里";
}

const saved = store.get("jianpu-text");
if (saved) editor.value = saved;
try {
  const cur = JSON.parse(store.get("jianpu-current") || "{}");
  state.currentId = cur.id || null;
  state.savedText = cur.saved ?? null;
} catch {}
onTextChanged();
refreshLibrary();
// 打开 /?print=1 直接看打印排版（不弹打印对话框）；
// 加 &id=我的谱子里的id 打印那一首，&solo=琵琶,笛子 只印这些声部
(async () => {
  const q = new URLSearchParams(location.search);
  if (q.get("print") !== "1") return;
  if (q.get("id")) {
    try {
      const e = await lib.get(q.get("id"));
      if (e.text) {
        editor.value = e.text;
        state.currentId = e.id;
        state.savedText = e.text;
        onTextChanged();
      }
    } catch {}
  }
  if (q.get("solo") && state.score) {
    const names = q.get("solo").split(/[,，、]/).map((s) => s.trim()).filter(Boolean);
    state.score.parts.forEach((p, i) => { settingsFor(p.name, i).solo = names.includes(p.name); });
    renderParts();
  }
  openPrintView();
})();
