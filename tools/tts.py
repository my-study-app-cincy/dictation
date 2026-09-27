"""문장 음성(MP3) 생성 + 디스크 캐시.

기본은 edge-tts(Microsoft 신경망 음성, 키 불필요).
환경변수 CLOVA_CLIENT_ID / CLOVA_CLIENT_SECRET 이 있으면 네이버 CLOVA Voice Premium을 쓴다.

  TTS_VOICE   edge 기본 ko-KR-SunHiNeural, clova 기본 vdain

띄어 읽기(spaced): 단어를 줄바꿈으로 나눠 또렷하게 읽게 하고, edge의 단어 경계 시각으로
단어 사이 조용한 구간(cuts, [끝, 시작] 초)을 돌려준다. 앱이 그 구간을 원하는 쉼 길이로 바꾼다.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
import urllib.parse
import urllib.request
from pathlib import Path

CACHE_DIR = Path(os.getenv("TTS_CACHE_DIR") or Path(__file__).resolve().parent.parent / "data" / "tts")

CLOVA_ID = os.getenv("CLOVA_CLIENT_ID")
CLOVA_SECRET = os.getenv("CLOVA_CLIENT_SECRET")
PROVIDER = "clova" if CLOVA_ID and CLOVA_SECRET else "edge"
VOICE = os.getenv("TTS_VOICE") or ("vdain" if PROVIDER == "clova" else "ko-KR-SunHiNeural")
# 영어 단어 받아쓰기용 (미국식 여자 목소리)
VOICE_EN = os.getenv("TTS_VOICE_EN") or ("clara" if PROVIDER == "clova" else "en-US-JennyNeural")
VOICES = {"ko": VOICE, "en": VOICE_EN}

MIN_GAP = 0.08  # 단어 경계 사이가 이만큼(초) 비어 있어야 쉼 자리로 본다

_locks: dict[str, asyncio.Lock] = {}


def prepare(text: str, spaced: bool, lang: str = "ko") -> str:
    text = " ".join(text.split())
    if lang == "en":
        # "a / an" 처럼 적힌 단어는 "a, an" 으로 둘 다 읽는다 ("slash"라고 읽지 않게)
        text = re.sub(r"\s*/\s*", ", ", text)
    # 끝에 마침표가 있어야 문장 끝 억양이 자연스럽게 내려간다.
    if text and text[-1] not in ".?!":
        text += "."
    if spaced:
        # 줄바꿈으로 단어를 나누면 음높이를 유지한 채 단어마다 또렷하게 읽는다(쉼은 1초쯤 생기는데
        # 앱이 그 조용한 구간을 잘라 원하는 길이로 바꾼다). 쉼표·세미콜론·쉼 없이 이어 읽기는
        # "잊고→깊고", "오후에→고 후에"처럼 앞말에 붙어 들렸다(Whisper로 받아적어 확인).
        text = "\n".join(text.split(" "))
    return text


def cuts_from_words(words: list[tuple[float, float]], spaced: bool = False) -> list:
    """단어 (시작, 끝) 목록에서 쉼 자리를 구한다.

    spaced: 조용한 구간 [앞 단어 끝, 다음 단어 시작] 목록 — 앱이 이 구간을 원하는 쉼 길이로 바꾼다.
    아니면: 쉼 자리(구간 가운데) 목록.
    """
    pairs = [(a_end, b_start) for (_, a_end), (b_start, _) in zip(words, words[1:]) if b_start - a_end >= MIN_GAP]
    if spaced:
        return [[round(a, 3), round(b, 3)] for a, b in pairs]
    return [round((a + b) / 2, 3) for a, b in pairs]


async def _edge(text: str, rate: int, voice: str, spaced: bool = False) -> tuple[bytes, list[float]]:
    import edge_tts

    comm = edge_tts.Communicate(text, voice, rate=f"{rate:+d}%", boundary="WordBoundary")
    audio = bytearray()
    words: list[tuple[float, float]] = []
    async for chunk in comm.stream():
        if chunk["type"] == "audio":
            audio += chunk["data"]
        elif chunk["type"] == "WordBoundary":
            start = chunk["offset"] / 1e7
            words.append((start, start + chunk["duration"] / 1e7))
    audio = bytes(audio)
    if QUESTION_RE.search(text) and words:
        audio = await asyncio.to_thread(_raise_end, audio, *words[-1])
    return audio, cuts_from_words(words, spaced)


QUESTION_RE = re.compile(r"\?\s*$")
RISE = 1.25  # 물음표 문장 끝 음절을 이만큼(약 4반음)까지 점점 올린다


def _raise_end(audio: bytes, last_start: float, last_end: float) -> bytes:
    """물음표 문장의 마지막 음절 음높이를 점점 올린다(edge 한국어 목소리는 의문문 끝이 잘 안 올라간다).

    ffmpeg(rubberband)가 없으면 그대로 둔다.
    """
    import shutil
    import subprocess

    if not shutil.which("ffmpeg"):
        return audio
    try:
        # 단어 경계 시각보다 실제 소리가 조금 더 이어진다: 소리가 실제로 끝나는 곳을 찾는다
        import numpy as np

        pcm = subprocess.run(["ffmpeg", "-v", "error", "-i", "pipe:0", "-f", "s16le", "-ac", "1", "-ar", "16000", "pipe:1"],
                             input=audio, capture_output=True, check=True, timeout=60).stdout
        x = np.abs(np.frombuffer(pcm, np.int16).astype(np.float32) / 32768)
        loud = np.nonzero(x > 0.02)[0]
        if len(loud):
            last_end = max(last_end, loud[-1] / 16000)
    except (subprocess.SubprocessError, OSError, ImportError):
        pass
    t0 = max(last_start, last_end - 0.3)
    steps = 6
    cmds = ";".join(
        f"{t0 + (last_end - t0) * i / steps:.3f} rubberband pitch {1 + (RISE - 1) * i / steps:.4f}" for i in range(1, steps + 1)
    )
    af = f"asendcmd=c='{cmds}',rubberband=pitch=1:pitchq=consistency:formant=preserved"
    try:
        return subprocess.run(
            ["ffmpeg", "-v", "error", "-i", "pipe:0", "-af", af, "-c:a", "libmp3lame", "-b:a", "48k", "-f", "mp3", "pipe:1"],
            input=audio, capture_output=True, check=True, timeout=60,
        ).stdout
    except (subprocess.SubprocessError, OSError):
        return audio


def _clova(text: str, rate: int, voice: str) -> tuple[bytes, list[float]]:
    # CLOVA speed: -5(1.5배 빠름) ~ 5(0.5배 느림). 단어 경계 정보는 없어서 쉼표로만 끊어 읽는다.
    speed = max(-5, min(5, round(-rate / 10)))
    data = urllib.parse.urlencode(
        {"speaker": voice, "text": text, "volume": 0, "speed": speed, "pitch": 0, "format": "mp3"}
    ).encode()
    req = urllib.request.Request(
        "https://naveropenapi.apigw.ntruss.com/tts-premium/v1/tts",
        data=data,
        headers={"X-NCP-APIGW-API-KEY-ID": CLOVA_ID, "X-NCP-APIGW-API-KEY": CLOVA_SECRET},
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return resp.read(), []


def cache_name(text: str, rate: int = -20, spaced: bool = False, lang: str = "ko") -> str:
    """이 설정으로 만든 음성 파일 이름(만들지 않고 이름만 계산)."""
    return _key(prepare(text, spaced, lang), rate, spaced, lang) + ".mp3"


def _key(prepared: str, rate: int, spaced: bool, lang: str) -> str:
    return hashlib.sha1(f"{PROVIDER}|{VOICES[lang]}|{rate}|{spaced}|q{RISE}|{prepared}".encode()).hexdigest()[:16]


async def synthesize(text: str, rate: int = -20, spaced: bool = False, lang: str = "ko") -> tuple[str, list[float]]:
    """(캐시 파일 이름, 쉼 자리 목록)을 돌려준다. 없으면 생성한다."""
    voice = VOICES[lang]
    text = prepare(text, spaced, lang)
    key = _key(text, rate, spaced, lang)
    mp3 = CACHE_DIR / f"{key}.mp3"
    meta = CACHE_DIR / f"{key}.json"

    lock = _locks.setdefault(key, asyncio.Lock())
    async with lock:
        if not (mp3.exists() and meta.exists()):
            CACHE_DIR.mkdir(parents=True, exist_ok=True)
            if PROVIDER == "clova":
                audio, cuts = await asyncio.to_thread(_clova, text, rate, voice)
            else:
                audio, cuts = await _edge(text, rate, voice, spaced)
            tmp = mp3.with_suffix(".part")
            tmp.write_bytes(audio)
            tmp.replace(mp3)
            meta.write_text(json.dumps({"text": text, "cuts": cuts}, ensure_ascii=False), encoding="utf-8")
    return mp3.name, json.loads(meta.read_text(encoding="utf-8"))["cuts"]
