// 받아쓰기 채점: 정답 문장과 아이가 쓴 문장을 글자 단위로 비교한다.
// 서버 없이 휴대폰에서 돌아가야 해서 브라우저에서 계산한다. (node 테스트: tests/grading.test.mjs)
(function (root) {
  "use strict";

  const PUNCT = /[^\p{L}\p{N}\p{M}_\s]/gu;

  function normalize(s, keepPunct) {
    s = s.normalize("NFC");
    if (!keepPunct) s = s.replace(PUNCT, "");
    return s.replace(/\s+/g, " ").trim();
  }

  // 공백을 뺀 글자 인덱스 기준으로 '이 글자 뒤에 띄어씀' 위치
  function spacePositions(s) {
    const pos = [];
    let n = 0;
    for (const ch of s) {
      if (ch === " ") pos.push(n);
      else n++;
    }
    return pos.join(",");
  }

  // 최장 공통 부분열로 두 글자 배열을 맞춘다. ops: ["eq"|"del"|"ins", i, j]
  function align(a, b) {
    const n = a.length, m = b.length;
    const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
    for (let i = n - 1; i >= 0; i--)
      for (let j = m - 1; j >= 0; j--)
        dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    const ops = [];
    let i = 0, j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && a[i] === b[j]) ops.push(["eq", i++, j++]);
      else if (j < m && (i === n || dp[i][j + 1] >= dp[i + 1][j])) ops.push(["ins", i, j++]);
      else ops.push(["del", i++, j]);
    }
    return ops;
  }

  // 공백 포함 문자열을 [{t, ok}] 조각으로 (bad는 공백 제외 인덱스)
  function marks(s, bad) {
    const out = [];
    let n = 0;
    for (const ch of s) {
      let ok = true;
      if (ch !== " ") ok = !bad.has(n++);
      const last = out[out.length - 1];
      if (last && last.ok === ok) last.t += ch;
      else out.push({ t: ch, ok });
    }
    return out;
  }

  function gradeItem(expected, written, checkSpacing = false, checkPunct = false) {
    const e = normalize(expected, checkPunct);
    const w = normalize(written, checkPunct);
    const ec = [...e.replace(/ /g, "")];
    const wc = [...w.replace(/ /g, "")];

    const badE = new Set();
    const badW = new Set();
    let run = null; // 연속으로 다른 구간
    const flush = () => {
      // 아이가 글자를 더 쓰기만 한 구간이면 정답 쪽 인접 글자를 표시한다
      if (run && run.ins && !run.del && ec.length) badE.add(Math.min(run.at, ec.length - 1));
      run = null;
    };
    for (const [op, i, j] of align(ec, wc)) {
      if (op === "eq") { flush(); continue; }
      run = run || { at: i, ins: false, del: false };
      if (op === "del") { badE.add(i); run.del = true; }
      else { badW.add(j); run.ins = true; }
    }
    flush();

    const charsOk = wc.length > 0 && ec.join("") === wc.join("");
    const spacingOk = charsOk && spacePositions(e) === spacePositions(w);
    return {
      correct: charsOk && (spacingOk || !checkSpacing),
      chars_ok: charsOk,
      spacing_ok: spacingOk,
      empty: wc.length === 0,
      expected_marks: marks(e, badE),
      written_marks: marks(w, badW),
    };
  }

  function grade(expected, written, checkSpacing = false, checkPunct = false) {
    const items = expected.map((e, i) => gradeItem(e, written[i] || "", checkSpacing, checkPunct));
    const correct = items.filter((it) => it.correct).length;
    const total = items.length;
    return { items, correct, total, score: total ? Math.round((100 * correct) / total) : 0 };
  }

  const Grading = { normalize, gradeItem, grade };
  root.Grading = Grading;
  if (typeof module !== "undefined") module.exports = Grading;
})(typeof window !== "undefined" ? window : globalThis);
