"use strict";

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const icon = (id) => `<svg class="ic"><use href="#i-${id}"/></svg>`;

async function api(url, opts = {}) {
  const r = await fetch(url, opts);
  if (!r.ok) {
    let msg = r.statusText;
    try { msg = (await r.json()).detail || msg; } catch {}
    throw new Error(msg);
  }
  return r.json();
}
const postJSON = (url, body, method = "POST") =>
  api(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

// "server": PC에서 run.py로 띄운 전체 기능 / "static": 휴대폰용(GitHub Pages) — 받아쓰기·직접 채점만
const STATIC = window.APP_MODE === "static";
if (STATIC) document.documentElement.classList.add("static");

// 휴대폰 모드: 완료/점수는 그 기기에만 저장한다
const STATUS_KEY = "dictation-status";
function readStatus() {
  try { return JSON.parse(localStorage.getItem(STATUS_KEY)) || {}; } catch { return {}; }
}
function writeStatus(id, patch) {
  const all = readStatus();
  all[id] = { ...all[id], ...patch };
  try { localStorage.setItem(STATUS_KEY, JSON.stringify(all)); } catch {}
  return all[id];
}

async function fetchSets() {
  if (!STATIC) return api("/api/sets");
  const list = await (await fetch("data/sets.json")).json();
  const status = readStatus();
  return list.map((s) => ({ ...s, ...status[s.id] }));
}

let audioIndex = null;
// 휴대폰 모드 음성 목록의 키 (scripts/build_mobile.py 와 같아야 한다)
const audioKey = (text, rate, spaced, lang) => `${lang === "en" ? "en|" : ""}${rate}|${spaced}|${text}`;

async function speechMeta(text, rate, spaced, lang) {
  if (!STATIC) return api(`/api/speech?text=${encodeURIComponent(text)}&rate=${rate}&spaced=${spaced}&lang=${lang}`);
  audioIndex ||= fetch("audio/index.json").then((r) => r.json());
  const meta = (await audioIndex)[audioKey(text, rate, spaced, lang)];
  if (!meta) throw new Error("준비된 음성이 없어요");
  return meta;
}

// kind: "" | "loading" | "ok" | "error"
function setStatus(el, msg, kind = "") {
  el.textContent = msg;
  el.className = `status ${kind}`;
}

// ---------- 탭 ----------
function showTab(name) {
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
  document.querySelectorAll(".panel").forEach((p) => p.classList.toggle("active", p.id === `tab-${name}`));
  window.scrollTo(0, 0);
}
document.querySelectorAll(".tab").forEach((t) => (t.onclick = () => showTab(t.dataset.tab)));

// ---------- 세트 목록 ----------
let sets = [];
let editingId = null;

async function loadSets() {
  sets = await fetchSets();
  renderSetList();
  for (const sel of [$("#dictSet"), $("#gradeSet")]) {
    const prev = sel.value;
    sel.innerHTML = sets.length
      ? sets.map((s) => `<option value="${s.id}">${esc(s.title)} · ${s.sentences.length}문장</option>`).join("")
      : `<option value="">먼저 문제를 만들어 주세요</option>`;
    if (sets.some((s) => s.id === prev)) sel.value = prev;
    else if (sets.length) sel.value = (sets.find((s) => !s.done) || sets[0]).id; // 아직 안 한 첫 회차
  }
  renderPickers();
  if (!player.running) player.load();
}
const findSet = (id) => sets.find((s) => s.id === id);

// ---------- 회차 고르기 ----------
const roundLabel = (s) => s.title.split(" · ")[0];

const LANG_NAMES = { ko: "국어", en: "영어" };
const langOf = (s) => s?.lang || "ko";

function renderPickers() {
  const langs = [...new Set(sets.map(langOf))];
  document.querySelectorAll(".round-picker").forEach((box) => {
    const sel = $(`#${box.dataset.for}`);
    const cur = findSet(sel.value);
    const lang = langOf(cur);
    // 국어·영어가 둘 다 있으면 위에 전환 버튼을 두고, 고른 언어의 회차만 보여 준다
    const switcher = langs.length > 1
      ? `<div class="lang-switch" style="grid-column:1/-1">${langs
          .map((l) => `<button class="${l === lang ? "active" : ""}" data-lang="${l}">${LANG_NAMES[l]}</button>`)
          .join("")}</div>`
      : "";
    box.innerHTML = sets.length
      ? switcher + sets
          .filter((s) => langOf(s) === lang)
          .map((s) => {
            const status = s.score != null ? `✓ ${s.score}점` : s.done ? "✓ 완료" : "";
            return `<button class="rp ${s.done ? "done" : ""} ${s.id === sel.value ? "active" : ""}" data-id="${s.id}">
              <b class="${roundLabel(s).length > 4 ? "long" : ""}">${esc(roundLabel(s))}</b><small>${status}</small></button>`;
          })
          .join("") + (cur ? `<div class="picker-unit" style="grid-column:1/-1">${esc(cur.title)}</div>` : "")
      : `<div class="empty" style="grid-column:1/-1">먼저 문제 만들기에서 저장해 주세요</div>`;
  });
}

document.querySelectorAll(".round-picker").forEach((box) => {
  box.onclick = (e) => {
    const sel = $(`#${box.dataset.for}`);
    const sw = e.target.closest(".lang-switch button");
    if (sw) {
      const same = sets.filter((s) => langOf(s) === sw.dataset.lang);
      sel.value = (same.find((s) => !s.done) || same[0]).id;
      sel.dispatchEvent(new Event("change"));
      return;
    }
    const b = e.target.closest(".rp");
    if (!b) return;
    sel.value = b.dataset.id;
    sel.dispatchEvent(new Event("change"));
  };
});

function renderSetList() {
  $("#setCount").textContent = sets.length || "";
  const ul = $("#setList");
  if (!sets.length) {
    ul.innerHTML = `<li class="empty">아직 없어요.<br>급수표를 찍거나 위에 직접 적어 저장해 보세요.</li>`;
    return;
  }
  ul.innerHTML = sets
    .map(
      (s) => `<li class="set-item" data-id="${s.id}">
        <div class="set-main">
          <div class="set-title">${esc(s.title)}${langOf(s) === "en" ? `<span class="tag-en">영어</span>` : ""}<small>${s.sentences.length}${langOf(s) === "en" ? "단어" : "문장"}</small></div>
          <div class="set-preview">${esc(s.sentences[0] || "")}</div>
        </div>
        <div class="set-actions">
          <button class="btn sm primary" data-act="play">${icon("volume")}불러주기</button>
          <button class="icon-btn" data-act="edit" aria-label="수정">${icon("pencil")}</button>
          <button class="icon-btn" data-act="del" aria-label="삭제">${icon("trash")}</button>
        </div>
      </li>`
    )
    .join("");
}

$("#setList").onclick = async (e) => {
  const btn = e.target.closest("button");
  if (!btn) return;
  const s = findSet(btn.closest("li").dataset.id);
  if (btn.dataset.act === "play") {
    $("#dictSet").value = s.id;
    $("#gradeSet").value = s.id;
    player.stop();
    player.load();
    showTab("dictate");
  } else if (btn.dataset.act === "edit") {
    fillEditor(s.title, s.sentences, s.id, langOf(s), s.meanings);
    $("#setTitle").scrollIntoView({ behavior: "smooth", block: "center" });
  } else if (btn.dataset.act === "del" && confirm(`'${s.title}'을(를) 지울까요?`)) {
    await api(`/api/sets/${s.id}`, { method: "DELETE" });
    if (editingId === s.id) fillEditor("", [], null);
    await loadSets();
  }
};

// 영어 단어는 한 줄에 "look = 보다" 처럼 뜻을 같이 적을 수 있다(뜻은 채점 화면에만 보인다)
function fillEditor(title, sentences, id, lang = "ko", meanings = []) {
  editingId = id;
  $("#setTitle").value = title;
  $("#setLang").value = lang;
  $("#setSentences").value = sentences.map((s, i) => (meanings?.[i] ? `${s} = ${meanings[i]}` : s)).join("\n");
  $("#editorTitle").textContent = id ? "수정하기" : "확인하고 저장하기";
  updateLineCount();
}

function updateLineCount() {
  const n = $("#setSentences").value.split("\n").filter((l) => l.trim()).length;
  $("#lineCount").textContent = n ? `${n}문장` : "";
}
$("#setSentences").oninput = updateLineCount;

$("#newSet").onclick = () => {
  fillEditor("", [], null);
  $("#foundSets").innerHTML = "";
  setStatus($("#sheetStatus"), "");
  $("#setTitle").focus();
};

$("#saveSet").onclick = async () => {
  const title = $("#setTitle").value.trim() || "새 받아쓰기";
  const lines = $("#setSentences").value.split("\n").map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return alert("문장을 한 개 이상 넣어 주세요.");
  const lang = $("#setLang").value;
  const pairs = lines.map((l) => (lang === "en" ? l.split(/\s*=\s*/) : [l]));
  const body = { title, lang, sentences: pairs.map((p) => p[0]), meanings: pairs.map((p) => p[1] || "") };
  body.id = editingId;
  const saved = editingId
    ? await postJSON(`/api/sets/${editingId}`, body, "PUT")
    : await postJSON("/api/sets", body);
  const split = lang === "en" && !body.id && body.sentences.filter(Boolean).length > 5;
  editingId = saved.id;
  $("#editorTitle").textContent = "수정하기";
  await loadSets();
  markFoundSaved(title);
  if (split) fillEditor("", [], null, "en"); // 나눠 저장했으니 편집 중인 내용은 비운다
  setStatus($("#sheetStatus"), split
    ? `'${title}'을 5개씩 나눠 저장했어요. 다 만들었으면 아래 '아이 폰에 보내기'를 눌러 주세요.`
    : `'${title}' 저장했어요. 다 만들었으면 아래 '아이 폰에 보내기'를 눌러 주세요.`, "ok");
};

// ---------- 아이 폰에 보내기 ----------
async function watchPublish(st) {
  const box = $("#publishStatus"), btn = $("#publishBtn");
  btn.disabled = true;
  while (st.running) {
    setStatus(box, `보내는 중… ${st.log.at(-1) || "GitHub 목록 가져오는 중"}`, "loading");
    await sleep(1500);
    st = await api("/api/publish");
  }
  btn.disabled = false;
  if (st.ok) setStatus(box, "보냈어요! 1~2분 뒤 아이 폰에서 앱을 열면 새 목록이 보여요.", "ok");
  else if (st.ok === false) setStatus(box, `보내지 못했어요: ${st.log.slice(-3).join(" / ")}`, "error");
  await loadSets();
}
if (!STATIC) {
  $("#publishBtn").onclick = async () => watchPublish(await postJSON("/api/publish", {}));
  api("/api/publish").then((st) => st.running && watchPublish(st)).catch(() => {});
}

// ---------- 급수표 OCR ----------
let found = [];

$("#sheetFile").onchange = async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  const status = $("#sheetStatus");
  setStatus(status, "글자를 읽고 있어요… 잠시만 기다려 주세요", "loading");
  $("#foundSets").innerHTML = "";
  try {
    const fd = new FormData();
    fd.append("file", file);
    fd.append("lang", $("#setLang").value);
    const res = await api("/api/ocr/sheet", { method: "POST", body: fd });
    found = res.sets;
    if (!found.length) return setStatus(status, "문장을 찾지 못했어요. 더 가까이, 반듯하게 찍어 주세요.", "error");
    setStatus(status, found.length > 1
      ? `${found.length}개를 찾았어요. 하나씩 눌러 확인하고 저장하세요.`
      : "다 읽었어요. 틀린 글자가 없는지 확인하고 저장하세요.", "ok");
    $("#foundSets").innerHTML = found
      .map((s, i) => `<button class="chip" data-i="${i}">${esc(s.title)} · ${s.sentences.length}${s.lang === "en" ? "단어" : "문장"}</button>`)
      .join("");
    selectFound(0);
  } catch (err) {
    setStatus(status, `읽기 실패: ${err.message}`, "error");
  }
};

function selectFound(i) {
  document.querySelectorAll("#foundSets .chip").forEach((c) => c.classList.toggle("active", +c.dataset.i === i));
  fillEditor(found[i].title, found[i].sentences, null, found[i].lang || $("#setLang").value, found[i].meanings);
}
function markFoundSaved(title) {
  document.querySelectorAll("#foundSets .chip.active").forEach((c) => {
    c.classList.add("saved");
    c.textContent = `✓ ${title}`;
  });
}
$("#foundSets").onclick = (e) => {
  const chip = e.target.closest(".chip");
  if (chip) selectFound(+chip.dataset.i);
};

// ---------- 받아쓰기 (불러주기) ----------
// 안내 멘트 (scripts/build_mobile.py 의 LINES 와 같아야 한다)
const LINES = {
  ko: { start: "받아쓰기를 시작할게요.", num: (n) => `${n}번.`, end: "받아쓰기 끝. 정말 수고했어요!" },
  en: { start: "Let's start the English test now.", num: (n) => `Number ${n}.`, end: "That's the end of the test. Great job!" },
};
class Aborted extends Error {}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RING = 2 * Math.PI * 52;

// Web Audio로 재생한다: 띄어쓰기 자리(cuts)에 정확히 쉼을 넣을 수 있고, 일시정지도 한 번에 된다.
const voice = {
  ctx: null,
  clips: new Map(), // "빠르기|띄어읽기|문장" -> Promise<{buf, cuts}>
  playing: [],

  context() {
    if (!this.ctx) {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      // iPhone 무음 스위치가 켜져 있어도 소리가 나게 한다(Safari 16.4+).
      try { if (navigator.audioSession) navigator.audioSession.type = "playback"; } catch {}
    }
    return this.ctx;
  },

  load(text, spaced, lang = "ko") {
    const rate = +$("#rate").value;
    const key = audioKey(text, rate, spaced, lang);
    if (!this.clips.has(key)) {
      const p = (async () => {
        const meta = await speechMeta(text, rate, spaced, lang);
        const data = await (await fetch(meta.url)).arrayBuffer();
        return { buf: await this.context().decodeAudioData(data), cuts: meta.cuts };
      })();
      p.catch(() => this.clips.delete(key));
      this.clips.set(key, p);
    }
    return this.clips.get(key);
  },

  // clip을 재생하면서 cuts 자리마다 gap초 쉼을 더 넣는다. 끝나거나 stop()되면 resolve.
  // cuts: 쉼 자리(초) 목록, 또는 국어 띄어 읽기면 단어 사이 조용한 구간 [끝, 시작] 목록.
  // 조용한 구간은 앞뒤를 조금만 남기고 잘라 낸 뒤 gap초를 쉰다(원래 1초쯤이라 그대로 두면 너무 길다).
  play({ buf, cuts }, gap = 0) {
    const ctx = this.context();
    const TAIL = 0.06, LEAD = 0.04;
    const parts = [];
    let from = 0;
    for (const c of cuts) {
      let [end, next] = Array.isArray(c) ? [c[0] + TAIL, c[1] - LEAD] : [c, c];
      if (end > next) end = next = (end + next) / 2;
      if (end <= from || next >= buf.duration) continue;
      parts.push([from, end]);
      from = next;
    }
    parts.push([from, buf.duration]);
    return new Promise((resolve) => {
      const entry = { sources: [], resolve };
      let t = ctx.currentTime + 0.05;
      parts.forEach(([a, b], i) => {
        const src = ctx.createBufferSource();
        src.buffer = buf;
        const dur = b - a;
        // 잘라 붙이는 자리는 소리를 살짝 줄였다 키워서 뚝 끊기지 않게 한다
        const g = ctx.createGain();
        const fade = Math.min(0.01, dur / 4);
        if (i > 0) { g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(1, t + fade); }
        if (i < parts.length - 1) { g.gain.setValueAtTime(1, t + dur - fade); g.gain.linearRampToValueAtTime(0, t + dur); }
        src.connect(g).connect(ctx.destination);
        src.start(t, a, dur);
        t += dur + gap;
        entry.sources.push(src);
      });
      entry.sources[entry.sources.length - 1].onended = () => this.finish(entry);
      this.playing.push(entry);
    });
  },

  finish(entry) {
    this.playing = this.playing.filter((e) => e !== entry);
    entry.resolve();
  },

  stop() {
    for (const e of [...this.playing]) {
      for (const s of e.sources) {
        s.onended = null;
        try { s.stop(); } catch {}
      }
      this.finish(e);
    }
  },

  pause() { this.ctx?.suspend(); },
  resume() { this.ctx?.resume(); },
};

const IDLE_TEXT = "시작을 누르면 불러 줄게요";

const player = {
  gen: 0,
  idx: 0,
  paused: false,
  running: false,
  finished: false,
  mode: "idle",
  modeText: IDLE_TEXT,
  sentences: [],
  lang: "ko",

  check(gen) {
    if (gen !== this.gen) throw new Aborted();
  },

  // 고른 세트를 화면에 올려 둔다(시작 전 미리보기)
  load() {
    const s = findSet($("#dictSet").value);
    this.sentences = s ? s.sentences : [];
    this.lang = s?.lang || "ko";
    this.idx = 0;
    this.finished = false;
    this.render();
  },

  setMode(mode, text) {
    this.mode = mode;
    this.modeText = text;
    $("#stage").className = `card stage ${mode}`;
    $("#playerStatus").textContent = this.paused ? "잠깐 멈췄어요" : text;
  },

  setRing(p) {
    const ring = $("#ringFg");
    ring.style.strokeDashoffset = RING * (1 - p);
    ring.classList.toggle("zero", p === 0); // 0%일 때 둥근 끝이 점으로 보이지 않게
  },

  // spaced: 띄어쓰기마다 쉬면서 읽기(국어 받아쓰기 문장용), lang: 목소리 언어
  async say(text, gen, spaced = false, lang = "ko") {
    this.check(gen);
    let clip;
    try {
      clip = await voice.load(text, spaced, lang);
    } catch {
      throw new Error("음성을 불러오지 못했어요. 인터넷 연결을 확인해 주세요.");
    }
    this.check(gen);
    await voice.play(clip, spaced ? +$("#gap").value : 0);
    this.check(gen);
  },

  // 일시정지 중에는 시간이 흐르지 않는 대기. onTick(0..1) 로 진행률 표시.
  async wait(ms, gen, onTick) {
    let done = 0;
    while (done < ms) {
      this.check(gen);
      await sleep(100);
      if (!this.paused) done += 100;
      onTick?.(Math.min(1, done / ms));
    }
    this.check(gen);
  },

  render() {
    const n = this.sentences.length;
    $("#curNum").textContent = n ? Math.min(this.idx + 1, n) : "-";
    $("#totalNum").textContent = n || "-";
    $("#dots").innerHTML = this.sentences
      .map((_, i) => `<i class="${this.finished || i < this.idx ? "done" : i === this.idx ? "cur" : ""}"></i>`)
      .join("");
    const s = this.sentences[this.idx];
    const box = $("#curText");
    box.classList.toggle("en", this.lang === "en");
    if (s && this.lang === "en") {
      // 영어는 원고지 대신 영어 공책(4줄) 위에 쓴다
      box.style.setProperty("--cols", 1);
      box.innerHTML = `<span class="en-word">${esc(s)}</span>`;
    } else if (s) {
      const chars = [...s];
      const cols = Math.min(10, chars.length);
      while (chars.length % cols) chars.push(null); // 마지막 줄은 빈칸으로 채운다
      box.style.setProperty("--cols", cols);
      box.innerHTML = chars
        .map((ch) => (ch === null ? `<span class="cell empty"></span>` : ch === " " ? `<span class="cell sp"></span>` : `<span class="cell">${esc(ch)}</span>`))
        .join("");
    } else {
      box.innerHTML = `<span class="placeholder">받아쓰기를 먼저 만들어 주세요</span>`;
    }
    const playing = this.running && !this.paused;
    const btn = $("#startBtn");
    btn.innerHTML = icon(playing ? "pause" : "play");
    btn.classList.toggle("play", !playing);
    btn.setAttribute("aria-label", !this.running ? "시작" : playing ? "잠깐 멈춤" : "계속");
  },

  prefetch() {
    // 음성을 미리 만들어 두어서 문장 사이에 끊김이 없게 한다.
    const ko = this.lang === "ko";
    const L = LINES[this.lang];
    const jobs = [[L.start, false, this.lang]];
    this.sentences.forEach((s, i) => jobs.push([L.num(i + 1), false, this.lang], [s, ko, this.lang]));
    jobs.push([L.end, false, this.lang]);
    (async () => {
      for (const [t, spaced, lang] of jobs) {
        try { await voice.load(t, spaced, lang); } catch {}
      }
    })();
  },

  async runFrom(i, intro = false) {
    const gen = ++this.gen;
    voice.stop();
    voice.resume();
    this.paused = false;
    this.running = true;
    this.finished = false;
    this.idx = Math.max(0, Math.min(i, this.sentences.length - 1));
    $("#goGrade").classList.add("hidden");
    try {
      if (intro) {
        this.setRing(0);
        this.setMode("listening", "받아쓰기를 시작할게요");
        this.render();
        await this.say(LINES[this.lang].start, gen, false, this.lang);
        await this.wait(800, gen);
      }
      for (; this.idx < this.sentences.length; this.idx++) {
        const s = this.sentences[this.idx];
        const repeat = +$("#repeat").value;
        this.setRing(0);
        this.setMode("listening", "잘 들어 보세요 👂");
        this.render();
        await this.say(LINES[this.lang].num(this.idx + 1), gen, false, this.lang);
        await this.wait(600, gen);
        for (let r = 0; r < repeat; r++) {
          await this.say(s, gen, this.lang === "ko", this.lang);
          if (r < repeat - 1) await this.wait(1800, gen);
        }
        this.setMode("writing", "이제 써 보세요 ✏️");
        // 2학년 기준 한글은 한 글자에 1초, 영어 철자는 한 글자에 1.2초 정도 + 여유
        const letters = s.replace(/\s/g, "").length;
        const base = this.lang === "en" ? 3000 + 1200 * letters : 4000 + 1000 * letters;
        const ms = base * +$("#writeTime").value;
        await this.wait(ms, gen, (p) => this.setRing(p));
      }
      this.idx = this.sentences.length - 1;
      this.finished = true;
      this.setMode("done", "끝! 수고했어요 🎉");
      this.render();
      await this.say(LINES[this.lang].end, gen, false, this.lang);
      $("#goGrade").classList.remove("hidden");
      this.running = false;
      this.render();
    } catch (err) {
      if (!(err instanceof Aborted)) {
        this.running = false;
        this.setMode("error", err.message);
        this.render();
      }
    }
  },

  start() {
    if (!findSet($("#dictSet").value)) return alert("먼저 받아쓰기 문제를 만들어 주세요.");
    this.load();
    voice.context().resume(); // 휴대폰은 버튼을 누른 순간에 오디오를 깨워야 한다
    this.prefetch();
    this.runFrom(0, true);
  },

  togglePause() {
    if (!this.running) return;
    this.paused = !this.paused;
    if (this.paused) voice.pause();
    else voice.resume();
    this.setMode(this.mode, this.modeText);
    this.render();
  },

  stop() {
    this.gen++;
    voice.stop();
    this.running = false;
    this.paused = false;
    this.finished = false;
    this.setRing(0);
    this.setMode("idle", IDLE_TEXT);
    this.render();
  },

  jump(delta) {
    if (!this.sentences.length) return;
    voice.context().resume();
    if (!this.running) this.prefetch();
    this.runFrom(this.idx + delta);
  },
};

$("#startBtn").onclick = () => (player.running ? player.togglePause() : player.start());
$("#restartBtn").onclick = () => player.start();
$("#stopBtn").onclick = () => player.stop();
$("#replayBtn").onclick = () => player.jump(0);
$("#prevBtn").onclick = () => player.jump(-1);
$("#nextBtn").onclick = () => player.jump(1);
$("#showText").onchange = (e) => $("#curText").classList.toggle("hidden-text", !e.target.checked);
$("#dictSet").onchange = () => {
  player.stop();
  player.load();
  $("#gradeSet").value = $("#dictSet").value;
  renderPickers();
};
$("#gradeSet").onchange = () => {
  gradeState = null;
  $("#gradeItems").innerHTML = "";
  $("#scoreBox").classList.add("hidden");
  setStatus($("#gradeStatus"), "");
  renderPickers();
};
$("#goGrade").onclick = () => {
  $("#gradeSet").value = $("#dictSet").value;
  showTab("grade");
};

function updateSettingsSummary() {
  const txt = (id) => $(id).selectedOptions[0].textContent;
  $("#settingsSummary").textContent =
    `${txt("#rate")} · 쉼 ${txt("#gap")} · ${txt("#repeat")} 반복 · 쓰기 ${txt("#writeTime")}`;
}
for (const id of ["#rate", "#gap", "#repeat", "#writeTime"]) {
  $(id).addEventListener("change", updateSettingsSummary);
}
$("#rate").addEventListener("change", () => player.running && player.prefetch());
updateSettingsSummary();

if (STATIC) {
  $("#voiceInfo").textContent = "목소리: Microsoft ko-KR-SunHiNeural (미리 만들어 둔 음성)";
  showTab("dictate");
  if ("serviceWorker" in navigator) {
    // 새 버전이 설치되면 한 번 새로 고쳐 바로 보이게 한다
    const hadController = !!navigator.serviceWorker.controller;
    let reloaded = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (hadController && !reloaded) { reloaded = true; location.reload(); }
    });
    navigator.serviceWorker.register("sw.js", { updateViaCache: "none" }).catch(() => {});
  }
} else {
  api("/api/tts/info")
    .then((i) => ($("#voiceInfo").textContent = `목소리: ${i.provider === "clova" ? "네이버 CLOVA" : "Microsoft"} ${i.voice}`))
    .catch(() => {});
}

// ---------- 채점 ----------
let gradeState = null; // {set, written[], image, answers[]}

$("#printSheet").onclick = () => {
  const s = findSet($("#gradeSet").value);
  window.open(`sheet.html?n=${s ? s.sentences.length : 10}&title=${encodeURIComponent(s ? s.title : "")}`, "_blank");
};

$("#answerFile").onchange = async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  const s = findSet($("#gradeSet").value);
  if (!file || !s) return;
  const status = $("#gradeStatus");
  setStatus(status, "답안지를 읽고 있어요… 잠시만 기다려 주세요", "loading");
  try {
    const fd = new FormData();
    fd.append("file", file);
    fd.append("n", s.sentences.length);
    const res = await api("/api/ocr/answers", { method: "POST", body: fd });
    const img = new Image();
    img.src = res.image;
    await img.decode();
    gradeState = { set: s, image: img, answers: res.answers, written: res.answers.map((a) => a.text) };
    setStatus(status, "읽은 글자가 사진과 같은지 확인해 주세요. 고치면 바로 다시 채점돼요.");
    buildGradeCards();
    await regrade();
  } catch (err) {
    setStatus(status, `읽기 실패: ${err.message}`, "error");
  }
};

$("#manualGrade").onclick = async () => {
  const s = findSet($("#gradeSet").value);
  if (!s) return;
  gradeState = { set: s, image: null, answers: s.sentences.map(() => ({ boxes: [], score: 1 })), written: s.sentences.map(() => "") };
  setStatus($("#gradeStatus"), "아이가 쓴 그대로 입력해 주세요.");
  buildGradeCards();
  await regrade();
  $("#gradeItems input")?.focus();
};

for (const id of ["#chkSpacing", "#chkPunct"]) $(id).onchange = () => gradeState && regrade();

function cropCanvas(img, boxes) {
  if (!img || !boxes.length) return null;
  const pad = 12;
  const x1 = Math.max(0, Math.min(...boxes.map((b) => b[0])) - pad);
  const y1 = Math.max(0, Math.min(...boxes.map((b) => b[1])) - pad);
  const x2 = Math.min(img.naturalWidth, Math.max(...boxes.map((b) => b[2])) + pad);
  const y2 = Math.min(img.naturalHeight, Math.max(...boxes.map((b) => b[3])) + pad);
  const c = document.createElement("canvas");
  c.width = x2 - x1;
  c.height = y2 - y1;
  c.getContext("2d").drawImage(img, x1, y1, c.width, c.height, 0, 0, c.width, c.height);
  c.className = "crop";
  return c;
}

function buildGradeCards() {
  const wrap = $("#gradeItems");
  wrap.innerHTML = "";
  const { set, answers, image } = gradeState;
  set.sentences.forEach((_, i) => {
    const a = answers[i];
    const lowconf = a.text !== undefined && a.score < 0.8;
    const card = document.createElement("div");
    card.className = "card item";
    card.innerHTML = `
      <div class="item-head"><span class="mark">${i + 1}</span><span class="badge"></span>${
        set.meanings?.[i] ? `<span class="meaning">뜻: ${esc(set.meanings[i])}</span>` : ""}</div>
      <div class="crop-slot"></div>
      <span class="field-label">아이가 쓴 글 <small>${image ? "읽은 결과 · 다르면 고쳐 주세요" : ""}</small></span>
      <input type="text" value="${esc(gradeState.written[i])}" ${lowconf ? 'class="lowconf"' : ""} placeholder="아이가 쓴 그대로">
      ${lowconf ? '<div class="note">사진이 흐릿해요. 한 번 확인해 주세요</div>' : ""}
      <div class="compare">
        <div class="row written"><span class="tag">쓴 글</span><span class="marks"></span></div>
        <div class="row expected"><span class="tag">정답</span><span class="marks"></span></div>
      </div>
      <div class="note spacing"></div>`;
    const crop = cropCanvas(image, a.boxes || []);
    if (crop) $(".crop-slot", card).append(crop);
    let t;
    $("input", card).oninput = (e) => {
      gradeState.written[i] = e.target.value;
      clearTimeout(t);
      t = setTimeout(regrade, 350);
    };
    wrap.append(card);
  });
}

const marksHtml = (marks) => marks.map((m) => (m.ok ? esc(m.t) : `<span class="x">${esc(m.t)}</span>`)).join("");

// 채점 점수를 회차에 남겨 둔다(고칠 때마다 바뀌므로 잠깐 모았다가 저장)
let scoreTimer;
function saveScore(set, score) {
  clearTimeout(scoreTimer);
  scoreTimer = setTimeout(async () => {
    const saved = STATIC
      ? writeStatus(set.id, { score, done: true })
      : await postJSON(`/api/sets/${set.id}`, { score }, "PATCH");
    Object.assign(findSet(set.id) || {}, saved);
    renderPickers();
    renderSetList();
  }, 800);
}

function scoreMessage(score) {
  if (score === 100) return "참 잘했어요! 💯";
  if (score >= 80) return "잘했어요! 👏";
  if (score >= 60) return "조금만 더 힘내요! 💪";
  return "다시 도전해 봐요! 🌱";
}

async function regrade() {
  const res = Grading.grade(
    gradeState.set.sentences, gradeState.written, $("#chkSpacing").checked, $("#chkPunct").checked, gradeState.set.lang || "ko");
  const box = $("#scoreBox");
  const wasHidden = box.classList.contains("hidden");
  box.classList.remove("hidden");
  if (!wasHidden && $("#scoreVal").textContent !== String(res.score)) {
    // 점수가 바뀌면 도장을 다시 찍는다
    const stamp = $(".stamp", box);
    stamp.style.animation = "none";
    void stamp.offsetWidth;
    stamp.style.animation = "";
  }
  $("#scoreVal").textContent = res.score;
  $("#scoreMsg").textContent = scoreMessage(res.score);
  $("#scoreSub").textContent = `${res.total}문제 중 ${res.correct}개 맞았어요`;
  if (gradeState.written.some((w) => w.trim())) saveScore(gradeState.set, res.score);
  [...$("#gradeItems").children].forEach((card, i) => {
    const it = res.items[i];
    card.classList.toggle("ok", it.correct);
    card.classList.toggle("bad", !it.correct);
    const badge = $(".badge", card);
    badge.className = `badge ${it.correct ? "ok" : "bad"}`;
    badge.textContent = it.correct ? "맞았어요" : it.empty ? "빈칸" : "틀렸어요";
    $(".written .marks", card).innerHTML = marksHtml(it.written_marks);
    $(".expected .marks", card).innerHTML = marksHtml(it.expected_marks);
    $(".spacing", card).textContent =
      it.chars_ok && !it.spacing_ok ? "띄어쓰기가 정답과 달라 보여요 (사진으로 확인해 주세요)" : "";
  });
}

loadSets();
