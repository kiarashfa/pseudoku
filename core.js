/* ============================================================
   LUMON INDUSTRIES — MACRODATA REFINEMENT
   core.js — shared foundation for every screen.

   Contents (in dependency order):
     constants / corpora   TEMPERS, MESSAGES, CATECHISMS, FALLBACK, ...
     util                  $, $$, fmtTime, toast
     SudokuEngine          pure solver / generator / validator (no DOM)
     Store                 localStorage-backed session state
     Sound                 WebAudio blips + ambient hum
     Corporate             tiered corporate-message system
     Field                 intake drifting-number canvas
     Interstitial          the "FILE ACCEPTED / COMPLETE" beat
     badge helpers         getEmployeeId, randomFileCode

   Everything here is imported by sudoku.js, ocr.js, floor.js
   and app.js. core.js itself imports nothing.
   ============================================================ */

/* ---- constants / config ---- */
export const TEMPERS = {
  woe:    { label: "WOE",    clues: 42 },
  frolic: { label: "FROLIC", clues: 34 },
  dread:  { label: "DREAD",  clues: 28 },
  malice: { label: "MALICE", clues: 24 },
};

export const ERROR_THRESHOLD = 5; // PHASE2: triggers Break Room modal on reach

export const STORE_KEY = "mdr.session.v1";

// Kier Eagan catechism — fictional corporate scripture (Phase 2 full set).
export const CATECHISMS = [
  "The remembered man does not decay.",
  "Keep a merry humor ever in your heart.",
  "Let not weakness live in your veins.",
  "Tame in me the tempers four.",
  "A handshake is available upon request.",
  "Be ever merry.",
  "Industry is the truest devotion.",
  "The work is mysterious and important.",
  "What I hold is given freely, and given back.",
  "Let not the wantons of imbalance keep you from the light.",
  "I am a vessel for the company's purpose.",
  "Sweetness follows the diligent hand.",
];

// Corporate message corpus — three tonal tiers (Phase 2 message system).
export const MESSAGES = {
  friendly: [
    "Your outie would be proud of this refinement.",
    "Lumon appreciates your commitment to numerical integrity.",
    "Every refined file strengthens the company.",
    "Praise Kier.",
    "Your work is mysterious and important.",
    "A merry humor has been logged in your file.",
    "Refinement of this caliber honors the founder.",
  ],
  passive: [
    "Productivity has fallen below acceptable standards.",
    "Excessive contemplation detected.",
    "Please remember that refinement is its own reward.",
    "Curiosity is not part of your assigned workflow.",
    "A reminder that your wellness is monitored.",
    "Idle hands refine no files.",
    "Your hesitation has been noted, without judgment.",
  ],
  creepy: [
    "The numbers know where they belong.",
    "Kier sees your progress.",
    "This file appears unusually emotional.",
    "Your continued compliance is appreciated.",
    "We have always been refining. We will always be refining.",
    "The light in the Break Room is always on for you.",
    "Somewhere, your outie feels a warmth they cannot explain.",
  ],
};

export const IDLE_MS = 22000; // passive-aggressive nudge after this much inactivity
export const CREEPY_CHANCE = 0.12; // low-probability creepy roll on neutral events

// Fallback bank: one solvable puzzle per temper (givens|solution not needed,
// generator is primary; this is just insurance).
export const FALLBACK = {
  woe:    "530070000600195000098000060800060003400803001700020006060000280000419005000080079",
  frolic: "000260701680070090190004500820100040004602900050003028009300074040050036703018000",
  dread:  "000000907000420180000705026100904000050000040000507009920108000034059000507000000",
  malice: "100007090030020008009600500005300900010080002600004000300000010040000007007000300",
};

/* ---- util ---- */
let toastTimer = null;
export const $ = (s, el = document) => el.querySelector(s);
export const $$ = (s, el = document) => [...el.querySelectorAll(s)];

export function fmtTime(ms) {
  if (!ms || ms < 0) return "--:--";
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

export function toast(msg, tier) {
  let el = $(".toast");
  if (!el) { el = document.createElement("div"); el.className = "toast"; document.body.appendChild(el); }
  el.className = "toast" + (tier ? " toast--" + tier : "");
  el.innerHTML = '<span class="toast__mark">LUMON NOTICE</span><span class="toast__msg"></span>';
  el.querySelector(".toast__msg").textContent = msg;
  // force reflow so re-triggering animates
  void el.offsetWidth;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 3200);
}

/* ---- SudokuEngine (pure) ---- */
export const SudokuEngine = (function () {

  // Parse an 81-char string ("0"/"." = blank) into Int array (0 = blank).
  function parse(str) {
    const clean = str.replace(/[.\s]/g, "0").trim();
    if (clean.length !== 81 || /[^0-9]/.test(clean)) return null;
    return clean.split("").map(Number);
  }

  function toString(grid) {
    return grid.map((n) => (n === 0 ? "0" : n)).join("");
  }

  // Is value v legal at index i (row-major 0..80) given current grid?
  function isLegal(grid, i, v) {
    const r = Math.floor(i / 9), c = i % 9;
    for (let k = 0; k < 9; k++) {
      if (grid[r * 9 + k] === v) return false;          // row
      if (grid[k * 9 + c] === v) return false;          // col
    }
    const br = Math.floor(r / 3) * 3, bc = Math.floor(c / 3) * 3;
    for (let dr = 0; dr < 3; dr++)
      for (let dc = 0; dc < 3; dc++)
        if (grid[(br + dr) * 9 + (bc + dc)] === v) return false; // box
    return true;
  }

  // Find the empty cell with the fewest candidates (MRV heuristic).
  function findBestCell(grid) {
    let best = -1, bestCount = 10, bestCands = null;
    for (let i = 0; i < 81; i++) {
      if (grid[i] !== 0) continue;
      const cands = [];
      for (let v = 1; v <= 9; v++) if (isLegal(grid, i, v)) cands.push(v);
      if (cands.length === 0) return { i, cands: [] }; // dead end
      if (cands.length < bestCount) {
        best = i; bestCount = cands.length; bestCands = cands;
        if (bestCount === 1) break;
      }
    }
    return best === -1 ? null : { i: best, cands: bestCands };
  }

  // Solve in place. Returns true if solved.
  function solve(grid) {
    const spot = findBestCell(grid);
    if (spot === null) return true;        // no empties -> solved
    if (spot.cands.length === 0) return false;
    for (const v of spot.cands) {
      grid[spot.i] = v;
      if (solve(grid)) return true;
      grid[spot.i] = 0;
    }
    return false;
  }

  // Count solutions up to `limit` (used for uniqueness test).
  function countSolutions(grid, limit) {
    let count = 0;
    (function rec() {
      if (count >= limit) return;
      const spot = findBestCell(grid);
      if (spot === null) { count++; return; }
      if (spot.cands.length === 0) return;
      for (const v of spot.cands) {
        grid[spot.i] = v;
        rec();
        grid[spot.i] = 0;
        if (count >= limit) return;
      }
    })();
    return count;
  }

  function hasUniqueSolution(grid) {
    return countSolutions(grid.slice(), 2) === 1;
  }

  // --- Generation -------------------------------------------------
  function shuffle(a) {
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  // Build a complete, valid, randomized solution grid.
  function generateFull() {
    const grid = new Array(81).fill(0);
    (function fill() {
      const spot = findBestCell(grid);
      if (spot === null) return true;
      for (const v of shuffle(spot.cands.slice())) {
        grid[spot.i] = v;
        if (fill()) return true;
        grid[spot.i] = 0;
      }
      return false;
    })();
    return grid;
  }

  // Carve a puzzle from a full solution down toward `targetClues`,
  // preserving a unique solution. Returns { puzzle, solution }.
  function generate(targetClues) {
    const solution = generateFull();
    const puzzle = solution.slice();
    const order = shuffle([...Array(81).keys()]);
    let clues = 81;
    for (const idx of order) {
      if (clues <= targetClues) break;
      const backup = puzzle[idx];
      if (backup === 0) continue;
      puzzle[idx] = 0;
      if (hasUniqueSolution(puzzle)) {
        clues--;
      } else {
        puzzle[idx] = backup; // revert — removing it broke uniqueness
      }
    }
    return { puzzle, solution };
  }

  // Validate a (possibly partial) grid: returns Set of conflicting indices.
  function findConflicts(grid) {
    const bad = new Set();
    const groups = [];
    for (let r = 0; r < 9; r++) groups.push([...Array(9)].map((_, c) => r * 9 + c));
    for (let c = 0; c < 9; c++) groups.push([...Array(9)].map((_, r) => r * 9 + c));
    for (let b = 0; b < 9; b++) {
      const br = Math.floor(b / 3) * 3, bc = (b % 3) * 3;
      const g = [];
      for (let dr = 0; dr < 3; dr++) for (let dc = 0; dc < 3; dc++)
        g.push((br + dr) * 9 + (bc + dc));
      groups.push(g);
    }
    for (const g of groups) {
      const seen = {};
      for (const i of g) {
        const v = grid[i];
        if (v === 0) continue;
        if (seen[v] !== undefined) { bad.add(i); bad.add(seen[v]); }
        else seen[v] = i;
      }
    }
    return bad;
  }

  return {
    parse, toString, isLegal, solve, hasUniqueSolution,
    generate, generateFull, findConflicts,
  };
})();

/* ---- Store ---- */
export const Store = (function () {
  const defaults = {
    temper: "woe",
    puzzle: null,      // 81-char givens string
    solution: null,    // 81-char solution string
    progress: null,    // 81-char current user grid
    givenMask: null,   // 81-char "1"/"0"
    filesRefined: 0,
    totalTimeMs: 0,    // for avg time
    muted: false,
    ambient: false,    // low hum toggle
    screen: "intake",
    employeeId: null,  // persisted MDR-#### badge
    waffleUnlocked: false,
    floorFilesComplete: 0, // Phase 4: refinement-floor files completed
  };
  let state = load();

  function load() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (!raw) return { ...defaults };
      return { ...defaults, ...JSON.parse(raw) };
    } catch (e) { return { ...defaults }; }
  }
  function save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); }
    catch (e) { /* storage may be unavailable; degrade gracefully */ }
  }
  function get(k) { return state[k]; }
  function set(obj) { Object.assign(state, obj); save(); }
  return { get, set, all: () => state };
})();

/* ---- Sound ---- */
export const Sound = (function () {
  let ctx = null;
  function ensure() {
    if (!ctx) { try { ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) {} }
    return ctx;
  }
  function blip(freq = 440, dur = 0.05, type = "sine", gain = 0.04) {
    if (Store.get("muted")) return;
    const c = ensure(); if (!c) return;
    const o = c.createOscillator(), g = c.createGain();
    o.type = type; o.frequency.value = freq;
    g.gain.value = gain;
    o.connect(g); g.connect(c.destination);
    o.start();
    g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + dur);
    o.stop(c.currentTime + dur + 0.02);
  }

  // Low ambient hum — sterile office drone. Toggled via Store.ambient.
  let humOsc = null, humGain = null, humLfo = null;
  function startHum() {
    const c = ensure(); if (!c || humOsc) return;
    humOsc = c.createOscillator(); humGain = c.createGain();
    humLfo = c.createOscillator();
    const lfoGain = c.createGain();
    humOsc.type = "sine"; humOsc.frequency.value = 58;
    humLfo.type = "sine"; humLfo.frequency.value = 0.18; lfoGain.gain.value = 0.004;
    humGain.gain.value = Store.get("muted") ? 0 : 0.012;
    humLfo.connect(lfoGain); lfoGain.connect(humGain.gain);
    humOsc.connect(humGain); humGain.connect(c.destination);
    humOsc.start(); humLfo.start();
  }
  function stopHum() {
    if (humOsc) { try { humOsc.stop(); humLfo.stop(); } catch (e) {} humOsc = humLfo = humGain = null; }
  }
  function refreshHum() {
    if (Store.get("ambient")) startHum(); else stopHum();
    if (humGain) humGain.gain.value = Store.get("muted") ? 0 : 0.012;
  }

  return {
    key:    () => blip(620, 0.04, "square", 0.025),
    select: () => blip(380, 0.03, "sine", 0.02),
    ok:     () => blip(720, 0.08, "sine", 0.04),
    err:    () => blip(160, 0.12, "sawtooth", 0.05),
    settle: () => blip(880 + Math.random() * 200, 0.05, "sine", 0.03),
    chime:  () => { blip(880, 0.18, "sine", 0.035); setTimeout(() => blip(1320, 0.22, "sine", 0.025), 90); },
    done:   () => { blip(523, 0.1); setTimeout(() => blip(659, 0.1), 110); setTimeout(() => blip(784, 0.18), 220); },
    alarm:  () => { blip(220, 0.25, "sawtooth", 0.05); setTimeout(() => blip(180, 0.3, "sawtooth", 0.05), 180); },
    refreshHum, ensure,
  };
})();

/* ---- Corporate ---- */
export const Corporate = (function () {
  let idleTimer = null;
  let lastPick = "";

  function pick(tier) {
    const pool = MESSAGES[tier] || MESSAGES.friendly;
    let msg = pool[Math.floor(Math.random() * pool.length)];
    if (msg === lastPick && pool.length > 1) {
      msg = pool[(pool.indexOf(msg) + 1) % pool.length];
    }
    lastPick = msg;
    return msg;
  }

  // Show a tiered corporate notice. tier: friendly|passive|creepy
  function notify(tier) {
    // small chance any neutral notice is overtaken by the creepy tier
    if (tier !== "creepy" && Math.random() < CREEPY_CHANCE) tier = "creepy";
    toast(pick(tier), tier);
  }

  function friendly() { notify("friendly"); }
  function passive()  { notify("passive"); }
  function creepy()   { notify("creepy"); }

  // Idle detection — only meaningful on the console screen.
  function resetIdle() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (!$("#screen-console").hidden) { passive(); resetIdle(); }
    }, IDLE_MS);
  }
  function stopIdle() { clearTimeout(idleTimer); }

  return { notify, friendly, passive, creepy, resetIdle, stopIdle };
})();

/* ---- Field ---- */
export const Field = (function () {
  let canvas, ctx, nums = [], raf = null, mouse = { x: -999, y: -999 };
  let reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  function init() {
    canvas = $("#field-canvas");
    ctx = canvas.getContext("2d");
    resize();
    window.addEventListener("resize", resize);
    canvas.addEventListener("pointermove", (e) => {
      const r = canvas.getBoundingClientRect();
      mouse.x = e.clientX - r.left; mouse.y = e.clientY - r.top;
    });
    canvas.addEventListener("pointerleave", () => { mouse.x = -999; mouse.y = -999; });
    seed();
  }

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = canvas.offsetWidth * dpr;
    canvas.height = canvas.offsetHeight * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function seed() {
    const W = canvas.offsetWidth, H = canvas.offsetHeight;
    const count = Math.min(110, Math.floor((W * H) / 9000));
    nums = [];
    for (let i = 0; i < count; i++) {
      nums.push({
        x: Math.random() * W, y: Math.random() * H,
        val: Math.floor(Math.random() * 10),
        vx: (Math.random() - 0.5) * 0.18,
        vy: (Math.random() - 0.5) * 0.18,
        size: 12 + Math.random() * 16,
        phase: Math.random() * Math.PI * 2,
        speed: 0.4 + Math.random() * 0.8,
        base: 0.18 + Math.random() * 0.25,
      });
    }
  }

  function frame(t) {
    const W = canvas.offsetWidth, H = canvas.offsetHeight;
    ctx.clearRect(0, 0, W, H);
    const time = t / 1000;
    for (const n of nums) {
      if (!reduced) { n.x += n.vx; n.y += n.vy; }
      if (n.x < -20) n.x = W + 20; if (n.x > W + 20) n.x = -20;
      if (n.y < -20) n.y = H + 20; if (n.y > H + 20) n.y = -20;

      // breathing scale
      const breathe = reduced ? 1 : 1 + Math.sin(time * n.speed + n.phase) * 0.12;

      // hover reaction: jitter + brighten ("scary number")
      const dx = n.x - mouse.x, dy = n.y - mouse.y;
      const dist = Math.hypot(dx, dy);
      let jx = 0, jy = 0, bright = n.base, scale = breathe;
      if (dist < 60 && !reduced) {
        const k = (60 - dist) / 60;
        jx = (Math.random() - 0.5) * 5 * k;
        jy = (Math.random() - 0.5) * 5 * k;
        bright = n.base + k * 0.7;
        scale = breathe * (1 + k * 0.4);
      }

      const sz = n.size * scale;
      ctx.font = `700 ${sz}px "IBM Plex Mono", monospace`;
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.shadowColor = "rgba(127,223,255,0.8)";
      ctx.shadowBlur = bright > 0.4 ? 12 : 4;
      ctx.fillStyle = `rgba(127,223,255,${bright})`;
      ctx.fillText(n.val, n.x + jx, n.y + jy);
    }
    ctx.shadowBlur = 0;
    raf = requestAnimationFrame(frame);
  }

  function start() { if (!raf) raf = requestAnimationFrame(frame); }
  function stop()  { if (raf) { cancelAnimationFrame(raf); raf = null; } }

  return { init, start, stop };
})();

/* ---- Interstitial ---- */
export const Interstitial = (function () {
  function show(text) {
    let el = $("#interstitial");
    if (!el) {
      el = document.createElement("div");
      el.id = "interstitial";
      el.className = "interstitial";
      el.innerHTML = '<div class="interstitial__text"></div>';
      document.body.appendChild(el);
    }
    el.querySelector(".interstitial__text").textContent = text;
    el.classList.remove("show"); void el.offsetWidth;
    el.classList.add("show");
    Sound.ok();
    setTimeout(() => el.classList.remove("show"), 800);
  }
  return { show };
})();

/* ---- employee identity helpers ---- */
export function getEmployeeId() {
  let id = Store.get("employeeId");
  if (!id) {
    id = "MDR-" + (1000 + Math.floor(Math.random() * 9000));
    Store.set({ employeeId: id });
  }
  return id;
}
export function randomFileCode() {
  const L = "ABCDEFGHJKLMNPRSTUVWXY";
  return (10 + Math.floor(Math.random() * 89)) +
    L[Math.floor(Math.random() * L.length)] + "-" +
    (1 + Math.floor(Math.random() * 9));
}

