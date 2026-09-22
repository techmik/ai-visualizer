/*
 * ai-visualizer: give your AI agent a face.
 * Copyright (C) 2026 Jared Rhodenizer
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published
 * by the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/* ============================================================
   ai-visualizer core — the shared plumbing every face rides on.

   A face is one self-contained page in faces/<name>/index.html.
   It includes this script, calls AV.init(opts), then reads these
   fields every animation frame after calling AV.tick(dtMs):

     AV.state      "idle" | "listening" | "thinking" | "working" | "speaking"
                   ("working" = a tool is running; "thinking" = model reasoning)
     AV.level      0..1 raw voice loudness (speaking only)
     AV.env        0..1 smoothed speech envelope (attack/release eased,
                   adaptively normalized — use this for motion)
     AV.samples    Float32Array(64), 0..1 normalized waveform ring
     AV.alert      bool, optional attention signal
     AV.micLevel   0..1 your microphone (only if init({mic:true}))
     AV.name       display name from config ("JARVIS" by default)
     AV.label      the dotted chip label ("J.A.R.V.I.S.")
     AV.badge      optional handle from config ("" by default)

   Modes:
     live   served by server.py — rides the real signal bus
     demo   ?demo=1, or the page opened as a plain file — a scripted
            voice-turn loop (idle, listening, thinking, speaking) with
            synthesized audio, so every face performs with no voice
            line installed
     shot   ?shot=<state>&t=ms — pins one state and runs the frame
            loop deterministically, then sets document.title to
            "ready" (screenshot/verification harness)

   The thinking sound: assets/thinking.wav plays while the state is
   "thinking", exactly like a voice line would play it. If the bus
   says the voice line is already playing its own (.voice_loading_pid),
   this player stays quiet — you never hear it twice. The speaker
   button (bottom left) toggles it; browsers may require one click on
   the page before audio is allowed.
   ============================================================ */
"use strict";

const AV = (() => {
  const Q = new URLSearchParams(location.search);
  const SHOT = Q.get("shot");
  const SHOT_T = parseInt(Q.get("t") || "4000", 10);
  const DEMO = Q.get("demo") === "1" || location.protocol === "file:" || !!SHOT;

  // where core.js lives -> where assets/ lives (works over http and file://)
  const ROOT = new URL(".", document.currentScript.src);

  const A = {
    state: "idle", level: 0, env: 0, alert: false, micLevel: 0,
    samples: new Float32Array(64),
    name: "JARVIS", label: "J.A.R.V.I.S.", badge: "",
    demo: DEMO, shot: SHOT, faces: [],
    _sndOn: true, _mic: false, _readyCbs: [], _ready: false,
  };

  function dotted(name) {
    const up = String(name).toUpperCase();
    if (/^[A-Z0-9]{2,10}$/.test(up)) return up.split("").join(".") + ".";
    return up;
  }

  /* -------------------------------- config -------------------------------- */
  function applyConfig(cfg) {
    if (cfg.name) { A.name = String(cfg.name); A.label = dotted(A.name); }
    A.badge = String(cfg.badge || "");
    if (cfg.thinking_sound === false) A._sndWant = false;
    // Opt-in ghost-text reply suggestions (server.py /suggest). Off unless
    // suggest_replies is set AND the server has GEMINI_API_KEY, so the chat
    // box only asks for one when it could actually use it.
    A.suggest = !!cfg.suggest;
    A.panels = !!cfg.panels;
    A.faces = cfg.faces || [];
    A.agent = cfg.agent || {};
    A._ready = true;
    A._readyCbs.forEach(cb => cb(A));
    A._readyCbs = [];
  }

  A.ready = cb => { A._ready ? cb(A) : A._readyCbs.push(cb); };

  /* ------------------------------ bus polling ------------------------------ */
  let raw = { state: "idle", level: 0, samples: null, alert: false,
              loading: false };
  if (!DEMO) {
    setInterval(async () => {
      try {
        const r = await fetch("/state", { cache: "no-store" });
        raw = await r.json();
      } catch (e) { /* server gone: hold last state */ }
    }, 120);
  }

  /* ------------------------------ demo driver ------------------------------ */
  // A scripted voice turn: the face performs everything with no voice line.
  const SCRIPT = [["idle", 6000], ["listening", 3500], ["thinking", 4200],
                  ["working", 3800], ["thinking", 2400], ["speaking", 8500]];
  let demoT = 0, demoClock = 0;
  const PIN = SHOT || Q.get("state");   // ?state=speaking pins the demo
  function demoUpdate(dt) {
    demoClock += dt;
    let st = PIN || "idle";
    if (!PIN) {
      demoT = (demoT + dt) % SCRIPT.reduce((a, s) => a + s[1], 0);
      let t = demoT;
      for (const [name, len] of SCRIPT) {
        if (t < len) { st = name; break; }
        t -= len;
      }
    }
    const tt = demoClock / 1000;
    const speaking = st === "speaking";
    const cadence = speaking
      ? Math.max(0, Math.sin(tt * 2.1) * 0.6 + Math.sin(tt * 0.9) * 0.5)
      : 0;
    const samples = new Array(64);
    for (let i = 0; i < 64; i++) {
      // drifting per-sample color so the synthetic voice has a moving
      // spectrum, not a steady tone — spectrum-driven faces dance
      const m = 0.3 + 0.7 * Math.abs(Math.sin(i * 0.23 + tt * 1.7))
        * Math.abs(Math.sin(tt * 2.9 + i * 0.05));
      samples[i] = speaking
        ? (Math.sin(i * 0.55 + tt * 9) * 0.6 + Math.sin(i * 1.7 - tt * 13)
           * 0.4) * 9000 * (0.15 + 0.85 * cadence) * m
        : 0;
    }
    raw = { state: st, level: speaking ? Math.min(1, cadence) : 0,
            samples, alert: false, loading: false };
    if (st === "listening")
      A.micLevel = 0.25 + 0.55 * Math.abs(Math.sin(tt * 2.7))
        * Math.abs(Math.sin(tt * 0.61));
  }

  /* ----------------------- envelope + samples easing ----------------------- */
  let peak = 0.05, sPeak = 200;
  function tick(dt) {
    if (DEMO) demoUpdate(dt);
    A.state = raw.state || "idle";
    A.alert = !!raw.alert;
    // Empty unless the voice line was told to publish usage. A face that
    // wants to draw it reads AV.rateLimits; every other face ignores it.
    A.rateLimits = raw.rate_limits || {};
    // Context-window fill {used, max, pct}, published after each turn.
    // The chat status row draws it; other faces ignore it.
    A.context = raw.context || {};
    // A permission ask waiting for an answer, or {} when none. The chat
    // box draws an approve/deny card off this; other faces ignore it.
    A.permission = raw.permission || {};
    // What the voice line is LIVE on {model, effort, mode, mic, degraded,
    // turns?, cost?}; {} from a voice line that doesn't publish it, in
    // which case readers fall back to A.agent (launch config).
    A.session = raw.session || {};
    A.level = raw.level || 0;

    // adaptive envelope: normalize against a decaying peak, then ease
    // (attack 50ms, release 350ms) — motion code rides AV.env
    const dts = dt / 1000;
    peak = Math.max(A.level, 0.05, peak - 0.5 * peak * dts);
    const target = Math.min(1, A.level / peak);
    const tau = target > A.env ? 50 : 350;
    A.env += (target - A.env) * Math.min(1, dt / tau);

    // waveform ring: rectify, normalize against its own decaying peak,
    // blend toward the newest frame so the ring flows instead of flickers
    const s = raw.samples;
    A.rawSamples = s && s.length ? s : null;   // signed, int16-scale floats
    if (s && s.length) {
      let mx = 0;
      for (let i = 0; i < s.length; i++) mx = Math.max(mx, Math.abs(s[i]));
      sPeak = Math.max(mx, 200, sPeak * 0.98);
      const n = s.length;
      for (let i = 0; i < 64; i++) {
        const v = Math.abs(s[Math.min(n - 1, Math.round(i * (n - 1) / 63))])
          / sPeak;
        A.samples[i] = A.samples[i] * 0.45 + Math.min(1, v) * 0.55;
      }
    } else {
      for (let i = 0; i < 64; i++) A.samples[i] *= Math.max(0, 1 - dts * 6);
    }
    if (A.state !== "speaking" && !DEMO)
      for (let i = 0; i < 64; i++) A.samples[i] *= Math.max(0, 1 - dts * 6);

    if (A._mic && A._micAnalyser) micRead();
    soundUpdate();
  }

  /* --------------------------------- mic ---------------------------------- */
  let micPeak = 0.02;
  function micRead() {
    const an = A._micAnalyser;
    const buf = A._micBuf;
    an.getFloatTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    const rms = Math.sqrt(sum / buf.length);
    micPeak = Math.max(rms, 0.02, micPeak * 0.999);
    A.micLevel = Math.min(1, rms / micPeak);
  }
  async function micStart() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const ctx = new AudioContext();
      const src = ctx.createMediaStreamSource(stream);
      const an = ctx.createAnalyser();
      an.fftSize = 512;
      src.connect(an);
      A._micAnalyser = an;
      A._micBuf = new Float32Array(an.fftSize);
      const kick = () => ctx.state === "suspended" && ctx.resume();
      addEventListener("click", kick); addEventListener("keydown", kick);
    } catch (e) { /* no mic permission: level stays 0, faces degrade */ }
  }

  /* ----------------------------- thinking sound ---------------------------- */
  let audio = null, sndBtn = null, playing = false;
  A._sndWant = true;
  function soundInit() {
    if (SHOT) return;
    try { A._sndOn = localStorage.getItem("av_sound") !== "0"; }
    catch (e) { A._sndOn = true; }
    audio = new Audio(new URL("assets/thinking.wav", ROOT).href);
    audio.volume = 0.35;
    sndBtn = document.createElement("div");
    // hidden until the mouse moves, so it never collides with a face's
    // chrome and never shows on camera or in an OBS source
    sndBtn.style.cssText =
      "position:fixed;left:64px;bottom:14px;z-index:50;cursor:pointer;" +
      "font:12px 'SF Mono',Menlo,Consolas,monospace;letter-spacing:.2em;" +
      "color:#5a6a72;opacity:0;transition:opacity .4s;user-select:none;" +
      "pointer-events:none";
    sndBtn.title = "thinking sound on/off";
    let hideT = null;
    addEventListener("mousemove", () => {
      sndBtn.style.opacity = ".65";
      sndBtn.style.pointerEvents = "auto";
      clearTimeout(hideT);
      hideT = setTimeout(() => {
        sndBtn.style.opacity = "0";
        sndBtn.style.pointerEvents = "none";
      }, 3000);
    });
    sndBtn.onclick = () => {
      A._sndOn = !A._sndOn;
      try { localStorage.setItem("av_sound", A._sndOn ? "1" : "0"); }
      catch (e) {}
      if (!A._sndOn) stopSound();
      paintBtn();
    };
    paintBtn();
    document.body.appendChild(sndBtn);
  }
  function paintBtn() {
    if (sndBtn) sndBtn.textContent = A._sndOn ? "SND ON" : "SND OFF";
  }
  function stopSound() {
    if (audio && playing) { audio.pause(); audio.currentTime = 0; }
    playing = false;
  }
  function soundUpdate() {
    if (!audio || !A._sndWant) return;
    const want = A._sndOn && A.state === "thinking" && !raw.loading;
    if (want && !playing) {
      playing = true;
      audio.currentTime = 0;
      audio.play().catch(() => { playing = false; });
    } else if (!want && playing) {
      stopSound();
    }
  }

  /* --------------------------------- cursor --------------------------------- */
  // each face's CSS hides the system cursor by default so it never shows on
  // camera or in an OBS source; show it again while the mouse is actually
  // moving, then let it fade back out after a beat of no movement
  function cursorInit() {
    if (SHOT) return;
    let hideT = null;
    addEventListener("mousemove", () => {
      document.body.style.cursor = "auto";
      clearTimeout(hideT);
      hideT = setTimeout(() => { document.body.style.cursor = ""; }, 1500);
    });
  }

  /* --------------------------------- chat ---------------------------------- */
  // A type-and-read dashboard riding the same bus: POST /send drops a
  // message into backtalk's inbox (server.py), GET /transcript polls
  // the running conversation (typed AND spoken) back. Injected once
  // here so every face gets it for free, no per-face wiring.
  function chatInit() {
    if (SHOT) return;
    const wrap = document.createElement("div");
    wrap.id = "av-chat";
    wrap.innerHTML =
      '<div id="av-chat-log"></div>' +
      '<div id="av-chat-files"></div>' +
      '<div id="av-chat-perm"></div>' +
      '<div id="av-chat-inputrow">' +
      '<button id="av-chat-attach" type="button" title="Attach a file" ' +
      'aria-label="Attach a file">' +
      '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" ' +
      'stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
      'stroke-linejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49' +
      'l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/>' +
      '</svg></button>' +
      '<textarea id="av-chat-input" rows="1" ' +
      'placeholder="Type a message... Enter to send, Shift+Enter for a new line"></textarea>' +
      '</div>' +
      '<input id="av-chat-file" type="file" multiple hidden>' +
      '<div id="av-chat-status">' +
      '<span id="av-chat-mode"></span>' +
      '<span id="av-chat-meta">' +
      '<span id="av-chat-ctx"></span><span id="av-chat-model"></span>' +
      '</span></div>';
    document.body.appendChild(wrap);
    const style = document.createElement("style");
    // Styled to sit like the Claude Code desktop app's centre panel + bottom
    // bar: a translucent frosted card over the face (backdrop-blur so the face
    // animates through it and no 2nd window is needed), sans-serif prose, mono
    // only for the tool/▸ lines, a model/mode status row under the input.
    // Log lines carry a text-shadow so they stay legible over bright frames.
    // Bottom-anchored
    // and grows upward (was top+bottom anchored) so an empty chat collapses
    // to just the input instead of a full-height slab, while the input still
    // stays above the board face's taskbar/echo line.
    style.textContent = `
      #av-chat{position:fixed;left:50%;transform:translateX(-50%);
        bottom:72px;width:960px;max-width:86vw;
        max-height:calc(100vh - 200px);z-index:60;
        font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
        color:#e6e4de;display:flex;flex-direction:column;
        background:rgba(16,17,16,0.72);
        backdrop-filter:blur(10px) saturate(1.1);
        -webkit-backdrop-filter:blur(10px) saturate(1.1);
        border:1px solid rgba(255,255,255,.10);
        border-radius:12px;padding:14px 14px 12px;
        box-shadow:0 12px 40px rgba(0,0,0,.35)}
      #av-chat.av-perm-active{max-height:calc(100vh - 96px)}
      #av-chat, #av-chat *{cursor:auto}
      #av-chat-log{cursor:text;flex:1 1 auto;min-height:0;overflow-y:auto;
        display:flex;flex-direction:column;padding-right:6px;
        scrollbar-width:thin;scrollbar-color:rgba(255,255,255,.18) transparent}
      #av-chat-log::-webkit-scrollbar{width:9px}
      #av-chat-log::-webkit-scrollbar-thumb{background:rgba(255,255,255,.18);border-radius:5px}
      #av-chat-log::-webkit-scrollbar-track{background:transparent}
      #av-chat-log:empty{display:none}
      #av-chat-log .av-line{margin:6px 0;white-space:pre-wrap;word-break:break-word;
        text-shadow:0 1px 3px rgba(0,0,0,.55)}
      #av-chat-log .av-user{align-self:flex-end;max-width:85%;
        background:rgba(93,214,150,.12);border:1px solid rgba(93,214,150,.22);
        border-radius:12px;padding:7px 12px;color:#e6f2ea}
      #av-chat-log .av-assistant{color:#e6e4de}
      #av-chat-log .av-thinking{color:#9b958b;font-style:italic;
        margin:6px 0 6px 4px;padding:2px 0 2px 12px;
        border-left:2px solid rgba(140,220,180,.20)}
      #av-chat-log .av-thinking .av-think-label{display:block;font-style:normal;
        font-size:11px;letter-spacing:.12em;text-transform:uppercase;
        color:rgba(140,220,180,.45);margin-bottom:2px}
      #av-chat-log .av-tool{color:#86d9b8;font-size:13px;
        font-family:"SF Mono",ui-monospace,Menlo,Consolas,monospace;
        margin:2px 0 2px 4px}
      #av-chat-log .av-tool::before{content:"\\25B8  ";color:rgba(134,217,184,.75)}
      #av-chat-log .av-tool-result{color:#8ba79a;font-size:13px;
        font-family:"SF Mono",ui-monospace,Menlo,Consolas,monospace;
        margin:1px 0 4px 18px}
      #av-chat-log .av-tool-result::before{content:"\\2192  ";opacity:.6}
      #av-chat-log .av-code{margin:8px 0 8px 4px}
      #av-chat-log .av-code-pre{margin:0;padding:10px 12px;overflow-x:auto;
        background:rgba(0,0,0,.34);border:1px solid rgba(255,255,255,.14);
        border-radius:8px;white-space:pre;text-shadow:none;
        font:12px/1.5 "SF Mono",ui-monospace,Menlo,Consolas,monospace;
        color:#dfe6df}
      #av-chat-log .av-code-pre::-webkit-scrollbar{height:8px}
      #av-chat-log .av-code-pre::-webkit-scrollbar-thumb{
        background:rgba(255,255,255,.18);border-radius:4px}
      #av-chat-inputrow{position:relative;flex:0 0 auto;margin-top:10px}
      #av-chat-input{resize:none;display:block;width:100%;box-sizing:border-box;
        background:rgba(255,255,255,.04);
        border:1px solid rgba(255,255,255,.12);border-radius:10px;color:#e6e4de;
        padding:9px 12px 9px 42px;font:inherit;outline:none;
        max-height:40vh;overflow-y:auto}
      #av-chat-input::placeholder{color:#7d776d}
      #av-chat-input:focus{border-color:rgba(140,220,180,.5)}
      #av-chat-attach{position:absolute;left:8px;bottom:8px;width:28px;height:28px;
        display:flex;align-items:center;justify-content:center;padding:0;
        background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.12);
        border-radius:8px;color:#bfe6d5;cursor:pointer}
      #av-chat-attach:hover{background:rgba(140,220,180,.16);color:#e6f2ea;
        border-color:rgba(140,220,180,.4)}
      #av-chat-files{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
      #av-chat-files:empty{display:none}
      #av-chat-files .av-file-chip{display:flex;align-items:center;gap:7px;
        max-width:280px;font-size:12px;color:#e6f2ea;
        background:rgba(93,214,150,.12);border:1px solid rgba(93,214,150,.22);
        border-radius:8px;padding:3px 6px 3px 10px}
      #av-chat-files .av-file-chip.av-file-err{color:#f0cfcd;
        background:rgba(224,115,110,.14);border-color:rgba(224,115,110,.38)}
      #av-chat-files .av-file-chip .av-file-name{white-space:nowrap;
        overflow:hidden;text-overflow:ellipsis}
      #av-chat-files .av-file-chip button{flex:0 0 auto;width:16px;height:16px;
        display:flex;align-items:center;justify-content:center;padding:0;
        border:none;background:none;color:inherit;cursor:pointer;
        font-size:14px;line-height:1;border-radius:4px}
      #av-chat-files .av-file-chip button:hover{background:rgba(255,255,255,.14)}
      #av-chat.av-drag{outline:2px dashed rgba(140,220,180,.6);outline-offset:4px}
      #av-chat-status{flex:0 0 auto;display:flex;justify-content:space-between;
        align-items:center;
        font-size:12px;color:#9b958b;margin-top:7px;padding:0 2px}
      #av-chat-meta{display:flex;gap:12px;align-items:center}
      #av-chat-ctx{color:#8b857b;display:flex;align-items:center;gap:6px}
      #av-chat-ctx:empty{display:none}
      #av-chat-ctx .av-ctx-bar{width:44px;height:4px;border-radius:2px;
        background:rgba(255,255,255,.12);overflow:hidden}
      #av-chat-ctx .av-ctx-fill{display:block;height:100%;
        background:rgba(140,220,180,.55)}
      #av-chat-perm{flex:0 0 auto;margin-top:10px;display:none;
        border:1px solid rgba(231,195,104,.45);border-radius:10px;
        background:rgba(231,195,104,.10);padding:10px 12px}
      #av-chat-perm.av-perm-on{display:block}
      #av-chat-perm .av-perm-q{color:#f0e4c4;font-size:13.5px;
        margin-bottom:8px;white-space:pre-wrap;word-break:break-word;
        max-height:30vh;overflow-y:auto}
      #av-chat-perm .av-perm-btns{display:flex;gap:8px}
      #av-chat-perm .av-perm-btns button{flex:0 0 auto;padding:5px 14px;
        font:inherit;font-size:13px;border-radius:8px;cursor:pointer;
        background:rgba(255,255,255,.06);
        border:1px solid rgba(255,255,255,.16);color:#e6e4de}
      #av-chat-perm .av-perm-btns button:hover{background:rgba(255,255,255,.14)}
      #av-chat-perm .av-perm-yes{background:rgba(140,220,180,.16);
        border-color:rgba(140,220,180,.45);color:#e6f2ea}
      #av-chat-perm .av-perm-yes:hover{background:rgba(140,220,180,.28)}
      #av-chat-perm .av-perm-no{background:rgba(224,115,110,.14);
        border-color:rgba(224,115,110,.4);color:#f0cfcd}
      #av-chat-perm .av-perm-no:hover{background:rgba(224,115,110,.26)}
    `;
    document.head.appendChild(style);

    // See the clean face without the chat box: open with ?nochat, or toggle it
    // any time with Ctrl+` (a combo on purpose -- a bare key would fire while
    // you're typing in the input).
    if (Q.has("nochat")) wrap.style.display = "none";
    const isToggle = e => e.ctrlKey && !e.altKey && !e.metaKey &&
      (e.code === "Backquote" || e.key === "`");
    const toggleChat = () => {
      wrap.style.display = wrap.style.display === "none" ? "" : "none";
    };
    addEventListener("keydown", e => {
      if (isToggle(e)) { e.preventDefault(); toggleChat(); }
    });

    const log = wrap.querySelector("#av-chat-log");
    const input = wrap.querySelector("#av-chat-input");
    const modeEl = wrap.querySelector("#av-chat-mode");
    const modelEl = wrap.querySelector("#av-chat-model");
    const ctxEl = wrap.querySelector("#av-chat-ctx");
    const attachBtn = wrap.querySelector("#av-chat-attach");
    const fileInput = wrap.querySelector("#av-chat-file");
    const fileTray = wrap.querySelector("#av-chat-files");
    const permEl = wrap.querySelector("#av-chat-perm");

    // Ghost-text reply suggestion. Shown as the input's placeholder (so it
    // only appears while the box is empty, which is exactly when we want
    // it). Tab -- or -> in an empty box -- drops it in as a real, editable
    // draft; it NEVER sends on its own. Enter still sends, same as anything
    // typed. A voice-only session with the chat hidden never asks for one.
    const DEFAULT_PH = input.getAttribute("placeholder");
    let ghost = "";            // current suggestion text, "" = none
    let ghostPending = false;  // a /suggest request is in flight
    let ghostSig = "";         // transcript signature last asked for
    function clearGhost() {
      if (!ghost) return;
      ghost = "";
      input.placeholder = DEFAULT_PH;
    }
    function showGhost(s) {
      ghost = s;
      input.placeholder = "⇥ " + s;   // U+21E5 (⇥) hints "press Tab"
    }

    // Files picked (or dropped) but not yet sent. Each POSTs to /attach
    // right away; the server saves it beside the bus and returns an
    // absolute path. On send, every finished upload's path is appended to
    // the message as an "[Attached file: ...]" line so the agent can open
    // it with no "where is it on my PC" round-trip. Entry shape:
    //   {name, chip, nameEl, path|null, done, failed}
    const attached = [];
    const ATTACH_MAX_BYTES = 25 * 1024 * 1024;
    let sendQueued = false;

    function dropEntry(entry) {
      const i = attached.indexOf(entry);
      if (i >= 0) attached.splice(i, 1);
      if (entry.chip) entry.chip.remove();
    }

    function addChip(entry, label) {
      const chip = document.createElement("div");
      chip.className = "av-file-chip";
      const nm = document.createElement("span");
      nm.className = "av-file-name";
      nm.textContent = label;
      const x = document.createElement("button");
      x.type = "button";
      x.textContent = "×";
      x.title = "Remove";
      x.addEventListener("click", () => dropEntry(entry));
      chip.appendChild(nm);
      chip.appendChild(x);
      fileTray.appendChild(chip);
      entry.chip = chip;
      entry.nameEl = nm;
    }

    function markErr(entry, msg) {
      entry.done = true;
      entry.failed = true;
      if (entry.chip) {
        entry.chip.classList.add("av-file-err");
        entry.nameEl.textContent = entry.name + " — " + msg;
      }
    }

    function uploadFile(file) {
      const entry = { name: file.name, path: null, done: false, failed: false };
      attached.push(entry);
      addChip(entry, file.name + " — uploading…");
      if (file.size > ATTACH_MAX_BYTES) {
        markErr(entry, "too large (max 25 MB)");
        return;
      }
      fetch("/attach", {
        method: "POST",
        headers: {
          "Content-Type": "application/octet-stream",
          "X-Filename": encodeURIComponent(file.name),
        },
        body: file,
      })
        .then(r => r.json())
        .then(res => {
          if (!res || !res.ok || !res.path)
            throw new Error((res && res.error) || "upload failed");
          entry.path = res.path;
          entry.done = true;
          entry.nameEl.textContent = entry.name;
        })
        .catch(err => markErr(entry, String(err.message || err)))
        .finally(() => { if (sendQueued) trySend(); });
    }

    attachBtn.addEventListener("click", () => fileInput.click());
    fileInput.addEventListener("change", () => {
      for (const f of fileInput.files) uploadFile(f);
      fileInput.value = "";
    });

    // Drag a file straight onto the chat card.
    ["dragenter", "dragover"].forEach(ev => wrap.addEventListener(ev, e => {
      if (e.dataTransfer && Array.from(e.dataTransfer.types).includes("Files")) {
        e.preventDefault();
        wrap.classList.add("av-drag");
      }
    }));
    wrap.addEventListener("dragleave", e => {
      if (!e.relatedTarget || !wrap.contains(e.relatedTarget))
        wrap.classList.remove("av-drag");
    });
    wrap.addEventListener("drop", e => {
      wrap.classList.remove("av-drag");
      if (!e.dataTransfer || !e.dataTransfer.files.length) return;
      e.preventDefault();
      for (const f of e.dataTransfer.files) uploadFile(f);
    });

    // model/effort/mode, shown like the desktop app's "Manual · Sonnet 5 ·
    // High" indicator. Live values come from the bus (A.session, rewritten by
    // the voice line on every runtime switch); anything it doesn't carry
    // falls back to /config's agent meta, which is launch config only.
    const titleCase = s => String(s || "").replace(/\b\w/g, c => c.toUpperCase());
    // claude-opus-5-5 -> "Opus 5.5" (version digits rejoin with a dot; a
    // trailing date stamp like 20251001 is dropped)
    const prettyModel = m => String(m || "").replace(/^claude-/, "")
      .replace(/-\d{8}$/, "").replace(/(\d)-(?=\d)/g, "$1.").split("-")
      .map(p => p.charAt(0).toUpperCase() + p.slice(1)).join(" ").trim();
    const prettyMode = m => m === "bypassPermissions" ? "Auto" : titleCase(m);
    A.live = () => {
      const ag = A.agent || {}, s = A.session || {};
      return { model: s.model || ag.model, effort: s.effort || ag.effort,
               mode: s.mode || ag.mode, mic: s.mic, degraded: !!s.degraded,
               turns: s.turns, cost: s.cost };
    };
    A.pretty = { model: prettyModel, mode: prettyMode, title: titleCase };
    function paintModel() {
      if (!A._ready) return;
      const lv = A.live();
      modeEl.textContent = prettyMode(lv.mode);
      const m = lv.degraded ? "Local backup" : prettyModel(lv.model);
      const e = titleCase(lv.effort);
      modelEl.textContent = m && e ? m + " · " + e : (m || e);
    }
    A.ready(paintModel);
    setInterval(paintModel, 1000);

    function addLine(role, text) {
      if (role === "thinking") {
        // Reasoning now streams in as sentence-sized pieces (backtalk
        // flushes thinking_delta live, not one lump at block end). Grow
        // the current reasoning block instead of stacking a fresh
        // labelled block per piece — unless the previous line was
        // something else (a tool call, a spoken sentence), which starts
        // a new one.
        const last = log.lastElementChild;
        if (last && last.classList.contains("av-thinking")) {
          last.appendChild(document.createTextNode(" " + text));
          log.scrollTop = log.scrollHeight;
          return;
        }
      }
      const d = document.createElement("div");
      d.className = "av-line av-" + role;
      if (role === "thinking") {
        // its own indented block with a label, so reasoning reads
        // distinctly from the conversation (like the desktop app's
        // verbose thinking pane) instead of blending in.
        const label = document.createElement("span");
        label.className = "av-think-label";
        label.textContent = "thinking";
        d.appendChild(label);
        d.appendChild(document.createTextNode(text));
      } else if (role === "code") {
        // backtalk diverts a fenced block here (display-only role) so
        // the TTS never reads code aloud. Monospace, bordered,
        // whitespace preserved, its own horizontal scroll.
        const pre = document.createElement("pre");
        pre.className = "av-code-pre";
        pre.textContent = text;
        d.appendChild(pre);
      } else {
        d.textContent = text;
      }
      log.appendChild(d);
      log.scrollTop = log.scrollHeight;
    }

    function autosize() {
      input.style.height = "auto";
      input.style.height = Math.min(input.scrollHeight, innerHeight * .4) + "px";
    }
    input.addEventListener("input", () => {
      autosize();
      if (input.value) clearGhost();   // you're writing your own message now
    });

    function trySend() {
      const typed = input.value.trim();
      // Drop failed uploads; they never got a path.
      for (const e of attached.filter(a => a.failed)) dropEntry(e);
      if (attached.some(a => !a.done)) {
        // an upload is still in flight — fire the moment it settles
        sendQueued = !!(typed || attached.length);
        return;
      }
      sendQueued = false;
      const ready = attached.filter(a => a.path);
      if (!typed && !ready.length) return;
      let text = typed;
      if (ready.length)
        text += (text ? "\n\n" : "") +
          ready.map(a => "[Attached file: " + a.path + "]").join("\n");
      input.value = "";
      clearGhost();
      autosize();
      attached.length = 0;
      fileTray.textContent = "";
      fetch("/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      }).catch(() => {});
    }

    // Stop every key here from reaching a face's own shortcuts (space,
    // c, f, ...) — faces bind those on window/document with no target
    // check, so without this, typing a message would also trigger them.
    input.addEventListener("keydown", e => {
      // the toggle combo must still work with the cursor in the box: the
      // stopPropagation below (needed to shield face shortcuts) would
      // otherwise keep it from ever reaching the window listener above
      if (isToggle(e)) {
        // stop it HERE too, or it bubbles to the window listener and
        // toggles straight back (caught in the 2026-09-04 test rig)
        e.stopPropagation(); e.preventDefault(); toggleChat(); return;
      }
      e.stopPropagation();
      // Ghost suggestion: Tab (or -> in an empty box) promotes it to a
      // real, editable draft. It does NOT send -- Enter still does that.
      if (ghost && (e.key === "Tab" ||
          (e.key === "ArrowRight" && !input.value))) {
        e.preventDefault();
        input.value = ghost;
        clearGhost();
        autosize();
        return;
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        trySend();
      }
    });

    // Context-window readout in the status row. A.context is refreshed
    // every frame by tick() off the /state bus; this just formats it,
    // like the desktop app's context ring. Nothing shows until the first
    // turn publishes a number.
    const kfmt = n => n >= 1e6 ? +(n / 1e6).toFixed(1) + "M"
      : Math.round(n / 1000) + "k";
    function paintCtx() {
      const c = A.context || {};
      if (!c.max) { ctxEl.textContent = ""; return; }
      const pct = c.pct != null ? Math.round(c.pct)
        : Math.round(100 * (c.used || 0) / c.max);
      const col = pct >= 90 ? "#e0736e" : pct >= 70 ? "#e7c368"
        : "rgba(140,220,180,.55)";
      ctxEl.textContent = kfmt(c.used || 0) + " / " + kfmt(c.max)
        + " · " + pct + "%";
      const bar = document.createElement("span");
      bar.className = "av-ctx-bar";
      const fill = document.createElement("span");
      fill.className = "av-ctx-fill";
      fill.style.width = Math.max(0, Math.min(100, pct)) + "%";
      fill.style.background = col;
      bar.appendChild(fill);
      ctxEl.appendChild(bar);
    }
    paintCtx();
    setInterval(paintCtx, 1000);

    let seen = 0;
    setInterval(async () => {
      try {
        const r = await fetch("/transcript", { cache: "no-store" });
        const entries = await r.json();
        if (entries.length < seen) {
          // backtalk truncates the transcript at every launch; a face left
          // open across a restart otherwise never shows the new session's
          // first `seen` lines, and shows nothing at all until the new
          // transcript outgrows the old one
          log.replaceChildren();
          seen = 0;
          ghostSig = "";
        }
        for (let i = seen; i < entries.length; i++)
          addLine(entries[i].role, entries[i].text);
        seen = entries.length;
        maybeSuggest(entries);
      } catch (e) { /* server gone: hold what we have */ }
    }, 700);

    // Ask for one ghost suggestion per completed turn, and only when it
    // could actually be seen and used: feature on, chat visible, box empty,
    // no permission card up, the model idle, and the newest real line is
    // the assistant's. A spoken turn with the chat hidden asks for nothing.
    async function maybeSuggest(entries) {
      if (!A.suggest || ghostPending) return;
      if (wrap.style.display === "none" || input.value) return;
      if (A.state && A.state !== "idle") return;
      if (A.permission && A.permission.id) return;
      const conv = entries.filter(e =>
        e.role === "user" || e.role === "assistant");
      const last = conv[conv.length - 1];
      if (!last || last.role !== "assistant") return;
      const sig = conv.length + ":" + String(last.text || "").slice(0, 64);
      if (sig === ghostSig) return;
      ghostSig = sig;
      ghostPending = true;
      try {
        const r = await fetch("/suggest", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ turns: conv.slice(-8) }),
        });
        const s = String((await r.json()).suggestion || "").trim();
        // conditions can change during the await -- re-check before showing
        if (s && !input.value && wrap.style.display !== "none" &&
            (!A.state || A.state === "idle") &&
            !(A.permission && A.permission.id))
          showGhost(s);
      } catch (e) { /* offline or disabled: no ghost */ }
      finally { ghostPending = false; }
    }

    // A new turn -- spoken or typed -- makes any pending ghost stale.
    let ghostState = "idle";
    setInterval(() => {
      const st = A.state || "idle";
      if (st !== "idle" && ghostState === "idle") clearGhost();
      ghostState = st;
    }, 250);

    // Approve/deny card, like the desktop app's permission prompt. A.permission
    // is refreshed every frame by tick() off /state; it holds the ask the
    // voice line just spoke, or {} when none. The buttons answer through the
    // same /send seam typing uses -- "yes"/"no"/"details" -- so voice, typing,
    // and a click are one path. The card clears itself the instant the voice
    // line removes .voice_permission (any answer resolves it).
    let permShown = "";   // "<id>|<phase>" on screen now, "" = hidden
    function hidePerm() {
      permEl.textContent = "";
      permEl.classList.remove("av-perm-on");
      wrap.classList.remove("av-perm-active");
      permShown = "";
      requestAnimationFrame(() => { log.scrollTop = log.scrollHeight; });
    }
    function sendWord(text) {
      fetch("/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      }).catch(() => {});
    }
    function paintPerm() {
      const p = A.permission || {};
      const fresh = p.id && (!p.ts || Date.now() / 1000 - p.ts < 300);
      if (!fresh) { if (permShown) hidePerm(); return; }
      const key = p.id + "|" + (p.phase || "ask");
      if (key === permShown) return;
      permShown = key;
      permEl.replaceChildren();
      permEl.classList.add("av-perm-on");
      wrap.classList.add("av-perm-active");
      if (wrap.style.display === "none") wrap.style.display = "";
      const q = document.createElement("div");
      q.className = "av-perm-q";
      q.textContent = p.phase === "detail"
        ? "Details — I want to " + (p.detail || p.what || "act") + "."
        : "Claude wants to " + (p.what || "act") + "."
          + (p.detail ? "\n\n" + p.detail : "");
      const row = document.createElement("div");
      row.className = "av-perm-btns";
      const mk = (label, word, cls, keep) => {
        const b = document.createElement("button");
        b.type = "button";
        b.textContent = label;
        if (cls) b.className = cls;
        b.addEventListener("click", () => {
          sendWord(word);
          if (!keep) hidePerm();
        });
        return b;
      };
      row.appendChild(mk("Yes", "yes", "av-perm-yes"));
      row.appendChild(mk("No", "no", "av-perm-no"));
      if (p.phase !== "detail")
        row.appendChild(mk("Details", "details", "", true));
      permEl.appendChild(q);
      permEl.appendChild(row);
      requestAnimationFrame(() => { log.scrollTop = log.scrollHeight; });
    }
    setInterval(paintPerm, 200);
  }

  /* ------------------------------ shot harness ----------------------------- */
  // Runs the face's frame() deterministically (a synchronous burst of t ms).
  // A headless browser resizes the window and finishes loading images AFTER
  // the first burst, so the burst re-runs on resize and on two late timers
  // (the last one flags "ready"), then keeps painting at frame pace so the
  // late capture always sees a fresh composite.
  A.shotRun = (frame) => {
    const burst = () => { for (let t = 0; t < SHOT_T; t += 16.6) frame(16.6); };
    burst();
    addEventListener("resize", burst);
    setTimeout(burst, 450);
    setTimeout(burst, 900);
    setTimeout(() => { burst(); document.title = "ready"; }, 3000);
    // fat 100ms steps: assets that finish loading after the last burst
    // still reach their steady state within a few paints
    const loop = () => { frame(100); requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
  };

  /* -------------------------------- panels --------------------------------- */
  // Glanceable side cards in the empty space either side of the chat box.
  // OPT-IN ("panels" in ai-visualizer.json, see server.py /panels). Right
  // column opens with a live-session card built here off A.session (so it
  // follows a spoken model switch within a second); every other card comes
  // from /panels, polled once a minute. Injected once so every face gets it.
  // Hidden during a face's cinematic mode (body.cine), with ?nopanels, or
  // any time with Ctrl+. (period).
  function panelsInit() {
    if (SHOT || DEMO) return;
    const L = document.createElement("div"), R = document.createElement("div");
    L.id = "av-panels-l"; R.id = "av-panels-r";
    L.className = R.className = "av-panels";
    const style = document.createElement("style");
    style.textContent = `
      .av-panels{position:fixed;top:max(190px,20vh);bottom:110px;z-index:20;
        width:min(560px,calc((100vw - min(960px,86vw)) / 2 - 100px));
        display:flex;flex-direction:column;gap:16px;overflow:hidden;
        pointer-events:none;transition:opacity .7s;
        font:14px/1.55 "SF Mono",ui-monospace,Menlo,Consolas,monospace;
        color:#c5dccf}
      #av-panels-l{left:56px} #av-panels-r{right:56px}
      body.cine .av-panels{opacity:0}
      .av-panels.av-off{display:none}
      @media (max-width:1500px){.av-panels{display:none}}
      .av-card{flex:0 0 auto;background:rgba(6,18,12,.55);
        backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);
        border:1px solid rgba(61,220,132,.16);border-radius:6px;
        padding:12px 16px 13px;box-shadow:0 8px 28px rgba(0,0,0,.3)}
      .av-card-t{font-size:12px;letter-spacing:.3em;text-transform:uppercase;
        color:#6f8f80;margin-bottom:7px;white-space:nowrap;overflow:hidden;
        text-overflow:ellipsis}
      .av-card-note{color:#8b857b;font-style:italic}
      .av-row{display:flex;gap:12px;align-items:baseline;min-width:0}
      .av-row .av-l{flex:0 0 auto;min-width:5.5em;color:#6f8f80;
        letter-spacing:.06em}
      .av-row .av-l:empty{display:none}
      .av-row .av-v{flex:1 1 auto;min-width:0;color:#dfeee6;
        white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .av-row.av-hot .av-l,.av-row.av-hot .av-v{color:#ff9a7a}
      .av-head{margin:8px 0 2px;font-size:11.5px;letter-spacing:.22em;
        text-transform:uppercase;color:#4f7a66}
      .av-bar{height:3px;border-radius:2px;margin:3px 0 5px;
        background:rgba(255,255,255,.08);overflow:hidden}
      .av-bar span{display:block;height:100%;background:rgba(61,220,132,.6)}
    `;
    document.head.appendChild(style);
    document.body.appendChild(L);
    document.body.appendChild(R);
    const setOff = off => { L.classList.toggle("av-off", off);
                            R.classList.toggle("av-off", off); };
    setOff(Q.has("nopanels"));
    addEventListener("keydown", e => {
      if (e.ctrlKey && !e.altKey && !e.metaKey &&
          (e.code === "Period" || e.key === ".")) {
        e.preventDefault();
        setOff(!L.classList.contains("av-off"));
      }
    });

    const el = (tag, cls, text) => {
      const n = document.createElement(tag);
      if (cls) n.className = cls;
      if (text != null) n.textContent = String(text);
      return n;
    };
    function cardEl(c) {
      const card = el("div", "av-card");
      card.appendChild(el("div", "av-card-t", c.title || ""));
      if (c.note) card.appendChild(el("div", "av-card-note", c.note));
      for (const r of c.rows || []) {
        if (r.head) { card.appendChild(el("div", "av-head", r.head)); continue; }
        const row = el("div", "av-row" + (r.hot ? " av-hot" : ""));
        row.appendChild(el("span", "av-l", r.label || ""));
        row.appendChild(el("span", "av-v", r.value == null ? "" : r.value));
        card.appendChild(row);
        const pct = Number(r.pct);
        if (r.pct != null && isFinite(pct)) {
          const bar = el("div", "av-bar"), fill = el("span");
          fill.style.width = Math.max(0, Math.min(100, pct)) + "%";
          bar.appendChild(fill);
          card.appendChild(bar);
        }
      }
      return card;
    }
    function sessionCard() {
      const lv = A.live ? A.live() : {};
      const P = A.pretty || { model: String, mode: String, title: String };
      const rows = [];
      if (lv.degraded)
        rows.push({ label: "Brain", value: "Local backup", hot: true });
      rows.push({ label: "Model", value: P.model(lv.model) || "—" });
      rows.push({ label: "Effort", value: P.title(lv.effort) || "—" });
      rows.push({ label: "Perms", value: P.mode(lv.mode) || "—",
                  hot: lv.mode === "bypassPermissions" });
      if (lv.mic) rows.push({ label: "Mic", value:
        lv.mic === "open" ? "Hands-free" : "Push to talk" });
      if (lv.turns != null) rows.push({ label: "Turns", value: lv.turns });
      if (lv.cost != null) rows.push({ label: "Cost",
        value: "$" + Number(lv.cost).toFixed(2) });
      return { id: "session", side: "right", title: "Session", rows };
    }

    let served = [], lastSig = "";
    function paint() {
      const cards = [sessionCard()].concat(served);
      const sig = JSON.stringify(cards);
      if (sig === lastSig) return;       // repaint only on a real change
      lastSig = sig;
      const left = [], right = [];
      for (const c of cards) (c.side === "right" ? right : left).push(cardEl(c));
      L.replaceChildren(...left);
      R.replaceChildren(...right);
    }
    async function pull() {
      try {
        const r = await fetch("/panels", { cache: "no-store" });
        served = ((await r.json()).cards || []);
      } catch (e) { /* server gone: keep the last cards */ }
      paint();
    }
    A.ready(a => {
      if (!a.panels) { L.remove(); R.remove(); style.remove(); return; }
      pull();
      setInterval(pull, 60000);
      setInterval(paint, 1000);
    });
  }

  /* ---------------------------------- init --------------------------------- */
  A.init = (opts = {}) => {
    A._mic = !!opts.mic;
    if (A._mic && !DEMO) micStart();
    if (opts.sound !== false) soundInit(); else A._sndWant = false;
    chatInit();
    panelsInit();
    cursorInit();
    if (DEMO) {
      applyConfig({ name: Q.get("name") || "JARVIS" });
    } else {
      fetch("/config", { cache: "no-store" })
        .then(r => r.json()).then(applyConfig)
        .catch(() => applyConfig({}));
    }
    return A;
  };

  A.tick = tick;

  /* ----------------------------- render helpers ---------------------------- */
  const U = {};
  U.dim = (c, f) => {
    f = Math.max(0, Math.min(1, f));
    return `rgb(${c[0] * f | 0},${c[1] * f | 0},${c[2] * f | 0})`;
  };
  U.rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;

  // How long until a usage window resets, in the shortest honest unit.
  U.relTime = (ep) => {
    const d = ep - Date.now() / 1000;
    if (!(d > 0)) return "";
    if (d < 3600) return Math.round(d / 60) + "m";
    if (d < 86400) return Math.round(d / 3600) + "h";
    return Math.round(d / 86400) + "d";
  };

  // The plan-usage windows, formatted ONCE for every face that draws them.
  // Lives here rather than in each face because four copies of one format
  // drift apart silently, and the first symptom is two faces disagreeing
  // about the same number.
  //
  // Returns [] when the voice line publishes no usage, so a face can call
  // it unconditionally and simply draw nothing when there is nothing to say.
  // A window that is KNOWN but has no percentage yet still returns a row:
  // hiding it entirely was the original bug, and a row that says "no number
  // yet" is information where a missing row is just confusing.
  U.usageRows = () => {
    const rl = A.rateLimits || {};
    const out = [];
    for (const [label, w] of [["5H", rl.five_hour], ["7D", rl.seven_day]]) {
      if (!w) continue;
      const known = w.utilization != null;
      const pct = known ? Math.round(w.utilization * 100) : null;
      const rel = w.resets_at ? U.relTime(w.resets_at) : "";
      out.push({
        label, pct, known,
        hot: known && pct >= 80,
        text: (known ? pct + "%" : "\u2014") + (rel ? "  " + rel : "")
      });
    }
    return out;
  };
  U.mix = (c1, c2, t) => [c1[0] + (c2[0] - c1[0]) * t | 0,
                          c1[1] + (c2[1] - c1[1]) * t | 0,
                          c1[2] + (c2[2] - c1[2]) * t | 0];
  // soft additive glow sprite (canvas), cached by the caller
  U.makeGlow = (rgb, size) => {
    const c = document.createElement("canvas");
    c.width = c.height = size;
    const g = c.getContext("2d");
    const grd = g.createRadialGradient(size / 2, size / 2, 0,
                                       size / 2, size / 2, size / 2);
    grd.addColorStop(0, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},1)`);
    grd.addColorStop(.25, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},.55)`);
    grd.addColorStop(1, "rgba(0,0,0,0)");
    g.fillStyle = grd;
    g.fillRect(0, 0, size, size);
    return c;
  };
  // the one-field bloom rule: draw everything luminous into one field
  // canvas, bloom the WHOLE field (two downscale taps), composite
  // additively — bloom applied per-element reads as pencil lines
  U.bloomBlit = (dst, field, w, h) => {
    if (!field._b4 || field._b4.width !== w >> 2) {
      field._b4 = document.createElement("canvas");
      field._b4.width = Math.max(1, w >> 2);
      field._b4.height = Math.max(1, h >> 2);
      field._b8 = document.createElement("canvas");
      field._b8.width = Math.max(1, w >> 3);
      field._b8.height = Math.max(1, h >> 3);
    }
    const g4 = field._b4.getContext("2d"), g8 = field._b8.getContext("2d");
    g4.clearRect(0, 0, field._b4.width, field._b4.height);
    g4.drawImage(field, 0, 0, field._b4.width, field._b4.height);
    g8.clearRect(0, 0, field._b8.width, field._b8.height);
    g8.drawImage(field, 0, 0, field._b8.width, field._b8.height);
    const prev = dst.globalCompositeOperation;
    dst.globalCompositeOperation = "lighter";
    dst.drawImage(field, 0, 0);
    dst.drawImage(field._b4, 0, 0, w, h);
    dst.drawImage(field._b8, 0, 0, w, h);
    dst.globalCompositeOperation = prev;
  };
  // text that resolves out of glyph noise, left to right
  U.Descrambler = class {
    constructor(text, perChar = 50, hold = null) {
      this.text = text; this.per = perChar; this.hold = hold;
      this.t = 0; this.done = false;
      this.chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789#$%&";
    }
    render(dt) {
      this.t += dt;
      const n = this.t / this.per | 0;
      let out = "";
      for (let i = 0; i < this.text.length; i++) {
        const ch = this.text[i];
        out += (i < n || ch === " ") ? ch
          : this.chars[Math.random() * this.chars.length | 0];
      }
      if (this.hold != null && this.t > this.per * this.text.length + this.hold)
        this.done = true;
      return out;
    }
  };
  A.util = U;

  return A;
})();
