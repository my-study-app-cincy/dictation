"""data/sets.json 에 맞춰 음성(audio/)과 목록(audio/index.json), 서비스 워커(sw.js)를 맞춘다.

이미 있는 음성은 그대로 두고 없는 것만 만든다. 안 쓰는 음성 파일은 지운다.
PC(scripts/build_mobile.py)와 GitHub Actions(폰 관리자 화면에서 저장했을 때)가 같이 쓴다.

사용: python tools/sync_audio.py [앱 폴더=이 파일의 상위 폴더]
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import shutil
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import tts  # noqa: E402

RATES = (-30, -20, -10)  # index.html 의 말 빠르기 선택지와 같아야 한다
# 안내 멘트 (app.js 의 LINES 와 같아야 한다)
LINES = {
    "ko": ("받아쓰기를 시작할게요.", "받아쓰기 끝. 정말 수고했어요!", "{n}번."),
    "en": ("Let's start the English test now.", "That's the end of the test. Great job!", "Number {n}."),
}


def jobs_for(sets: list[dict]) -> list[tuple[str, int, bool, str]]:
    """(문장, 빠르기, 띄어 읽기, 언어) — 국어 문장만 띄어 읽고, 영어 단어는 영어 목소리로 그냥 읽는다."""
    jobs = []
    for rate in RATES:
        for lang, (start, end, num) in LINES.items():
            max_n = max((len(s["sentences"]) for s in sets if s.get("lang", "ko") == lang), default=0)
            jobs += [(start, rate, False, lang), (end, rate, False, lang)]
            jobs += [(num.format(n=n), rate, False, lang) for n in range(1, max_n + 1)]
        for s in sets:
            lang = s.get("lang", "ko")
            jobs += [(t, rate, lang == "ko", lang) for t in s["sentences"]]
    return list(dict.fromkeys(jobs))


def audio_key(text: str, rate: int, spaced: bool, lang: str) -> str:
    # app.js 의 audioKey() 와 같아야 한다
    return f"{'en|' if lang == 'en' else ''}{rate}|{'true' if spaced else 'false'}|{text}"


async def sync(root: Path) -> None:
    sets = json.loads((root / "data" / "sets.json").read_text(encoding="utf-8"))
    out = root / "audio"
    out.mkdir(exist_ok=True)
    index_path = out / "index.json"
    old = json.loads(index_path.read_text(encoding="utf-8")) if index_path.exists() else {}

    jobs = jobs_for(sets)
    index: dict[str, dict] = {}
    todo = []
    for job in jobs:
        key, name = audio_key(*job), tts.cache_name(*job)
        prev = old.get(key)
        if prev and prev["url"] == f"audio/{name}" and (out / name).exists():
            index[key] = prev
        else:
            todo.append(job)
    print(f"음성 {len(jobs)}개 중 새로 만들 것 {len(todo)}개")

    sem = asyncio.Semaphore(4)

    async def one(text: str, rate: int, spaced: bool, lang: str):
        async with sem:
            for attempt in range(3):
                try:
                    name, cuts = await tts.synthesize(text, rate, spaced, lang)
                    break
                except Exception:
                    if attempt == 2:
                        raise
                    await asyncio.sleep(2)
        if tts.CACHE_DIR.resolve() != out.resolve():
            shutil.copy2(tts.CACHE_DIR / name, out / name)
        index[audio_key(text, rate, spaced, lang)] = {"url": f"audio/{name}", "cuts": cuts}

    await asyncio.gather(*(one(*j) for j in todo))

    used = {v["url"].split("/", 1)[1] for v in index.values()}
    for f in out.iterdir():
        if f.name != "index.json" and f.name not in used:
            f.unlink()
    index_path.write_text(json.dumps(index, ensure_ascii=False, sort_keys=True), encoding="utf-8", newline="\n")
    write_service_worker(root)


def write_service_worker(root: Path) -> None:
    skip = {".git", ".github", "tools"}
    files = sorted(
        str(p.relative_to(root)).replace("\\", "/")
        for p in root.rglob("*")
        if p.is_file() and not skip & set(p.relative_to(root).parts) and p.name not in ("sw.js", "admin.html")
    )
    digest = hashlib.sha1()
    for f in files:
        digest.update(f.encode())
        digest.update((root / f).read_bytes())
    version = digest.hexdigest()[:10]
    precache = ["./"] + files
    (root / "sw.js").write_text(
        f"""// 자동 생성(tools/sync_audio.py). 한 번 받으면 인터넷 없이도 동작한다.
const CACHE = "dictation-{version}";
const PRECACHE = {json.dumps(precache, ensure_ascii=False)};

self.addEventListener("install", (e) => {{
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
}});

self.addEventListener("activate", (e) => {{
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
}});

self.addEventListener("fetch", (e) => {{
  if (e.request.method !== "GET") return;
  const url = new URL(e.request.url);
  if (url.pathname.endsWith("admin.html")) return;
  const save = (res) => {{
    // 글꼴 같은 외부 파일도 한 번 받으면 저장해 둔다
    if (res.ok || res.type === "opaque") {{
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(e.request, copy));
    }}
    return res;
  }};
  // 음성 파일은 이름이 내용 해시라 바뀌지 않는다: 저장본 먼저
  if (url.pathname.endsWith(".mp3")) {{
    e.respondWith(caches.match(e.request, {{ ignoreSearch: true }}).then((hit) => hit || fetch(e.request).then(save)));
    return;
  }}
  // 화면·데이터는 새 버전이 바로 보이게 인터넷 먼저, 안 되면 저장본
  e.respondWith(
    fetch(e.request, {{ cache: "no-cache" }})
      .then(save)
      .catch(() => caches.match(e.request, {{ ignoreSearch: true }}))
  );
}});
""",
        encoding="utf-8",
        newline="\n",  # PC(Windows)와 GitHub(리눅스)에서 똑같은 파일이 되게
    )
    print(f"서비스 워커 버전 {version}, 파일 {len(files)}개")


if __name__ == "__main__":
    asyncio.run(sync(Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parent.parent))
