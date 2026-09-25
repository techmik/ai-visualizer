#!/usr/bin/env python3
# ai-visualizer: give your AI agent a face.
# Copyright (C) 2026 Jared Rhodenizer
#
# This program is free software: you can redistribute it and/or modify
# it under the terms of the GNU Affero General Public License as published
# by the Free Software Foundation, either version 3 of the License, or
# (at your option) any later version.
#
# This program is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
# GNU Affero General Public License for more details.
#
# You should have received a copy of the GNU Affero General Public License
# along with this program. If not, see <https://www.gnu.org/licenses/>.
#
# SPDX-License-Identifier: AGPL-3.0-or-later
"""ai-visualizer server. Python standard library only, nothing to install.

Serves the face gallery at http://127.0.0.1:8790/ and exposes:

  /state   polled by the faces (~8x/sec):
           {"state":  "idle|listening|thinking|speaking",
            "level":  0.0-1.0,       voice loudness while speaking
            "samples": [64 floats],  raw waveform snapshot (0s when quiet)
            "alert":  bool,          optional attention signal
            "loading": bool,         true while the voice line plays its
                                     own thinking sound (we stay quiet)
            "context": {used,max,pct},  context-window fill, after each turn
                                     (empty until the first turn publishes)
            "permission": {id,tool,what,detail,phase}}  present only while
                                     a permission ask waits; the chat box
                                     draws an approve/deny card and answers
                                     via /send ("yes"/"no"/"details")
  /panels  polled by the side panels (core.js: panelsInit()) about once a
           minute: {"cards": [{id, side, title, rows: [{label, value,
           pct?, hot?}], note?}]}. OPT-IN via "panels" in
           ai-visualizer.json (off by default). Every source is optional
           and refreshed on a background thread, so this route only ever
           returns a cache and never waits on the network:
             weather     Open-Meteo, no key  ("weather": {lat, lon, label})
             calendar    any command printing {"events": [{summary,
                         start, end}]} ("calendar": {"command": [...]})
             priorities  bold lead-ins from a markdown list
                         ("priorities": {file, sections?, max?,
                         per_section?})
             jobs        any program can drop .voice_panel_<name>.json on
                         the bus in the card shape above (plus optional
                         "expires", a unix epoch) and it shows up as a card.
                         Delete the file to remove the card.
  /config  the merged ai-visualizer.json plus the list of installed
           faces, discovered by scanning the faces/ folder. Drop a new
           folder with an index.html into faces/ and it appears in the
           gallery. That is the whole plugin system.
  /transcript  GET, polled by the chat box each face carries (core.js:
           chatInit()): the running conversation as a JSON array of
           {ts, role, text}, sourced from .voice_transcript.jsonl.
  /send    POST {"text": "..."}, the chat box's other half: drops the
           message into .voice_inbox/ for backtalk's own poller to pick
           up and answer, same as typing in its terminal. The one WRITE
           this server does to the bus.
  /attach  POST raw file bytes, original name in the X-Filename header
           (percent-encoded). Saves the upload under .voice_attachments/
           beside the bus and returns {"ok", "path", "name"} — the chat
           box appends that absolute path to the outgoing message as an
           [Attached file: ...] line so the agent can just open it.
           Uploads older than 7 days are pruned whenever a new one lands.
  /suggest POST {"turns": [{role, text}, ...]}, returns {"suggestion": "..."}.
           OPT-IN and off by default: only does anything when "suggest_replies"
           is true in ai-visualizer.json AND GEMINI_API_KEY is in the
           environment. Asks a small, cheap model for the single most likely
           next thing the user would type; the chat box shows it as ghost
           text (Tab fills it into the box, Enter still sends). A no-op —
           returns "" — when disabled or unconfigured, so a voice-only
           session that never opens the chat box never spends anything.

Otherwise READ-ONLY on the signal bus. The bus is written by a voice
line (backtalk writes it natively, github.com/jaredrhod/backtalk):

  .voice_state        idle | listening | thinking | working | speaking
                      ("working" = a tool is actually running)
  .voice_waveform     JSON {ts, samples: [64 floats]} while audio plays
  .voice_loading_pid  exists while the voice line plays a thinking sound
  .voice_alert        optional: non-empty file = attention needed
  .voice_context      optional: JSON {used, max, pct} context-window fill
  .voice_permission   optional: JSON {ts,id,tool,what,detail,phase} — present
                      only while a permission ask waits for an answer
  .voice_transcript.jsonl  one JSON object per line, {ts, role, text}

Where the bus lives comes from "bus_dir" in ai-visualizer.json (default:
this folder). Point it at your backtalk folder, or point backtalk's
"signals_dir" here. Either direction works.

Run:
  python3 server.py             the real bus
  python3 server.py --mock speaking
                                no voice line needed: /state synthesizes
                                the chosen state (idle|listening|thinking
                                |speaking) so you can see a face perform
  python3 server.py --no-open   do not auto-open the browser
Ctrl-C stops.
"""
import json
import math
import mimetypes
import os
import re
import sys
import threading
import time
import webbrowser
import urllib.parse
import urllib.request
import errno
import glob
import subprocess
from datetime import datetime, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
STATES = {"idle", "listening", "thinking", "working", "speaking"}
WAVEFORM_STALE_S = 0.6

DEFAULTS = {
    "name": "JARVIS",       # shown on the chip / headers, yours to change
    "badge": "",            # optional handle shown in some faces' chrome
    "face": "board",        # the default face the root URL opens
    "port": 8790,
    "bus_dir": "",          # where the .voice_* files live ("" = here)
    "thinking_sound": True, # play assets/thinking.wav while thinking
    "suggest_replies": False,  # opt-in ghost-text next-reply suggestions in
                               # the chat box; also needs GEMINI_API_KEY in
                               # the environment. Off => /suggest is a no-op.
    "chat_width": 960,      # chat box width in px; the side panels share
                            # what's left, so smaller screens want less
}


def load_config():
    cfg = dict(DEFAULTS)
    try:
        user = json.loads((HERE / "ai-visualizer.json").read_text())
        for k, v in user.items():
            cfg[k] = v
    except FileNotFoundError:
        pass
    except ValueError as e:
        print(f"[config] ai-visualizer.json is not valid JSON ({e}), "
              f"using defaults")
    return cfg


CFG = load_config()
BUS = Path(CFG["bus_dir"]).expanduser() if CFG.get("bus_dir") else HERE

# Chat-box file attachments land here, next to the signal bus. Kept out of
# the bus contract on purpose: backtalk never reads these, the agent does
# (by the absolute path the chat box hands it). Pruned by age, not size.
ATTACH_DIR = BUS / ".voice_attachments"
ATTACH_MAX_BYTES = 25 * 1024 * 1024
ATTACH_MAX_AGE_S = 7 * 86400
_ATTACH_BAD = re.compile(r"[^A-Za-z0-9._ -]+")

MOCK = None
NO_OPEN = "--no-open" in sys.argv
if "--mock" in sys.argv:
    i = sys.argv.index("--mock")
    MOCK = sys.argv[i + 1] if len(sys.argv) > i + 1 else "speaking"
    if MOCK not in STATES and MOCK != "permission":
        MOCK = "speaking"
PORT = int(CFG.get("port", 8790))
if "--port" in sys.argv:
    i = sys.argv.index("--port")
    PORT = int(sys.argv[i + 1])


def list_faces():
    faces = []
    fdir = HERE / "faces"
    if fdir.is_dir():
        for p in sorted(fdir.iterdir()):
            if p.is_dir() and (p / "index.html").exists():
                meta = {"id": p.name, "title": p.name.title(), "tagline": ""}
                try:
                    meta.update(json.loads((p / "face.json").read_text()))
                except (OSError, ValueError):
                    pass
                meta["id"] = p.name
                faces.append(meta)
    return faces


def mock_bus():
    t = time.time()
    level = 0.0
    samples = [0.0] * 64
    if MOCK == "speaking":
        level = abs(math.sin(t * 6.0)) * 0.85
        samples = [
            (math.sin(i * 0.55 + t * 9.0) * 0.6
             + math.sin(i * 1.7 - t * 13.0) * 0.4)
            * 9000.0 * (0.35 + 0.65 * abs(math.sin(t * 2.6)))
            for i in range(64)
        ]
    # ?mock=permission previews the approve/deny card with no voice line.
    permission = {}
    if MOCK == "permission":
        permission = {"ts": t, "id": "mock", "tool": "Bash", "phase": "ask",
                      "what": "run a git command in the terminal",
                      "detail": "run a command: git push origin ibuy-custom"}
    return {"state": "thinking" if MOCK == "permission" else MOCK,
            "level": level, "samples": samples,
            "alert": False, "loading": MOCK == "thinking",
            # Faked so the usage + context readouts can be looked at
            # without spending a real session to make them appear.
            "rate_limits": {
                "five_hour": {"utilization": 0.34, "resets_at": t + 9200},
                "seven_day": {"utilization": 0.61, "resets_at": t + 288000},
            },
            "context": {"used": 47000, "max": 200000, "pct": 23.5},
            "permission": permission}


def read_bus():
    if MOCK:
        return mock_bus()
    try:
        state = (BUS / ".voice_state").read_text().strip().lower()
        if state not in STATES:
            state = "idle"
    except OSError:
        state = "idle"
    level = 0.0
    samples = [0.0] * 64
    try:
        payload = json.loads((BUS / ".voice_waveform").read_text())
        age = time.time() - float(payload.get("ts", 0))
        raw = payload.get("samples") or []
        if raw and age < WAVEFORM_STALE_S:
            # A fresh waveform IS speech, whatever the state file says.
            state = "speaking"
            samples = [float(s) for s in raw[:64]]
            mean = sum(abs(s) for s in samples) / len(samples)
            level = min(1.0, mean / 3000.0)
    except (OSError, ValueError, KeyError, TypeError):
        pass
    try:
        alert = (BUS / ".voice_alert").stat().st_size > 0
    except OSError:
        alert = False
    loading = (BUS / ".voice_loading_pid").exists()
    # Absent unless the voice line was told to publish it, which is the
    # normal case: it is the account holder's own spend and it stays off
    # until asked for. An empty dict simply means no readout.
    rate_limits = {}
    try:
        rate_limits = json.loads((BUS / ".voice_rate_limits").read_text())
    except (OSError, ValueError):
        pass
    # Context-window fill, published after every turn. Always on (it is
    # not account spend), empty until the first turn writes it.
    context = {}
    try:
        context = json.loads((BUS / ".voice_context").read_text())
    except (OSError, ValueError):
        pass
    # Present only while a permission ask is waiting for an answer; the
    # voice line removes the file the instant it resolves. A face draws
    # an approve/deny card off this and answers via /send ("yes"/"no").
    permission = {}
    try:
        permission = json.loads((BUS / ".voice_permission").read_text())
    except (OSError, ValueError):
        pass
    # What the session is LIVE on (model/effort/mode/mic), rewritten by the
    # voice line on every runtime switch. Empty from an older voice line
    # that never writes it; faces then fall back to /config's agent meta.
    session = {}
    try:
        session = json.loads((BUS / ".voice_session").read_text())
    except (OSError, ValueError):
        pass
    return {"state": state, "level": level, "samples": samples,
            "alert": alert, "loading": loading, "rate_limits": rate_limits,
            "context": context, "permission": permission,
            "session": session}


def read_transcript():
    try:
        lines = (BUS / ".voice_transcript.jsonl").read_text(
            encoding="utf-8").splitlines()
    except OSError:
        return []
    out = []
    for line in lines:
        if not line.strip():
            continue
        try:
            out.append(json.loads(line))
        except ValueError:
            pass
    return out


def read_agent_meta():
    """Best-effort read of the voice line's own config (backtalk.json), which
    lives beside the bus, so a face can show which model/effort/mode is
    driving it -- the same info the Claude Code desktop app shows under its
    input. Missing or unreadable -> the documented backtalk defaults.

    Reflects startup config only: backtalk's runtime /model and /effort
    slash commands change the live values without writing anything to disk.
    The desktop app's indicator behaves the same way in practice.
    """
    cfg = {}
    try:
        cfg = json.loads((BUS / "backtalk.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        pass
    if not isinstance(cfg, dict):
        cfg = {}
    return {
        "model": cfg.get("model") or "claude-sonnet-5",
        "effort": cfg.get("effort") or "",
        "mode": cfg.get("permission_mode") or "ask",
        "name": cfg.get("name") or CFG["name"],
    }


def _safe_attach_name(raw):
    """A filename from an untrusted header -> a bare, boring basename.
    Strips any path, replaces anything outside [A-Za-z0-9._ -], never
    empty, length-capped keeping the extension."""
    base = os.path.basename((raw or "").replace("\\", "/")).strip()
    base = _ATTACH_BAD.sub("_", base).strip("._ ")
    if not base:
        base = "file"
    if len(base) > 120:
        stem, dot, ext = base.rpartition(".")
        base = stem[:110] + dot + ext[:9] if dot else base[:120]
    return base


def _prune_attachments():
    """Delete uploads older than ATTACH_MAX_AGE_S. Best-effort, called
    just before each new upload lands so the folder can't grow forever."""
    now = time.time()
    try:
        entries = list(ATTACH_DIR.iterdir())
    except OSError:
        return
    for p in entries:
        try:
            if p.is_file() and now - p.stat().st_mtime > ATTACH_MAX_AGE_S:
                p.unlink()
        except OSError:
            pass


def save_attachment(raw_name, data):
    """Write one upload under ATTACH_DIR, return its absolute path (str).
    Timestamp-prefixed so names never collide and the folder sorts by
    arrival."""
    ATTACH_DIR.mkdir(parents=True, exist_ok=True)
    _prune_attachments()
    fname = _safe_attach_name(raw_name)
    stamp = time.strftime("%Y%m%d-%H%M%S")
    target = ATTACH_DIR / f"{stamp}-{fname}"
    n = 1
    while target.exists():
        target = ATTACH_DIR / f"{stamp}-{n}-{fname}"
        n += 1
    tmp = target.with_name(target.name + ".tmp")
    tmp.write_bytes(data)
    tmp.replace(target)
    return str(target)


# --- optional ghost-text reply suggestions (opt-in, see /suggest above) -------
# Deliberately a small, cheap model reached over plain urllib (stdlib only,
# same shape as backtalk's ask_gemini.py). Every failure path — disabled, no
# key, network, bad response, timeout — returns "" and the chat box simply
# shows no ghost. It must never raise and never block a face's own polling
# (the server is threaded, so one slow /suggest doesn't stall /state).
SUGGEST_MODEL = "gemini-3.5-flash-lite"
SUGGEST_URL = ("https://generativelanguage.googleapis.com/v1beta/models/"
               f"{SUGGEST_MODEL}:generateContent")
SUGGEST_MAX_TURNS = 8
SUGGEST_TIMEOUT_S = 8
SUGGEST_PROMPT = (
    "Predict what the USER types next in this conversation with their AI "
    "assistant. Output only that message: first person as the user, one "
    "line, at most 15 words, no surrounding quotes, no preamble. If nothing "
    "is clearly likely, output nothing.\n\n"
)


def suggest_enabled():
    return bool(CFG.get("suggest_replies")) and \
        bool(os.environ.get("GEMINI_API_KEY"))


def suggest_reply(turns):
    """One predicted next user message, or "". Never raises."""
    if not suggest_enabled():
        return ""
    try:
        convo = []
        for t in list(turns or [])[-SUGGEST_MAX_TURNS:]:
            if not isinstance(t, dict):
                continue
            who = "User" if t.get("role") == "user" else "Assistant"
            text = " ".join(str(t.get("text", "")).split())[:600]
            if text:
                convo.append(f"{who}: {text}")
        if not convo:
            return ""
        body = json.dumps({
            "contents": [{"parts": [
                {"text": SUGGEST_PROMPT + "\n".join(convo)}]}],
            "generationConfig": {"maxOutputTokens": 120, "temperature": 0.7},
        }).encode()
        req = urllib.request.Request(
            SUGGEST_URL, data=body, method="POST",
            headers={"Content-Type": "application/json",
                     "x-goog-api-key": os.environ["GEMINI_API_KEY"]})
        with urllib.request.urlopen(req, timeout=SUGGEST_TIMEOUT_S) as r:
            out = json.loads(r.read().decode("utf-8", "replace"))
        text = out["candidates"][0]["content"]["parts"][0]["text"] or ""
        text = text.strip().splitlines()[0].strip().strip('"').strip("'")
        return text.strip()[:160]
    except Exception:
        return ""


# --- side panels (opt-in, see /panels above) ---------------------------------
# The same containment rule as /suggest: every source is wrapped, a failing
# source becomes a card with a short note (or no card), and nothing here can
# raise into a request or stall /state. Sources refresh on ONE background
# thread; /panels only ever reads the cache.
PANELS = CFG.get("panels") if isinstance(CFG.get("panels"), dict) else {}
PANELS_ON = bool(PANELS.get("enabled"))
PANEL_REFRESH_S = max(60.0, float(PANELS.get("refresh_minutes", 15)) * 60)
_panel_cache = {}                 # source id -> card dict, or absent
_panel_lock = threading.Lock()
_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)  # no console flash

# WMO weather codes (what Open-Meteo returns), collapsed to a few words.
_WMO = {0: "Clear", 1: "Mostly clear", 2: "Partly cloudy", 3: "Overcast",
        45: "Fog", 48: "Fog", 51: "Light drizzle", 53: "Drizzle",
        55: "Heavy drizzle", 56: "Freezing drizzle", 57: "Freezing drizzle",
        61: "Light rain", 63: "Rain", 65: "Heavy rain", 66: "Freezing rain",
        67: "Freezing rain", 71: "Light snow", 73: "Snow", 75: "Heavy snow",
        77: "Snow grains", 80: "Showers", 81: "Showers", 82: "Heavy showers",
        85: "Snow showers", 86: "Snow showers", 95: "Thunderstorm",
        96: "Thunderstorm, hail", 99: "Thunderstorm, hail"}


def _panel_weather(w):
    imperial = w.get("units", "fahrenheit") == "fahrenheit"
    q = urllib.parse.urlencode({
        "latitude": w["lat"], "longitude": w["lon"],
        "current": "temperature_2m,apparent_temperature,weather_code,"
                   "wind_speed_10m",
        "daily": "temperature_2m_max,temperature_2m_min,"
                 "precipitation_probability_max",
        "forecast_days": 1, "timezone": "auto",
        "temperature_unit": "fahrenheit" if imperial else "celsius",
        "wind_speed_unit": "mph" if imperial else "kmh"})
    with urllib.request.urlopen(
            "https://api.open-meteo.com/v1/forecast?" + q, timeout=10) as r:
        d = json.loads(r.read().decode("utf-8", "replace"))
    cur, day = d["current"], d["daily"]
    deg = "°"
    rows = [
        {"label": "Now", "value": f"{round(cur['temperature_2m'])}{deg}  "
                                  f"{_WMO.get(cur.get('weather_code'), '')}"},
        {"label": "Feels", "value":
            f"{round(cur['apparent_temperature'])}{deg}"},
        {"label": "Hi / Lo", "value":
            f"{round(day['temperature_2m_max'][0])}{deg} / "
            f"{round(day['temperature_2m_min'][0])}{deg}"},
        {"label": "Wind", "value": f"{round(cur['wind_speed_10m'])} "
                                   f"{'mph' if imperial else 'km/h'}"},
    ]
    rain = (day.get("precipitation_probability_max") or [None])[0]
    if rain is not None:
        rows.append({"label": "Rain", "value": f"{rain}%", "pct": rain})
    title = "Weather" + (" · " + w["label"] if w.get("label") else "")
    return {"id": "weather", "side": "left", "title": title, "rows": rows}


def _fmt_when(start):
    """A Google Calendar start ('2026-09-22T08:00:00-04:00', or '2026-10-02'
    for all-day) -> 'Today 8:00 AM' / 'Tomorrow' / 'Thu 10/2 2:30 PM'."""
    try:
        if "T" in start:
            dt = datetime.fromisoformat(start.replace("Z", "+00:00"))
            dt = dt.astimezone() if dt.tzinfo else dt
            all_day = False
        else:
            dt, all_day = datetime.fromisoformat(start), True
    except (TypeError, ValueError):
        return str(start or "")
    today = datetime.now().date()
    d = dt.date()
    if d == today:
        day = "Today"
    elif d == today + timedelta(days=1):
        day = "Tomorrow"
    elif 0 < (d - today).days < 7:
        day = dt.strftime("%a")
    else:
        day = f"{dt.strftime('%a')} {d.month}/{d.day}"
    if all_day:
        return day
    return f"{day} {dt.strftime('%I:%M %p').lstrip('0')}"


def _end_epoch(end):
    try:
        if "T" in end:
            return datetime.fromisoformat(end.replace("Z", "+00:00")).timestamp()
        return datetime.fromisoformat(end).timestamp()   # all-day: local midnight
    except (TypeError, ValueError):
        return None


def _panel_calendar(c):
    out = subprocess.run(c["command"], capture_output=True, text=True,
                         timeout=45, creationflags=_NO_WINDOW)
    d = json.loads(out.stdout or "{}")
    card = {"id": "calendar", "side": "left", "title": "Calendar", "rows": []}
    if d.get("error"):
        # The usual cause is the ~7-day Testing-mode token expiry; say so
        # plainly instead of drawing an empty calendar.
        card["note"] = "Calendar sign-in expired, needs a re-consent"
        return card
    for ev in (d.get("events") or [])[:int(c.get("max", 4))]:
        card["rows"].append({"label": _fmt_when(ev.get("start")),
                             "value": ev.get("summary") or "(no title)",
                             "_ends": _end_epoch(ev.get("end"))})
    if not card["rows"]:
        card["note"] = "Nothing coming up"
    return card


_BOLD_ITEM = re.compile(r"^\s*[-*]\s+\*\*(.+?)\*\*")
_WIKILINK = re.compile(r"\[\[(?:[^\]|]*\|)?([^\]]+)\]\]")
_FLAG = re.compile(r"\[(BLOCKED|ON HOLD|WAITING[^\]]*|OVERDUE[^\]]*)\]", re.I)


def _panel_priorities(p):
    """Bold lead-ins from a '## Section' / '- **Item:** detail' markdown list.
    "file" may be a glob; the newest match wins (a cache that renames itself
    on every regeneration still works)."""
    matches = sorted(glob.glob(os.path.expanduser(p["file"])),
                     key=os.path.getmtime)
    if not matches:
        return {"id": "priorities", "side": "left", "title": "Priorities",
                "rows": [], "note": "Priorities file not found"}
    text = Path(matches[-1]).read_text(encoding="utf-8", errors="replace")
    want = p.get("sections")
    skip = set(p.get("skip_sections", ["Guiding Decisions"]))
    mx = int(p.get("max", 8))
    per = int(p.get("per_section", 0)) or mx   # so one section can't hog it
    rows, section, headed, in_sec = [], None, None, 0
    for line in text.splitlines():
        if line.startswith("## "):
            section = line[3:].strip()
            continue
        if not section or section in skip or (want and section not in want):
            continue
        m = _BOLD_ITEM.match(line)
        if not m:
            continue
        # A flag can sit inside the bold or just after it; look at both.
        flag = _FLAG.search(line)
        title = _WIKILINK.sub(r"\1", m.group(1)).replace("`", "")
        title = _FLAG.sub("", title)
        # Drop dated/ID-ish asides ("(found 2026-08-11)", "(`KB5120249`)"),
        # keep short naming ones ("Phase 2 (Hearth dashboard)").
        title = re.sub(r"\s*\(([^)]*)\)",
                       lambda m: "" if re.search(r"\d", m.group(1))
                       or len(m.group(1)) > 24 else m.group(0), title)
        title = title.strip().rstrip(":.").strip()
        if not title or "✅" in line[:12]:
            continue
        if section != headed:
            rows.append({"head": section})
            headed, in_sec = section, 0
        if in_sec >= per:
            continue
        in_sec += 1
        row = {"value": title}
        if flag:
            f = flag.group(1).upper()
            row["label"] = "HOLD" if f.startswith("ON HOLD") else f.split()[0]
            row["hot"] = True
        rows.append(row)
        if sum(1 for r in rows if "value" in r) >= mx:
            break
    return {"id": "priorities", "side": "left",
            "title": p.get("title", "Priorities"), "rows": rows}


_PANEL_SOURCES = (("calendar", _panel_calendar), ("weather", _panel_weather),
                  ("priorities", _panel_priorities))


def _refresh_panels():
    for key, fn in _PANEL_SOURCES:
        conf = PANELS.get(key)
        if not conf:
            continue
        try:
            card = fn(conf)
        except Exception as e:
            # keep the last good card if there is one; a blip shouldn't blank
            # the panel. Only a source that never worked shows the note.
            with _panel_lock:
                if key in _panel_cache:
                    continue
            card = {"id": key, "side": "left", "title": key.title(),
                    "rows": [], "note": f"Unavailable ({type(e).__name__})"}
        if isinstance(conf, dict) and conf.get("side") in ("left", "right"):
            card["side"] = conf["side"]
        with _panel_lock:
            _panel_cache[key] = card


def _panel_loop():
    while True:
        _refresh_panels()
        time.sleep(PANEL_REFRESH_S)


def _job_cards():
    """Drop-in cards: any .voice_panel_*.json on the bus, re-read on every
    request (they're tiny and they're how long jobs report progress)."""
    now = time.time()
    cards = []
    for p in sorted(BUS.glob(".voice_panel_*.json")):
        try:
            c = json.loads(p.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if not isinstance(c, dict):
            continue
        exp = c.get("expires")
        if isinstance(exp, (int, float)) and exp < now:
            continue
        c.setdefault("id", p.stem[len(".voice_panel_"):])
        c.setdefault("side", "right")
        c.setdefault("title", c["id"].replace("_", " ").title())
        if not isinstance(c.get("rows"), list):
            c["rows"] = []
        cards.append(c)
    return cards


def read_panels():
    if not PANELS_ON:
        return {"cards": []}
    now = time.time()
    with _panel_lock:
        cached = [dict(c) for c in _panel_cache.values()]
    order = {k: i for i, (k, _) in enumerate(_PANEL_SOURCES)}
    cached.sort(key=lambda c: order.get(c.get("id"), 99))
    for c in cached:
        # A calendar event that ended since the last refresh drops off now,
        # not up to refresh_minutes later.
        # (copies: the cached rows keep their _ends for the next request)
        rows = [{k: v for k, v in r.items() if k != "_ends"}
                for r in c.get("rows", [])
                if not (r.get("_ends") and r["_ends"] < now)]
        c["rows"] = rows
        if c.get("id") == "calendar" and not rows and not c.get("note"):
            c["note"] = "Nothing coming up"
    return {"cards": cached + _job_cards()}


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        path = self.path.split("?")[0]
        try:
            if path == "/state":
                self._send(json.dumps(read_bus()).encode(),
                           "application/json")
            elif path == "/config":
                out = {"name": CFG["name"], "badge": CFG["badge"],
                       "face": CFG["face"],
                       "thinking_sound": bool(CFG["thinking_sound"]),
                       "suggest": suggest_enabled(),
                       "chat_width": CFG.get("chat_width", 960),
                       "panels": PANELS_ON,
                       "faces": list_faces(),
                       "agent": read_agent_meta()}
                self._send(json.dumps(out).encode(), "application/json")
            elif path == "/transcript":
                self._send(json.dumps(read_transcript()).encode(),
                           "application/json")
            elif path == "/panels":
                self._send(json.dumps(read_panels()).encode(),
                           "application/json")
            else:
                self._static(path)
        except ConnectionError:
            # THE WHOLE FAMILY, not one member of it. A tab closed or
            # reloaded mid-response raises ConnectionResetError, which is a
            # SIBLING of BrokenPipeError rather than a subclass -- so
            # catching only BrokenPipeError sent it to the generic branch
            # below, which then wrote a 500 back down the socket that had
            # just died and raised a SECOND, uncaught error from inside
            # flush_headers(). One disconnect, two tracebacks. ConnectionError
            # is the common parent of Reset, Broken, Aborted and Refused.
            pass
        except Exception as e:
            body = json.dumps({"error": str(e)}).encode()
            try:
                self._send(body, "application/json", 500)
            except ConnectionError:
                # A real error AND the client already gone. There is nobody
                # left to tell; saying so twice helps no one.
                pass

    # Both POST routes WRITE beside the bus (an inbox message backtalk will
    # treat as typed input, or an uploaded file), so they must refuse what a
    # browser can be tricked into sending from another site. Three checks:
    #   Host    -- must be this server. A DNS-rebinding page arrives with the
    #              attacker's hostname here and is refused before CORS matters.
    #   Origin  -- absent (same-origin fetch, curl) or exactly this server.
    #              Any other site's page names itself and is refused.
    #   Content-Type -- exactly what core.js sends. A cross-site form or a
    #              no-preflight fetch can only carry text/plain or
    #              form-encoded bodies, which never match.
    # Verified 2026-09-04 before this guard existed: a POST to /send with
    # Content-Type: text/plain and Origin: https://evil.example answered
    # 200 and wrote a real inbox message -- i.e. a web page could type into
    # the voice session, including "yes" to a pending permission ask.
    def _local_post_ok(self, want_ctype):
        me = {f"127.0.0.1:{PORT}", f"localhost:{PORT}"}
        if self.headers.get("Host", "") not in me:
            return False
        origin = self.headers.get("Origin")
        if origin is not None and origin not in {f"http://{h}" for h in me}:
            return False
        ctype = (self.headers.get("Content-Type") or "").split(";")[0]
        return ctype.strip().lower() == want_ctype

    def _refuse(self):
        # drain the body first so the client reads a clean 403, not a reset
        try:
            length = int(self.headers.get("Content-Length", 0))
        except ValueError:
            length = 0
        if length > 0:
            self.rfile.read(min(length, ATTACH_MAX_BYTES))
        self._send(b"forbidden", "text/plain", 403)

    def do_POST(self):
        path = self.path.split("?")[0]
        try:
            if path == "/send":
                if not self._local_post_ok("application/json"):
                    self._refuse()
                    return
                self._do_send()
            elif path == "/attach":
                if not self._local_post_ok("application/octet-stream"):
                    self._refuse()
                    return
                self._do_attach()
            elif path == "/suggest":
                if not self._local_post_ok("application/json"):
                    self._refuse()
                    return
                self._do_suggest()
            else:
                self._send(b"not found", "text/plain", 404)
        except ConnectionError:
            # the whole family, same reason as do_GET above: a tab closed
            # mid-upload raises ConnectionResetError, a sibling of
            # BrokenPipeError, and answering it 500 raised a second error
            pass
        except Exception as e:
            body = json.dumps({"error": str(e)}).encode()
            self._send(body, "application/json", 500)

    def _do_send(self):
        length = int(self.headers.get("Content-Length", 0))
        body = json.loads(self.rfile.read(length) or b"{}")
        text = str(body.get("text", "")).strip()
        if not text:
            self._send(json.dumps({"error": "empty"}).encode(),
                       "application/json", 400)
            return
        inbox = BUS / ".voice_inbox"
        inbox.mkdir(exist_ok=True)
        name = f"{time.time():.6f}-{threading.get_ident()}.msg"
        tmp = inbox / (name + ".tmp")
        tmp.write_text(text, encoding="utf-8")
        tmp.replace(inbox / name)
        self._send(json.dumps({"ok": True}).encode(), "application/json")

    def _do_suggest(self):
        """Return {"suggestion": "..."} — the predicted next user message,
        or "" when the feature is off/unconfigured or the model gives
        nothing. Reads nothing, writes nothing; the one POST route that
        does not touch the bus."""
        length = int(self.headers.get("Content-Length", 0))
        try:
            body = json.loads(self.rfile.read(length) or b"{}")
        except ValueError:
            body = {}
        turns = body.get("turns") if isinstance(body, dict) else None
        text = suggest_reply(turns if isinstance(turns, list) else [])
        self._send(json.dumps({"suggestion": text}).encode(),
                   "application/json")

    def _do_attach(self):
        length = int(self.headers.get("Content-Length", 0))
        if length <= 0:
            self._send(json.dumps({"error": "empty"}).encode(),
                       "application/json", 400)
            return
        if length > ATTACH_MAX_BYTES:
            # drain the socket so the client sees the status, not a reset
            self.rfile.read(length)
            self._send(json.dumps(
                {"error": "file too large (max 25 MB)"}).encode(),
                "application/json", 413)
            return
        raw_name = urllib.parse.unquote(self.headers.get("X-Filename", ""))
        data = self.rfile.read(length)
        dest = save_attachment(raw_name, data)
        self._send(json.dumps(
            {"ok": True, "path": dest, "name": os.path.basename(dest)}
        ).encode(), "application/json")

    def _static(self, path):
        if path == "/":
            path = "/index.html"
        target = (HERE / path.lstrip("/")).resolve()
        if target != HERE and HERE not in target.parents:
            self._send(b"not found", "text/plain", 404)
            return
        if target.is_dir():
            target = target / "index.html"
        if not target.is_file():
            self._send(b"not found", "text/plain", 404)
            return
        ctype = mimetypes.guess_type(str(target))[0] or \
            "application/octet-stream"
        self._send(target.read_bytes(), ctype)

    def _send(self, body, ctype, code=200):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):
        pass


class _Server(ThreadingHTTPServer):
    # SO_REUSEADDR on Windows lets a second listener bind a port that is
    # already being listened on, which makes the "already running" probe
    # below dead code; on POSIX it only eases restart after Ctrl-C.
    allow_reuse_address = sys.platform != "win32"


if __name__ == "__main__":
    mode = f"MOCK={MOCK}" if MOCK else f"bus: {BUS}"
    root = f"http://127.0.0.1:{PORT}/"
    # The browser opens on the configured face; the gallery stays at "/" for switching.
    face = CFG.get("face", "")
    url = f"{root}faces/{face}/" if face and (HERE / "faces" / face / "index.html").exists() else root
    # ALREADY RUNNING IS NOT AN ERROR, and treating it as one was the whole
    # bug. Closing the browser tab does not stop this server; it keeps going
    # headless. Relaunching then failed to bind, died before the line that
    # opens the browser, and took the traceback with it when the launcher
    # window closed. The end-user symptom was "I can hear my agent but the
    # face never shows up", with the face running perfectly the entire time.
    try:
        srv = _Server(("127.0.0.1", PORT), Handler)
    except OSError as e:
        if e.errno not in (errno.EADDRINUSE, errno.EACCES):
            raise
        # Something holds the port. Ask it whether it is us before claiming
        # anything: a stranger on this port is a different problem and
        # deserves a different sentence.
        mine = False
        try:
            with urllib.request.urlopen(root + "state", timeout=2) as r:
                mine = r.status == 200
        except Exception:
            mine = False
        if mine:
            print(f"already running at {root}  opening it instead", flush=True)
            if not NO_OPEN:
                webbrowser.open(url)
            sys.exit(0)
        print(f"port {PORT} is taken by something that is not this server.",
              flush=True)
        print("Close whatever is using it, or set a different \"port\" in "
              "ai-visualizer.json.", flush=True)
        sys.exit(1)
    print(f"ai-visualizer on {root}  opening {url}  ({mode})  Ctrl-C stops", flush=True)
    if not NO_OPEN:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    if PANELS_ON:
        threading.Thread(target=_panel_loop, daemon=True).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
