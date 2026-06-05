/* ============================================================
   floor.js — The Refinement Floor (Phase 4): the standalone
   macrodata mini-game, rebuilt as a faithful CRT-terminal screen.

   THE TASK (true Macrodata Refinement, not value-sorting):
     - Every cell carries a HIDDEN temper tag (WO / FC / DR / MA),
       grown as small contiguous clusters; DR & MA are rarer and
       subtler than WO & FC.
     - A follow-cursor MAGNIFIER (fisheye) enlarges the field under
       the pointer. True clusters "feel" alive — a per-temper
       jitter/pulse — strongest under the lens.
     - You SWEEP the magnifier to gather a cluster: only the live
       (tempered) numbers under the brush highlight, so selection is
       always local and predictable.
     - Dropping into a bin is VALIDATED (too small / too large /
       mixed-temper / non-contiguous); bad sorts get the show's
       thumbs-down "Nope".
     - Each O1-O5 bin's four temper meters live INSIDE the box that
       opens above it; a bin completes only when all four are
       balanced, and the file completes only when all five are.

   Reuses Sound / Corporate / Interstitial from core.js.
   ============================================================ */
import { $, $$, Store, Sound, Corporate, Interstitial } from "./core.js";

export const RefinementFloor = (function () {

  const TAU = Math.PI * 2;

  /* ---- field constants ---- */
  const CELL = 40;               // dense grid (small numbers, like the show)
  const BASE_FS = 16;            // base glyph size
  const LENS_R = CELL * 1.6;     // magnifier radius — tight: only 2-3 glyphs lift
  const LENS_MAX = 1.7;          // peak extra scale at the cursor
  const BRUSH = CELL * 1.10;     // selection reach around the cursor (hover-grab)
  const FLOAT_LOOP = 2200;       // ms per gentle float oscillation
  const CAP = 320;               // max cells (perf)
  const BIN_COUNT = 5;
  const EMPTY_MS = 1000;         // a binned slot stays empty for 1s before refill
  const LID_RADIANS = (115 * Math.PI) / 180;  // lid swing for the upward \/ open
  const DOOR_MS = 650;           // realistic open/close duration (from old files)
  const PANEL_RISE_MS = 1700;    // slow float of the stat panel up out of the box
  const FLOAT_MS = 1500;         // slow float of numbers into the box, AFTER panel

  /* ---- the four tempers ---- */
  const FLR_TEMPERS = ["WO", "FC", "DR", "MA"];
  const TEMPER_META = {
    WO: { full: "WOE",    color: "#5fe08a", target: 8, sMin: 3, sMax: 5, want: 4, feel: 1.00 },
    FC: { full: "FROLIC", color: "#e6cf45", target: 8, sMin: 3, sMax: 5, want: 4, feel: 1.15 },
    DR: { full: "DREAD",  color: "#df5fce", target: 4, sMin: 3, sMax: 4, want: 2, feel: 0.50 },
    MA: { full: "MALICE", color: "#5f9be0", target: 4, sMin: 3, sMax: 4, want: 2, feel: 0.50 },
  };
  const SEL_MIN = 3, SEL_MAX = 16;

  const FILE_NAMES = [
    "Cold Harbour", "Siena", "Tumwolt", "Oquendo", "Allentown",
    "Culpepper", "Morrison", "Lucknow", "Nanning", "Dranesk",
  ];

  /* ---- module state ---- */
  let canvas, ctx, wrap, hintEl, binsEl, nopeEl;
  let dpr = 1, W = 0, H = 0;
  let cols = 0, rows = 0;
  let nums = [];
  let raf = null, running = false;
  let reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  let clusters = new Map();      // id -> { id, temper, cells:[idx] }
  let nextCid = 1;
  const EMPTY_SET = new Set();

  let dragging = false;
  let isTouch = false;
  let pointer = { x: -9999, y: -9999 };
  let lastPaint = { x: -9999, y: -9999 };   // previous brush point (path fill)

  let bins = [];                 // { meters:{WO,FC,DR,MA}, pinned }
  let fileName = "Cold Harbour";
  let busy = false;
  let hexTimer = null;

  const rnd10 = () => Math.floor(Math.random() * 10);

  /* =====================================================
     NUMBER MODEL
     ===================================================== */
  function makeNumber() {
    return {
      val: rnd10(),
      temper: null, cid: -1,
      horizontal: Math.random() < 0.5,
      phase: Math.random() * TAU,
      period: FLOAT_LOOP * (0.85 + Math.random() * 0.3),
      amp: 0,
      jseed: Math.random() * TAU, jseed2: Math.random() * TAU,
      state: "none",             // none | selected | empty
      glow: 0, born: 0, popping: false, scale: 1,
      emptyUntil: 0,             // ms timestamp; while > now the slot renders blank
    };
  }

  /* =====================================================
     LAYOUT
     ===================================================== */
  function layout() {
    dpr = Math.min(2, window.devicePixelRatio || 1);
    W = wrap.clientWidth; H = wrap.clientHeight;
    if (W === 0 || H === 0) return;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    canvas.style.width = W + "px";
    canvas.style.height = H + "px";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    cols = Math.max(1, Math.floor(W / CELL));
    rows = Math.max(1, Math.floor(H / CELL));
    let want = Math.min(cols * rows, CAP);
    rows = Math.max(1, Math.ceil(want / cols));

    const amp = Math.min(CELL * 0.30, (W / 6) * 0.10);
    const total = cols * rows;
    let rebuilt = false;
    if (nums.length !== total) {
      nums = [];
      for (let i = 0; i < total; i++) nums.push(makeNumber());
      rebuilt = true;
    }
    nums.forEach((n) => { n.amp = amp; });
    if (rebuilt || clusters.size === 0) seedField();
  }

  function originX() { return (W - cols * CELL) / 2; }
  function originY() { return (H - rows * CELL) / 2; }
  function cellCenter(i) {
    const c = i % cols, r = Math.floor(i / cols);
    return { x: originX() + c * CELL + CELL / 2, y: originY() + r * CELL + CELL / 2 };
  }

  /* =====================================================
     GRID ADJACENCY
     ===================================================== */
  function neighbors4(i) {
    const c = i % cols, r = Math.floor(i / cols);
    const out = [];
    if (c > 0) out.push(i - 1);
    if (c < cols - 1) out.push(i + 1);
    if (r > 0) out.push(i - cols);
    if (r < rows - 1) out.push(i + cols);
    return out;
  }
  function neighbors8(i) {
    const c = i % cols, r = Math.floor(i / cols), out = [];
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
      if (!dr && !dc) continue;
      const rr = r + dr, cc = c + dc;
      if (rr < 0 || rr >= rows || cc < 0 || cc >= cols) continue;
      out.push(rr * cols + cc);
    }
    return out;
  }

  /* =====================================================
     CLUSTER FIELD — small contiguous blobs, each fenced off
     by a neutral gap so a sweep grabs exactly one.
     ===================================================== */
  function seedField() {
    clusters.clear(); nextCid = 1;
    for (const n of nums) { n.temper = null; n.cid = -1; }
    maintainClusters();
  }

  function isClearForCluster(i, set) {
    const n = nums[i];
    if (!n || n.temper) return false;
    if (n.state === "empty") return false;   // slot is mid-cooldown; leave it blank
    for (const nb of neighbors8(i)) {
      if (set.has(nb)) continue;
      if (nums[nb] && nums[nb].temper) return false;
    }
    return true;
  }

  function growOneCluster(temper) {
    const meta = TEMPER_META[temper];
    const size = meta.sMin + Math.floor(Math.random() * (meta.sMax - meta.sMin + 1));
    const seeds = [];
    for (let i = 0; i < nums.length; i++) if (isClearForCluster(i, EMPTY_SET)) seeds.push(i);
    if (!seeds.length) return false;

    const seed = seeds[(Math.random() * seeds.length) | 0];
    const set = new Set([seed]);
    let frontier = neighbors4(seed);
    while (set.size < size && frontier.length) {
      const fi = (Math.random() * frontier.length) | 0;
      const cand = frontier.splice(fi, 1)[0];
      if (set.has(cand) || !isClearForCluster(cand, set)) continue;
      set.add(cand);
      for (const nb of neighbors4(cand)) if (!set.has(nb)) frontier.push(nb);
    }
    if (set.size < 3) return false;
    const cid = nextCid++;
    clusters.set(cid, { id: cid, temper, cells: [...set] });
    for (const i of set) { nums[i].temper = temper; nums[i].cid = cid; }
    return true;
  }

  function maintainClusters() {
    for (const t of FLR_TEMPERS) {
      const want = TEMPER_META[t].want;
      let have = 0;
      for (const cl of clusters.values()) if (cl.temper === t) have++;
      let guard = 0;
      while (have < want && guard++ < 12) {
        if (growOneCluster(t)) have++; else break;
      }
    }
  }

  function dissolveCluster(cid) {
    const cl = clusters.get(cid);
    if (!cl) return;
    for (const i of cl.cells) if (nums[i]) { nums[i].temper = null; nums[i].cid = -1; }
    clusters.delete(cid);
  }

  /* =====================================================
     SELECTION — paint only the LIVE numbers under the brush.
     Neutral noise never highlights, so what you grab is always
     exactly the cluster you swept. Predictable & merciful.
     ===================================================== */
  function indexAt(px, py) {
    const c = Math.floor((px - originX()) / CELL);
    const r = Math.floor((py - originY()) / CELL);
    if (c < 0 || c >= cols || r < 0 || r >= rows) return -1;
    return r * cols + c;
  }
  function clearAll() { for (const n of nums) n.state = "none"; }
  function selectedIndices() {
    const a = [];
    for (let k = 0; k < nums.length; k++) if (nums[k].state === "selected") a.push(k);
    return a;
  }
  function selectedCount() { return selectedIndices().length; }

  /* Select by each glyph's ACTUAL drawn position (n.rx/n.ry), not its grid
     cell. This is pointer-accurate everywhere — including the corners and the
     field edges, where grid-cell math used to fail — and it follows the float
     drift the player sees. Brushing any cell of a cluster grabs the whole
     contiguous cluster. */
  function paintPoint(px, py) {
    for (let j = 0; j < nums.length; j++) {
      const n = nums[j];
      if (!n || !n.temper || n.state === "empty") continue;
      const gx = (n.rx !== undefined) ? n.rx : cellCenter(j).x;
      const gy = (n.ry !== undefined) ? n.ry : cellCenter(j).y;
      if (Math.hypot(gx - px, gy - py) <= BRUSH) {
        const cl = clusters.get(n.cid);
        if (cl) { for (const k of cl.cells) if (nums[k]) nums[k].state = "selected"; }
        else n.state = "selected";
      }
    }
  }

  /* interpolate along the drag path so a fast sweep never skips a cluster */
  function paintAt(px, py) {
    if (lastPaint.x > -9000) {
      const dx = px - lastPaint.x, dy = py - lastPaint.y;
      const dist = Math.hypot(dx, dy);
      const steps = Math.max(1, Math.ceil(dist / (CELL * 0.5)));
      for (let s = 1; s <= steps; s++) {
        paintPoint(lastPaint.x + (dx * s) / steps, lastPaint.y + (dy * s) / steps);
      }
    } else {
      paintPoint(px, py);
    }
    lastPaint = { x: px, y: py };
  }

  /* Drop-time validation — returns {ok} or {ok:false, reason}. */
  function validateSelection(sel) {
    if (sel.length < SEL_MIN) return { ok: false, reason: "TOO SMALL" };
    if (sel.length > SEL_MAX) return { ok: false, reason: "TOO LARGE" };
    const tempers = new Set(), cids = new Set();
    for (const i of sel) {
      const n = nums[i];
      if (!n.temper) return { ok: false, reason: "MIXED TEMPER" };
      tempers.add(n.temper); cids.add(n.cid);
    }
    if (tempers.size > 1) return { ok: false, reason: "MIXED TEMPER" };
    if (cids.size > 1)    return { ok: false, reason: "NON-CONTIGUOUS" };
    return { ok: true, temper: [...tempers][0], cid: [...cids][0] };
  }

  /* =====================================================
     POINTER HANDLERS
     ===================================================== */
  function localPoint(e) {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }
  function onPointerMove(e) {
    if (busy) return;
    pointer = localPoint(e);
    if (dragging) { paintAt(pointer.x, pointer.y); hideHint(); }
  }
  function onPointerDown(e) {
    if (busy) return;
    Sound.ensure && Sound.ensure();
    isTouch = (e.pointerType === "touch");
    pointer = localPoint(e);
    lastPaint = { x: -9999, y: -9999 };
    clearAll();
    dragging = true;
    paintAt(pointer.x, pointer.y);
    if (selectedCount() > 0) { Sound.select && Sound.select(); hideHint(); }
    try { canvas.setPointerCapture(e.pointerId); } catch (_) {}
    resetIdle();
  }
  function onPointerUp() {
    if (dragging && selectedCount() > 0) Sound.key && Sound.key();
    dragging = false;
    lastPaint = { x: -9999, y: -9999 };
  }
  function onPointerLeave() {
    if (dragging) return;
    pointer = { x: -9999, y: -9999 };
  }

  /* =====================================================
     "FEELING" — per-temper motion signature (cyan, motion-only)
     ===================================================== */
  function temperMotion(n, t, prox) {
    const e = TEMPER_META[n.temper].feel;
    const g = 0.26 + 0.9 * prox;
    let jx = 0, jy = 0, b = 0;
    switch (n.temper) {
      case "WO":
        jy = Math.sin(t * 0.0016 + n.jseed) * 2.0 * e * g;
        jx = Math.cos(t * 0.0013 + n.jseed) * 0.8 * e * g;
        b = 0.13 * g; break;
      case "FC":
        jy = -Math.abs(Math.sin(t * 0.010 + n.jseed)) * 2.2 * e * g;
        jx = Math.sin(t * 0.017 + n.jseed) * 1.1 * e * g;
        b = 0.18 * g; break;
      case "DR": {
        const s = Math.sin(t * 0.022 + n.jseed) * Math.sin(t * 0.0033 + n.jseed2);
        jx = s * 1.0 * e * g;
        jy = Math.sin(t * 0.019 + n.jseed2) * 0.7 * e * g;
        b = 0.07 * g; break;
      }
      case "MA": {
        const phase = Math.sin(t * 0.004 + n.jseed);
        jx = (phase > 0.70 ? Math.sin(t * 0.085 + n.jseed2) : 0) * 1.3 * e * g;
        jy = (phase > 0.82 ? Math.sin(t * 0.078) : 0) * 0.9 * e * g;
        b = 0.07 * g; break;
      }
    }
    return { jx, jy, b };
  }

  /* =====================================================
     RENDER LOOP — float + fisheye magnifier + feeling + pop
     ===================================================== */
  function frame(t) {
    if (!running) return;
    ctx.clearRect(0, 0, W, H);
    const ox = originX(), oy = originY();
    const px = pointer.x, py = pointer.y, hasP = px > -9000;
    ctx.textAlign = "center"; ctx.textBaseline = "middle";

    for (let i = 0; i < nums.length; i++) {
      const n = nums[i];
      // a freshly-binned slot renders blank for EMPTY_MS
      if (n.state === "empty") continue;
      const c = i % cols, r = Math.floor(i / cols);
      const bx = ox + c * CELL + CELL / 2;
      const by = oy + r * CELL + CELL / 2;
      let cx = bx, cy = by;

      if (!reduced) {
        const off = Math.sin((t / n.period) * TAU + n.phase) * n.amp;
        if (n.horizontal) cx += off; else cy += off;
      }

      // magnifier (fisheye): smooth scale + reveal under the cursor
      let near = 0;
      if (hasP) {
        const d = Math.hypot(bx - px, by - py);
        if (d < LENS_R) { let k = 1 - d / LENS_R; near = k * k * (3 - 2 * k); }
      }
      const mag = 1 + LENS_MAX * near;

      // the feeling
      let feel = 0;
      if (n.temper) {
        if (reduced) feel = 0.12;
        else { const m = temperMotion(n, t, near); cx += m.jx; cy += m.jy; feel = m.b; }
      }

      // remember where this glyph is actually drawn (for pointer-accurate selection)
      n.rx = cx; n.ry = cy;

      // bouncy pop on refill
      let pop = 1;
      if (n.popping && !reduced) {
        const age = (t - n.born) / 500;
        if (age >= 1) n.popping = false;
        else pop = 1 + Math.sin(age * Math.PI) * 0.35 * (1 - age);
      }

      const sel = n.state === "selected";
      n.glow += ((sel ? 1 : 0) - n.glow) * (reduced ? 1 : 0.3);

      const fs = BASE_FS * mag * pop * (sel ? 1.08 : 1);
      ctx.font = `700 ${fs}px "IBM Plex Mono", monospace`;

      let a = 0.42 + near * 0.55 + feel;
      if (sel) a = 0.98;
      a = Math.min(1, a);

      if (sel) {
        ctx.fillStyle = `rgba(214,238,251,${a})`;
        ctx.shadowColor = "rgba(127,223,255,0.95)"; ctx.shadowBlur = 13 + near * 9;
      } else {
        ctx.fillStyle = `rgba(140,226,255,${a})`;
        ctx.shadowColor = "rgba(127,223,255,0.6)"; ctx.shadowBlur = 3 + near * 13;
      }
      ctx.fillText(String(n.val), cx, cy);
    }
    ctx.shadowBlur = 0;
    raf = requestAnimationFrame(frame);
  }

  /* =====================================================
     THE BOX DOOR — Design 1 "Original Revival": two line-lids hinged
     at the box mouth, swinging UP and OUTWARD (\/), with a growing
     perspective shadow. No front-face rectangle — just the lids.
     Driven by one openProgress (0..1) and tweened by setDoorOpen.
     ===================================================== */
  function lidSVG(openProgress) {
    const VW = 100, VH = 60;
    const boxW = 86;                          // mouth width (= lid span)
    const shadowOffsetMax = 6;
    const startX = (VW - boxW) / 2;
    const mouthY = VH - 6;                     // hinge line sits near the BOTTOM

    const hL = { x: startX, y: mouthY };          // left hinge (mouth corner)
    const hR = { x: startX + boxW, y: mouthY };   // right hinge (mouth corner)
    const mid = { x: startX + boxW / 2, y: mouthY };

    const rad = openProgress * LID_RADIANS;

    // each lid starts flat from its hinge to the mouth centre, then swings UP
    // and OUT: rotate the centre point about each hinge. Left lid CCW (tip
    // up-left), right lid CW (tip up-right) -> the classic \/ opening.
    const rotpt = (px, py, ox, oy, a) => ({
      x: ox + (px - ox) * Math.cos(a) - (py - oy) * Math.sin(a),
      y: oy + (px - ox) * Math.sin(a) + (py - oy) * Math.cos(a),
    });
    const lidL = rotpt(mid.x, mid.y, hL.x, hL.y, -rad);
    const lidR = rotpt(mid.x, mid.y, hR.x, hR.y, +rad);

    const off = shadowOffsetMax * openProgress;
    const shLidL = { x: lidL.x, y: lidL.y + off };
    const shLidR = { x: lidR.x, y: lidR.y + off };

    const L = (a, b) => `M ${a.x.toFixed(2)} ${a.y.toFixed(2)} L ${b.x.toFixed(2)} ${b.y.toFixed(2)}`;
    const lids = `${L(hL, lidL)} ${L(hR, lidR)}`;
    const shadow = `${L(hL, shLidL)} ${L(hR, shLidR)}`;

    return `<svg viewBox="0 0 ${VW} ${VH}" preserveAspectRatio="none" aria-hidden="true">
      <path class="door-shadow" d="${shadow}"></path>
      <path class="door-lid" d="${lids}"></path>
    </svg>`;
  }

  function setDoorOpen(i, v) {
    const host = document.getElementById("floor-door-" + i);
    if (host) host.innerHTML = lidSVG(v);
  }

  /* eased tween; snaps instantly under reduced motion */
  function tween(ms, ease, onUpdate) {
    return new Promise((resolve) => {
      if (reduced || ms <= 0) { onUpdate(1); return resolve(); }
      const start = performance.now();
      (function step(now) {
        const k = Math.min(1, (now - start) / ms);
        onUpdate(ease ? ease(k) : k);
        if (k < 1) requestAnimationFrame(step); else resolve();
      })(performance.now());
    });
  }
  const easeInOut = (k) => (k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2);

  /* =====================================================
     BINS — O1..O5; the four temper meters live in the box
     that opens above each bin.
     ===================================================== */
  function makeBins() {
    bins = [];
    for (let i = 0; i < BIN_COUNT; i++) bins.push({ meters: { WO: 0, FC: 0, DR: 0, MA: 0 }, pinned: false });
  }
  function binComplete(b) { return FLR_TEMPERS.every((t) => b.meters[t] >= TEMPER_META[t].target); }
  function binProgress(b) {
    let s = 0;
    for (const t of FLR_TEMPERS) s += Math.min(1, b.meters[t] / TEMPER_META[t].target);
    return s / FLR_TEMPERS.length;
  }
  function fileProgress() {
    let filled = 0, total = 0;
    for (const b of bins) for (const t of FLR_TEMPERS) {
      const tg = TEMPER_META[t].target;
      filled += Math.min(tg, b.meters[t]); total += tg;
    }
    return total ? filled / total : 0;
  }

  function buildBins() {
    binsEl.innerHTML = "";
    bins.forEach((b, i) => {
      const code = "O" + (i + 1);
      const meters = FLR_TEMPERS.map((t) => `
        <div class="floor-meter" data-t="${t}">
          <span class="floor-meter__lbl">${t}</span>
          <span class="floor-meter__track"><span class="floor-meter__bar" style="--c:${TEMPER_META[t].color}"></span></span>
        </div>`).join("");
      const el = document.createElement("div");
      el.className = "floor-bin";
      el.dataset.bin = i;
      el.innerHTML = `
        <div class="floor-box">
          <div class="floor-box__panel">
            <div class="floor-box__code">${code}</div>
            <div class="floor-box__meters">${meters}</div>
          </div>
          <div class="floor-box__base">${code}</div>
          <div class="floor-box__door" id="floor-door-${i}">${lidSVG(0)}</div>
        </div>
        <div class="floor-bin__head">${code}</div>
        <div class="floor-bin__foot">
          <span class="floor-bin__pct floor-bin__pct--base">0%</span>
          <span class="floor-bin__bar"><span class="floor-bin__pct floor-bin__pct--fill">0%</span></span>
        </div>`;
      el.addEventListener("click", () => onBinTap(i));
      el.addEventListener("pointerenter", () => { if (!busy) openBin(i, true); });
      el.addEventListener("pointerleave", () => { if (!busy && !bins[i].pinned) openBin(i, false); });
      binsEl.appendChild(el);
    });
    refreshBins();
  }

  function openBin(i, on) {
    const el = $$(".floor-bin", binsEl)[i];
    if (el) el.classList.toggle("is-open", on);
    setDoorOpen(i, on ? 1 : 0);
  }

  function refreshBins() {
    const list = $$(".floor-bin", binsEl);
    bins.forEach((b, i) => {
      const el = list[i]; if (!el) return;
      FLR_TEMPERS.forEach((t) => {
        const f = Math.min(1, b.meters[t] / TEMPER_META[t].target);
        const bar = el.querySelector(`.floor-meter[data-t="${t}"] .floor-meter__bar`);
        if (bar) { bar.style.width = (f * 100) + "%"; bar.classList.toggle("is-full", f >= 1); }
      });
      const p = Math.round(binProgress(b) * 100);
      el.querySelectorAll(".floor-bin__pct").forEach((n) => { n.textContent = p + "%"; });
      el.querySelector(".floor-bin__bar").style.width = p + "%";
      el.classList.toggle("is-full", binComplete(b));
    });
    const fp = fileProgress();
    const comp = $("#floor-completion");
    if (comp) comp.textContent = Math.round(fp * 100);
    const tally = $("#floor-tally-fill");
    if (tally) tally.style.width = (fp * 100) + "%";
  }

  const wait = (ms) => new Promise((res) => (reduced ? res() : setTimeout(res, ms)));

  /* =====================================================
     BIN TAP — validate, then open / fly / credit / close
     ===================================================== */
  async function onBinTap(i) {
    if (busy) return;
    const sel = selectedIndices();
    if (sel.length === 0) {
      if (Math.random() < 0.5) Corporate && Corporate.passive && Corporate.passive();
      return;
    }
    const v = validateSelection(sel);
    if (!v.ok) {
      Sound.err && Sound.err();
      showNope(v.reason);
      clearAll();
      resetIdle();
      return;
    }

    busy = true;
    resetIdle();
    bins[i].pinned = true;
    const el = $$(".floor-bin", binsEl)[i];
    if (el) el.classList.add("is-open");

    const cluster = clusters.get(v.cid);
    const cells = cluster ? cluster.cells.slice() : sel.slice();
    const amount = cells.length;
    const rect = canvas.getBoundingClientRect();
    const flyers = cells.map((idx) => {
      const ctr = cellCenter(idx);
      nums[idx].state = "selected";
      return { idx, val: nums[idx].val, sx: rect.left + ctr.x, sy: rect.top + ctr.y };
    });

    // 1. DOOR OPENS — line-lids swing UP (\/); the panel then floats up
    Sound.settle && Sound.settle();
    await tween(DOOR_MS, easeInOut, (k) => setDoorOpen(i, k));

    // 2. wait for the stat panel to float slowly up out of the box
    await wait(PANEL_RISE_MS);

    // 3. numbers float in SLOWLY, only after the panel has emerged
    await flyIntoPanel(i, flyers);

    // 4. credit the meter once the numbers have arrived; bar + tally climb
    const wasComplete = binComplete(bins[i]);
    bins[i].meters[v.temper] += amount;
    refreshBins();
    tickHex();
    Sound.chime && Sound.chime();
    Corporate && Corporate.friendly && Corporate.friendly();
    if (el) { el.classList.remove("floor-bin--settle"); void el.offsetWidth; el.classList.add("floor-bin--settle"); }

    await wait(420);                       // let the meter be read

    // 4. DOOR CLOSES — realistic lid swing back
    await tween(DOOR_MS, easeInOut, (k) => setDoorOpen(i, 1 - k));
    setDoorOpen(i, 0);
    bins[i].pinned = false;
    if (el) el.classList.remove("is-open");

    // 5. the slots the numbers left stay EMPTY for one second
    dissolveCluster(v.cid);
    const emptyUntil = performance.now() + EMPTY_MS;
    for (const s of flyers) {
      const n = nums[s.idx];
      n.temper = null; n.cid = -1;
      n.state = "empty"; n.glow = 0;
      n.emptyUntil = emptyUntil;
    }
    await wait(EMPTY_MS);

    // 6. refill those slots with fresh digits and a bouncy pop
    const now = performance.now();
    for (const s of flyers) {
      const n = nums[s.idx];
      if (n.state !== "empty") continue;
      n.val = rnd10(); n.temper = null; n.cid = -1;
      n.state = "none"; n.glow = 0; n.scale = 0.2;
      n.born = now; n.popping = true; n.emptyUntil = 0;
      n.horizontal = Math.random() < 0.5;
      n.phase = Math.random() * TAU;
      n.jseed = Math.random() * TAU; n.jseed2 = Math.random() * TAU;
    }
    maintainClusters();

    if (!wasComplete && binComplete(bins[i])) {
      Interstitial && Interstitial.show && Interstitial.show("BOX O" + (i + 1) + " BALANCED");
    }
    busy = false;
    if (fileProgress() >= 1) onFileComplete();
  }

  function flyIntoPanel(i, selected) {
    return new Promise((resolve) => {
      if (reduced || selected.length === 0) return resolve();
      const panel = $$(".floor-bin", binsEl)[i].querySelector(".floor-box__panel");
      const br = panel.getBoundingClientRect();
      const tx = br.left + br.width / 2, ty = br.top + br.height / 2;
      const secs = (FLOAT_MS / 1000).toFixed(2) + "s";
      const flyers = [];
      selected.forEach((s, k) => {
        const f = document.createElement("div");
        f.className = "floor-flyer";
        f.textContent = s.val;
        f.style.fontSize = "20px";
        f.style.transition = `transform ${secs} var(--ease) ${(k * 70)}ms, opacity ${secs} var(--ease) ${(k * 70)}ms`;
        f.style.transform = `translate(${s.sx}px, ${s.sy}px) scale(2)`;
        f.style.opacity = "1";
        document.body.appendChild(f);
        flyers.push(f);
        nums[s.idx].state = "none";
      });
      requestAnimationFrame(() => requestAnimationFrame(() => {
        flyers.forEach((f) => {
          const j = (Math.random() - 0.5) * 22;
          f.style.transform = `translate(${tx + j}px, ${ty}px) scale(0.3)`;
          f.style.opacity = "0";
        });
      }));
      const last = (selected.length - 1) * 70;
      setTimeout(() => { flyers.forEach((f) => f.remove()); resolve(); }, FLOAT_MS + last + 60);
    });
  }

  /* =====================================================
     "NOPE" — rejection feedback (thumbs-down)
     ===================================================== */
  let nopeTimer = null;
  function buildNope() {
    nopeEl = document.createElement("div");
    nopeEl.className = "floor-nope";
    nopeEl.setAttribute("aria-hidden", "true");
    nopeEl.innerHTML = `
      <div class="floor-nope__card">
        <svg class="floor-nope__icon" viewBox="0 0 54 46">
          <rect class="cuff" x="4" y="5" width="11" height="21" rx="2"></rect>
          <line x1="9.5" y1="8" x2="9.5" y2="23"></line>
          <path d="M18 6 H37 a6 6 0 0 1 6 6 v4 a6 6 0 0 1 -6 6 H31 l2.4 8.4 a4 4 0 0 1 -7.8 1.9 L20 23 H18 Z"></path>
        </svg>
        <div class="floor-nope__text">
          <span class="floor-nope__word">Nope</span>
          <span class="floor-nope__reason"></span>
        </div>
      </div>`;
    wrap.appendChild(nopeEl);
  }
  function showNope(reason) {
    if (!nopeEl) return;
    const r = nopeEl.querySelector(".floor-nope__reason");
    if (r) r.textContent = reason || "";
    nopeEl.classList.remove("show"); void nopeEl.offsetWidth;
    nopeEl.classList.add("show");
    clearTimeout(nopeTimer);
    nopeTimer = setTimeout(() => nopeEl.classList.remove("show"), 1050);
  }

  /* =====================================================
     HEX READOUT
     ===================================================== */
  function rndHex(n) {
    let s = "";
    for (let k = 0; k < n; k++) s += "0123456789ABCDEF"[(Math.random() * 16) | 0];
    return s;
  }
  function tickHex() {
    const a = $("#floor-hex-a"), b = $("#floor-hex-b");
    if (a) a.textContent = "0x" + rndHex(6);
    if (b) b.textContent = "0x" + rndHex(6);
  }

  /* =====================================================
     COMPLETION
     ===================================================== */
  function onFileComplete() {
    Sound.done && Sound.done();
    Interstitial && Interstitial.show && Interstitial.show("FILE COMPLETE");
    Corporate && Corporate.friendly && Corporate.friendly();
    Store.set({ floorFilesComplete: (Store.get("floorFilesComplete") || 0) + 1 });
    setTimeout(() => {
      fileName = FILE_NAMES[Math.floor(Math.random() * FILE_NAMES.length)];
      const nameEl = $("#floor-file-name"); if (nameEl) nameEl.textContent = fileName;
      makeBins();
      buildBins();
      nums.forEach((n) => { n.val = rnd10(); n.state = "none"; });
      seedField();
      tickHex();
      showHint();
    }, 1400);
  }

  /* =====================================================
     HINT + IDLE
     ===================================================== */
  let hintTimer = null;
  function hideHint() { if (hintEl) hintEl.classList.add("is-hidden"); }
  function showHint() {
    if (!hintEl) return;
    hintEl.classList.remove("is-hidden");
    clearTimeout(hintTimer);
    hintTimer = setTimeout(hideHint, 7000);
  }

  let idleTimer = null;
  function resetIdle() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (!$("#screen-floor").hidden && Corporate) { Corporate.passive(); resetIdle(); }
    }, 22000);
  }
  function stopIdle() { clearTimeout(idleTimer); }

  /* =====================================================
     LIFECYCLE
     ===================================================== */
  function start() {
    if (running) return;
    running = true;
    reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    layout();
    tickHex();
    showHint();
    resetIdle();
    clearInterval(hexTimer);
    if (!reduced) hexTimer = setInterval(() => {
      const which = Math.random() < 0.5 ? "#floor-hex-a" : "#floor-hex-b";
      const el = $(which); if (el) el.textContent = "0x" + rndHex(6);
    }, 2600);
    raf = requestAnimationFrame(frame);
  }
  function stop() {
    running = false;
    if (raf) cancelAnimationFrame(raf), raf = null;
    clearInterval(hexTimer);
    stopIdle();
  }

  let inited = false;
  function init() {
    if (inited) return; inited = true;
    wrap = $(".floor-stage");
    canvas = $("#floor-canvas");
    if (!canvas) return;
    ctx = canvas.getContext("2d");
    hintEl = $("#floor-hint");
    binsEl = $("#floor-bins");
    buildNope();

    fileName = FILE_NAMES[0];   // first file is always Cold Harbour
    const nameEl = $("#floor-file-name"); if (nameEl) nameEl.textContent = fileName;
    makeBins();
    buildBins();

    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("pointerleave", onPointerLeave);
    window.addEventListener("resize", () => { if (running) layout(); });
  }

  /* tiny debug accessor (kept for future automated checks; harmless) */
  function _dbg() {
    return {
      busy,
      clusters: [...clusters.values()].map((c) => ({
        temper: c.temper,
        cells: c.cells.map((i) => { const p = cellCenter(i); const r = canvas.getBoundingClientRect(); return { x: r.left + p.x, y: r.top + p.y }; }),
      })),
    };
  }

  return { init, start, stop, _dbg };
})();
