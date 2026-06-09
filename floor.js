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
     - Selection is MANUAL and literal: a left click selects exactly
       the digit under the cursor (the one the lens magnifies), a held
       sweep adds every digit the cursor passes over, and a right
       click clears the selection. No hidden auto-expansion.
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
  const LENS_R = CELL * 2.2;     // magnifier radius — wide enough to scan a cluster
  const LENS_MAX = 1.7;          // peak extra scale at the cursor
  const FLOAT_LOOP = 3200;       // ms per gentle float oscillation (calm)
  const CAP = 320;               // max cells (perf)
  const BIN_COUNT = 5;
  const LID_RADIANS = (115 * Math.PI) / 180;  // lid swing for the upward \/ open
  const DOOR_MS = 650;           // realistic open/close duration (from old files)
  const FLY_MS = 1200;           // the REAL numbers travelling from field to bin
  const PANEL_MS = 1000;         // the stat panel floating up AFTER the drop

  /* ---- the four tempers ---- */
  const FLR_TEMPERS = ["WO", "FC", "DR", "MA"];
  const TEMPER_META = {
    WO: { full: "WOE",    color: "#5fe08a", target: 4, sMin: 3, sMax: 5, want: 4, feel: 1.15 },
    FC: { full: "FROLIC", color: "#e6cf45", target: 4, sMin: 3, sMax: 5, want: 4, feel: 1.15 },
    DR: { full: "DREAD",  color: "#df5fce", target: 2, sMin: 3, sMax: 4, want: 2, feel: 0.90 },
    MA: { full: "MALICE", color: "#5f9be0", target: 2, sMin: 3, sMax: 4, want: 2, feel: 0.90 },
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

    const amp = CELL * 0.025;    // ambient float barely moves — the FIELD is the backdrop;
                                 // a cluster's shared stir (below) is the only real motion
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
    clusters.set(cid, { id: cid, temper, cells: [...set], stir: 0 });
    for (const i of set) { nums[i].temper = temper; nums[i].cid = cid; }
    return true;
  }

  /* how many units of a temper are still needed across ALL bins */
  function remainingDemand(t) {
    const tg = TEMPER_META[t].target;
    let need = 0;
    for (const b of bins) need += Math.max(0, tg - b.meters[t]);
    return need;
  }

  function maintainClusters() {
    for (const t of FLR_TEMPERS) {
      // a temper that's already balanced in every bin shouldn't keep flooding
      // the field — drop it to a single faint decoy so attention shifts to
      // the tempers you still need. Otherwise hold its normal count.
      const want = remainingDemand(t) > 0 ? TEMPER_META[t].want : 1;
      let have = 0;
      const owned = [];
      for (const cl of clusters.values()) if (cl.temper === t) { have++; owned.push(cl.id); }
      // if over the (reduced) target, retire surplus clusters of this temper —
      // but never one the player currently has selected
      const hasSelected = (cid) => {
        const cl = clusters.get(cid);
        return cl && cl.cells.some((k) => nums[k] && nums[k].state === "selected");
      };
      while (have > want && owned.length) {
        const cid = owned.pop();
        if (hasSelected(cid)) continue;
        dissolveCluster(cid); have--;
      }
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
     SELECTION — manual and literal. WYSIWYG:

       • left click       -> selects exactly ONE digit: the nearest
                             cell to the (scale-corrected, clamped)
                             pointer — i.e. the digit the magnifier
                             is lifting. Tempered or not.
       • left hold+sweep  -> ADDS every digit the cursor passes over
                             (the drag path is interpolated so a fast
                             sweep never skips a cell).
       • right click      -> clears the whole selection.

     No cluster auto-expansion and no temper filter at selection time:
     what you click is what highlights. Clusters stay as hidden data
     for field generation and DROP validation only.
     ===================================================== */
  function clearAll() { for (const n of nums) n.state = "none"; }
  function selectedIndices() {
    const a = [];
    for (let k = 0; k < nums.length; k++) if (nums[k].state === "selected") a.push(k);
    return a;
  }
  function selectedCount() { return selectedIndices().length; }

  /* nearest cell to a field point — pointer clamped onto the grid, so
     edges and corners always resolve to a real digit */
  function nearestCell(px, py) {
    const fc = (px - originX()) / CELL - 0.5;
    const fr = (py - originY()) / CELL - 0.5;
    const c = Math.round(Math.min(cols - 1, Math.max(0, fc)));
    const r = Math.round(Math.min(rows - 1, Math.max(0, fr)));
    return r * cols + c;
  }

  function paintPoint(px, py) {
    const n = nums[nearestCell(px, py)];
    if (!n || n.state === "empty") return;
    n.state = "selected";
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

  /* Drop-time validation. Stray NEUTRAL digits (always clipped when you
     sweep a cluster) are forgiven: they're reported back as `pruned` so the
     caller can flicker them out, and only the tempered remainder is judged.
     Returns {ok, temper, cid, keep, pruned} or {ok:false, reason}. */
  function validateSelection(sel) {
    const kept = [], pruned = [];
    for (const i of sel) (nums[i].temper ? kept : pruned).push(i);
    if (kept.length === 0)        return { ok: false, reason: "NO TEMPER" };
    if (kept.length < SEL_MIN)    return { ok: false, reason: "TOO SMALL" };
    if (kept.length > SEL_MAX)    return { ok: false, reason: "TOO LARGE" };
    const tempers = new Set(), cids = new Set();
    for (const i of kept) { tempers.add(nums[i].temper); cids.add(nums[i].cid); }
    if (tempers.size > 1) return { ok: false, reason: "MIXED TEMPER" };
    if (cids.size > 1)    return { ok: false, reason: "NON-CONTIGUOUS" };
    return { ok: true, temper: [...tempers][0], cid: [...cids][0], keep: kept, pruned };
  }

  /* =====================================================
     POINTER HANDLERS
     ===================================================== */
  /* pointer -> canvas FIELD coordinates, compensating for any CSS scale
     on the CRT (getBoundingClientRect is transformed; W/H are not) */
  function toField(e) {
    const r = canvas.getBoundingClientRect();
    const sx = r.width ? W / r.width : 1;
    const sy = r.height ? H / r.height : 1;
    return { x: (e.clientX - r.left) * sx, y: (e.clientY - r.top) * sy };
  }
  function onPointerMove(e) {
    if (busy) return;
    pointer = toField(e);
    if (dragging) { paintAt(pointer.x, pointer.y); hideHint(); }
  }
  function onPointerDown(e) {
    if (busy) return;
    Sound.ensure && Sound.ensure();
    // right click -> deselect everything (contextmenu is suppressed on the canvas)
    if (e.button === 2) { clearAll(); return; }
    if (e.button !== 0 && e.pointerType === "mouse") return;
    isTouch = (e.pointerType === "touch");
    pointer = toField(e);
    lastPaint = { x: -9999, y: -9999 };
    closeAllPeeks();
    dragging = true;
    paintAt(pointer.x, pointer.y);     // ADDITIVE: clicks build the selection
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
     "FEELING" — per-temper motion signature (cyan, motion-only).

     Driven by the CLUSTER's shared proximity `stir` (0..1), so the
     whole cluster moves as one family under the lens. All four tempers
     are now equally LEGIBLE, each with a clearly distinct character so
     they're told apart at a glance:

       WO  deep, slow vertical HEAVE          (a heavy sigh)
       FC  buoyant springy SKIP upward        (bouncing for joy)
       DR  nervous fast side-to-side RATTLE   (jittering with fear)
       MA  sharp irregular LURCH/snap         (a vicious twitch)

     and a distinct brightness behaviour each: WO swells slowly, FC
     pulses warm, DR flickers unsteadily, MA stabs on the lurch.
     ===================================================== */
  function temperMotion(n, t, stir) {
    const e = TEMPER_META[n.temper].feel;
    const g = 0.22 + 0.92 * stir;        // faint at rest, full under the lens
    let jx = 0, jy = 0, b = 0;
    switch (n.temper) {
      case "WO": {  // deep slow vertical heave — a heavy sigh
        jy = Math.sin(t * 0.0015 + n.jseed) * 3.0 * e * g;
        jx = Math.cos(t * 0.0010 + n.jseed) * 0.5 * e * g;
        b = (0.12 + 0.06 * (0.5 + 0.5 * Math.sin(t * 0.0015 + n.jseed))) * g; break;
      }
      case "FC": {  // buoyant springy skip — bouncing upward for joy
        jy = -Math.abs(Math.sin(t * 0.007 + n.jseed)) * 3.0 * e * g;
        jx = Math.sin(t * 0.013 + n.jseed) * 0.7 * e * g;
        b = (0.15 + 0.07 * Math.abs(Math.sin(t * 0.007 + n.jseed))) * g; break;
      }
      case "DR": {  // nervous fast side-to-side rattle — jittering with fear
        jx = Math.sin(t * 0.020 + n.jseed) * 2.4 * e * g;
        jy = Math.sin(t * 0.030 + n.jseed2) * 0.8 * e * g;
        // unsteady flicker
        b = (0.10 + 0.10 * Math.abs(Math.sin(t * 0.020 + n.jseed))) * g; break;
      }
      case "MA": {  // sharp irregular lurch/snap — a vicious twitch
        const phase = Math.sin(t * 0.0028 + n.jseed);
        const burst = phase > 0.75 ? 1 : 0;          // sudden, then still
        jx = burst * Math.sin(t * 0.080 + n.jseed2) * 2.2 * e * g;
        jy = burst * Math.cos(t * 0.075 + n.jseed) * 1.1 * e * g;
        b = (0.09 + (burst ? 0.14 : 0)) * g; break;  // stabs bright on the lurch
      }
    }
    return { jx, jy, b };
  }

  /* per-frame: each cluster's `stir` = smoothed proximity of its CLOSEST
     cell to the cursor, so all its cells move as a group */
  function updateClusterStir() {
    const px = pointer.x, py = pointer.y, hasP = px > -9000;
    for (const cl of clusters.values()) {
      let best = 0;
      if (hasP) for (const idx of cl.cells) {
        const ctr = cellCenter(idx);
        const d = Math.hypot(ctr.x - px, ctr.y - py);
        if (d < LENS_R) { const k = 1 - d / LENS_R; const s = k * k * (3 - 2 * k); if (s > best) best = s; }
      }
      const prev = cl.stir || 0;
      cl.stir = reduced ? best : prev + (best - prev) * 0.18;   // ease toward target
    }
  }

  /* =====================================================
     RENDER LOOP — float + fisheye magnifier + feeling + pop
     ===================================================== */
  function frame(t) {
    if (!running) return;
    ctx.clearRect(0, 0, W, H);
    updateClusterStir();
    const ox = originX(), oy = originY();
    const px = pointer.x, py = pointer.y, hasP = px > -9000;
    ctx.textAlign = "center"; ctx.textBaseline = "middle";

    for (let i = 0; i < nums.length; i++) {
      const n = nums[i];
      // a freshly-binned slot renders blank until it is refilled
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

      // the feeling — driven by the whole cluster's shared stir
      let feel = 0;
      if (n.temper) {
        const cl = clusters.get(n.cid);
        const stir = cl ? (cl.stir || 0) : near;
        if (reduced) feel = 0.12;
        else { const m = temperMotion(n, t, stir); cx += m.jx; cy += m.jy; feel = m.b; }
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
        // a SELECTED tempered digit reads white-hot; a caught NEUTRAL
        // glows visibly dimmer/cooler, so you can read your group before
        // committing it to a bin (these neutrals get pruned on drop).
        if (n.temper) {
          ctx.fillStyle = `rgba(220,242,253,${a})`;
          ctx.shadowColor = "rgba(150,235,255,0.95)"; ctx.shadowBlur = 14 + near * 9;
        } else {
          ctx.fillStyle = `rgba(150,176,196,0.78)`;
          ctx.shadowColor = "rgba(120,160,185,0.45)"; ctx.shadowBlur = 4 + near * 5;
        }
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

     ── JOINT COORDINATES — TUNE HERE ─────────────────────────────
     The SVG viewBox is 0..100 wide and 0..60 tall, stretched
     (preserveAspectRatio="none") over the .floor-box__door element,
     which spans EXACTLY the bin rectangle (CSS: left:0; right:0;
     bottom:0; height:78px in style.css). Therefore:
       · 1 horizontal unit = binWidth / 100 px
       · 1 vertical unit   = 78 / 60 = 1.3 px
     The two constants below position the hinge joints:
       HINGE_INSET_X — distance of each joint from its bin corner,
         in horizontal units. 0 = stroke centre exactly on the bin's
         outer corner. Positive moves BOTH joints inward (toward the
         centre); negative pushes them outward past the corners.
       HINGE_LIFT_Y — height of the joints above the bin's top edge,
         in vertical units. 0 = stroke centre sits ON the bin's top
         border (the joint visually merges with the box). Positive
         lifts the hinge line up off the bin.
     To move ONLY one side, edit hL.x / hR.x directly below.
     ─────────────────────────────────────────────────────────────── */
  const HINGE_INSET_X = 1.0;
  const HINGE_LIFT_Y = -0.6;

  function lidSVG(openProgress) {
    const VW = 100, VH = 60;
    const shadowOffsetMax = 6;
    const mouthY = VH - HINGE_LIFT_Y;             // hinge line height

    const hL = { x: 0 + HINGE_INSET_X, y: mouthY };   // left joint  (bin top-left corner)
    const hR = { x: VW - HINGE_INSET_X, y: mouthY };  // right joint (bin top-right corner)
    const mid = { x: (hL.x + hR.x) / 2, y: mouthY };

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

  /* per-bin door animator — the lids tween open/closed for EVERY use:
     hover peeks, dumps, and the close after the panel sinks back. A new
     target retargets the running animation smoothly (rapid hover in/out). */
  let doorAnims = [];
  function makeDoorAnims() {
    doorAnims = bins.map(() => ({ prog: 0, target: 0, raf: null, done: null }));
  }
  function animateDoor(i, target) {
    return new Promise((resolve) => {
      const d = doorAnims[i];
      if (!d) return resolve();
      d.target = target;
      if (reduced) { d.prog = target; setDoorOpen(i, target); return resolve(); }
      if (d.raf) {            // retarget: settle the previous promise
        cancelAnimationFrame(d.raf); d.raf = null;
        if (d.done) { d.done(); d.done = null; }
      }
      d.done = resolve;
      let last = performance.now();
      (function step(now) {
        const dt = Math.min(50, now - last); last = now;
        const dir = Math.sign(d.target - d.prog) || 1;
        d.prog += (dir * dt) / DOOR_MS;
        const arrived = dir > 0 ? d.prog >= d.target : d.prog <= d.target;
        if (arrived) d.prog = d.target;
        setDoorOpen(i, easeInOut(Math.max(0, Math.min(1, d.prog))));
        if (arrived) { d.raf = null; const f = d.done; d.done = null; f && f(); return; }
        d.raf = requestAnimationFrame(step);
      })(last);
    });
  }

  /* easing shared by the door animator */
  const easeInOut = (k) => (k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2);

  /* =====================================================
     BINS — O1..O5; the four temper meters live in the box
     that opens above each bin.
     ===================================================== */
  function makeBins() {
    bins = [];
    for (let i = 0; i < BIN_COUNT; i++) bins.push({ meters: { WO: 0, FC: 0, DR: 0, MA: 0 }, pinned: false, hover: false });
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
          <div class="floor-box__reveal">
            <div class="floor-box__panel">
              <div class="floor-box__meters">${meters}</div>
            </div>
          </div>
          <div class="floor-box__door" id="floor-door-${i}">${lidSVG(0)}</div>
        </div>
        <div class="floor-bin__head">${code}</div>
        <div class="floor-bin__foot">
          <span class="floor-bin__pct floor-bin__pct--base">0%</span>
          <span class="floor-bin__bar"><span class="floor-bin__pct floor-bin__pct--fill">0%</span></span>
        </div>`;
      el.addEventListener("click", () => onBinTap(i));
      el.addEventListener("pointerenter", () => onBinEnter(i));
      el.addEventListener("pointerleave", () => onBinLeave(i));
      binsEl.appendChild(el);
    });
    makeDoorAnims();
    refreshBins();
  }

  const binEl = (i) => $$(".floor-bin", binsEl)[i];

  /* HOVER PEEK — only when NO numbers are selected (a player about to
     dump shouldn't be distracted). The door swings open and the panel
     floats up out of it; on leave the panel sinks and the lids close. */
  function onBinEnter(i) {
    bins[i].hover = true;
    if (busy || bins[i].pinned || selectedCount() > 0) return;
    peekBin(i, true);
  }
  function onBinLeave(i) {
    bins[i].hover = false;
    if (busy || bins[i].pinned) return;
    peekBin(i, false);
  }
  function peekBin(i, on) {
    const el = binEl(i);
    if (!el) return;
    if (on) {
      el.classList.add("is-open");
      // the lids must FULLY open first; only then does the panel float in.
      // If the pointer left (or a dump started) mid-swing, skip the panel —
      // animateDoor's retargeting resolves this promise early in that case.
      animateDoor(i, 1).then(() => {
        if (bins[i].hover && !busy && !bins[i].pinned && doorAnims[i] && doorAnims[i].prog >= 1) {
          el.classList.add("show-panel");
        }
      });
    } else {
      el.classList.remove("show-panel");          // panel floats back down…
      animateDoor(i, 0).then(() => {              // …while the lids swing shut
        if (!bins[i].hover && !bins[i].pinned) el.classList.remove("is-open");
      });
    }
  }
  function closeAllPeeks() {
    bins.forEach((b, i) => {
      if (b.pinned) return;
      const el = binEl(i);
      if (el && el.classList.contains("is-open")) peekBin(i, false);
    });
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
     BIN TAP — validate, then: door opens -> the REAL numbers leave
     the field and drop into the bin -> the stat panel floats up ->
     credit -> panel sinks -> door closes -> empty slots refill.
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
    // this bin's meter for that temper is already balanced — reject instead of
    // fake-rewarding overflow that the completion clamp would silently discard
    if (bins[i].meters[v.temper] >= TEMPER_META[v.temper].target) {
      Sound.err && Sound.err();
      showNope("O" + (i + 1) + " " + v.temper + " FULL");
      clearAll();
      resetIdle();
      return;
    }

    busy = true;
    resetIdle();
    bins[i].pinned = true;
    const el = binEl(i);
    if (el) {
      el.classList.remove("show-panel");   // no panel yet — it comes AFTER the drop
      el.classList.add("is-open");
    }

    // forgive stray neutrals: they flicker off the selection and stay on the
    // field; only the tempered group (v.keep) is dropped into the bin
    if (v.pruned && v.pruned.length) {
      for (const idx of v.pruned) nums[idx].state = "none";
    }
    const cells = v.keep.slice();
    const amount = cells.length;
    for (const idx of cells) nums[idx].state = "selected";   // glow while the lids part

    // 1. DOOR OPENS — line-lids swing UP (\/); the selection waits, glowing
    Sound.settle && Sound.settle();
    await animateDoor(i, 1);

    // 2. THE NUMBERS THEMSELVES leave: snapshot each glyph's ACTUAL drawn
    //    position (scale-corrected to the screen), blank its slot in the
    //    same instant, and fly the real digits into the bin mouth. No
    //    doppelgängers — the grid visibly gives the numbers up.
    const rect = canvas.getBoundingClientRect();
    const kx = rect.width / (W || 1), ky = rect.height / (H || 1);
    const flyers = cells.map((idx) => {
      const n = nums[idx];
      const fx = (n.rx !== undefined) ? n.rx : cellCenter(idx).x;
      const fy = (n.ry !== undefined) ? n.ry : cellCenter(idx).y;
      return { idx, val: n.val, sx: rect.left + fx * kx, sy: rect.top + fy * ky };
    });
    // the spent cluster dissolves: any UNSELECTED remainder reverts to a
    // neutral digit (it stays on the field; only the selection departs)
    dissolveCluster(v.cid);
    for (const s of flyers) {
      const n = nums[s.idx];
      n.temper = null; n.cid = -1;
      n.state = "empty"; n.glow = 0;       // the slot is now genuinely vacant
    }
    if (sel.length > 0) { Sound.key && Sound.key(); }
    await flyIntoBin(i, flyers, kx);

    // 3. only once the drop is complete does the stat panel float up
    if (el) el.classList.add("show-panel");
    await wait(PANEL_MS);

    // 4. credit the meter, capped at the target; bar + tally climb
    const wasComplete = binComplete(bins[i]);
    const tg = TEMPER_META[v.temper].target;
    bins[i].meters[v.temper] = Math.min(tg, bins[i].meters[v.temper] + amount);
    refreshBins();
    tickHex();
    Sound.chime && Sound.chime();
    Corporate && Corporate.friendly && Corporate.friendly();
    if (el) { el.classList.remove("floor-bin--settle"); void el.offsetWidth; el.classList.add("floor-bin--settle"); }

    await wait(900);                       // let the meters be read

    // 5. the panel floats back down, then the lids swing shut
    if (el) el.classList.remove("show-panel");
    await wait(450);
    await animateDoor(i, 0);
    bins[i].pinned = false;
    if (el) el.classList.remove("is-open");

    // 6. the vacated slots (empty since the drop) refill with a bouncy pop
    const now = performance.now();
    for (const s of flyers) {
      const n = nums[s.idx];
      if (n.state !== "empty") continue;
      n.val = rnd10(); n.temper = null; n.cid = -1;
      n.state = "none"; n.glow = 0; n.scale = 0.2;
      n.born = now; n.popping = true;
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

  /* the real digits travel from their exact field positions into the bin
     mouth (the hinge line at the top of the bin head), shrinking and
     fading only as they pass inside. */
  function flyIntoBin(i, flyers, kx) {
    return new Promise((resolve) => {
      if (reduced || flyers.length === 0) return resolve();
      const head = binEl(i).querySelector(".floor-bin__head");
      const hr = head.getBoundingClientRect();
      const tx = hr.left + hr.width / 2;
      const ty = hr.top + hr.height * 0.3;
      const secs = (FLY_MS / 1000).toFixed(2) + "s";
      const fadeDelay = Math.max(0, FLY_MS - 340);
      const nodes = [];
      flyers.forEach((s, k) => {
        const d = k * 55;
        const f = document.createElement("div");
        f.className = "floor-flyer";
        f.textContent = s.val;
        f.style.fontSize = Math.max(12, 17 * kx).toFixed(1) + "px";
        f.style.transition = `transform ${secs} var(--ease) ${d}ms, opacity .34s ease ${d + fadeDelay}ms`;
        f.style.transform = `translate(${s.sx}px, ${s.sy}px) translate(-50%,-50%) scale(1)`;
        f.style.opacity = "1";
        document.body.appendChild(f);
        nodes.push(f);
      });
      requestAnimationFrame(() => requestAnimationFrame(() => {
        nodes.forEach((f) => {
          const j = (Math.random() - 0.5) * 14;
          f.style.transform = `translate(${tx + j}px, ${ty}px) translate(-50%,-50%) scale(0.32)`;
          f.style.opacity = "0";
        });
      }));
      const last = (flyers.length - 1) * 55;
      setTimeout(() => { nodes.forEach((f) => f.remove()); resolve(); }, FLY_MS + last + 80);
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
    if (hintEl) hintEl.textContent =
      "Sweep the magnifier across the field — a group of numbers that stirs " +
      "together belongs together. Gather it (a stray neutral or two is fine) " +
      "and drop it into any bin. Right-click clears.";
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
    canvas.addEventListener("contextmenu", (e) => {   // right click = deselect all
      e.preventDefault();
      if (!busy) clearAll();
    });
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
