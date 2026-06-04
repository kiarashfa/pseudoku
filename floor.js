/* ============================================================
   floor.js — The Refinement Floor (Phase 4): the standalone
   macrodata mini-game. Floating number field, proximity-magnify
   cluster selection, five animated "mysterious boxes", and the
   decorative rotating wheel. Self-contained.
   ============================================================ */
import { $, $$, Store, Sound, Corporate, Interstitial } from "./core.js";

export const RefinementFloor = (function () {

  /* ---- constants (matched to the reference) ---- */
  const CELL = 84;               // base cell size (px)
  const TARGET_COUNT = 300;      // dense field on desktop
  const FLOAT_LOOP = 2000;       // ms per float oscillation
  const SCALE = { sel: 2.43, hover: 2.43, neighbour: 1.57, none: 1.0 };
  const LID_RADIANS = Math.PI * 2 / 3;   // box lid max swing
  const BIN_COUNT = 5;

  // invented absurd-corporate bin codenames (NOT real episode/file names)
  const BIN_NAMES = [
    "QUFFLE", "WRENTON", "BISMUTH", "OVERMERE", "CLATHRO",
    "DRENFOLD", "MIRTHWAX", "SUNDERAC", "PELLUCID", "VORNQAT",
    "GLEEBORN", "HASKMERE", "TROUGHLY", "ANNECDOT",
  ];
  const FILE_NAMES = [
    "COLD HARBOR", "SIENA", "TUMWOLT", "OQUENDO", "ALLENTOWN",
    "CULPEPPER", "MORRISON", "LUCKNOW", "NANNING", "DRANESK",
  ];

  /* ---- module state ---- */
  let canvas, ctx, wrap, wheelEl, hintEl, binsEl;
  let dpr = 1, W = 0, H = 0;
  let cols = 0, rows = 0;          // grid dimensions in the viewport
  let nums = [];                   // number objects (one per cell slot)
  let raf = null, running = false;
  let reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // pointer / selection
  let hoverIndex = -1;
  let dragging = false;
  let isTouch = false;
  let pointer = { x: -9999, y: -9999 };

  // bins / file
  let bins = [];                   // { cap, filled, name, boxOpen(0..1), animating }
  let fileName = "COLD HARBOR";
  let busy = false;                // a bin animation in flight
  let idleHooked = false;

  // wheel
  let wheelRects = [];             // { topPct, idx }
  let wheelTimer = null;

  /* =====================================================
     NUMBER MODEL
     ===================================================== */
  function makeNumber() {
    return {
      val: Math.floor(Math.random() * 10),
      horizontal: Math.random() < 0.5,   // fixed float axis for its life
      // smooth ~2s oscillation: random phase + slightly varied period
      phase: Math.random() * Math.PI * 2,
      period: FLOAT_LOOP * (0.85 + Math.random() * 0.3),
      amp: 0,                             // set on layout (fieldWidth/6 fraction)
      state: "none",                      // none | neighbour | hover | selected
      scale: 1,                           // animated toward target
      glow: 0,                            // animated brightness 0..1
      born: 0,                            // ms birth time (for bouncy pop)
      popping: false,
    };
  }

  /* =====================================================
     LAYOUT
     ===================================================== */
  function layout() {
    dpr = Math.min(2, window.devicePixelRatio || 1);
    W = wrap.clientWidth; H = wrap.clientHeight;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    canvas.style.width = W + "px";
    canvas.style.height = H + "px";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    cols = Math.max(1, Math.floor(W / CELL));
    rows = Math.max(1, Math.floor(H / CELL));

    // cap density on small screens to keep per-frame math smooth
    let want = cols * rows;
    const cap = (W < 620) ? 160 : TARGET_COUNT;
    want = Math.min(want, cap);
    // ensure want fits whole rows of `cols`
    rows = Math.max(1, Math.ceil(want / cols));

    // float amplitude tied to field width, like the reference (width/6),
    // but scaled to a per-number gentle drift that stays near its cell.
    const amp = Math.min(CELL * 0.5, (W / 6) * 0.18);

    const total = cols * rows;
    if (nums.length !== total) {
      nums = [];
      for (let i = 0; i < total; i++) nums.push(makeNumber());
    }
    nums.forEach((n) => { n.amp = amp; });
  }

  /* center origin so the grid is centered in the stage */
  function originX() { return (W - cols * CELL) / 2; }
  function originY() { return (H - rows * CELL) / 2; }

  function cellCenter(i) {
    const c = i % cols, r = Math.floor(i / cols);
    return {
      x: originX() + c * CELL + CELL / 2,
      y: originY() + r * CELL + CELL / 2,
    };
  }

  /* =====================================================
     SELECTION  (proximity magnify, 3x3)
     ===================================================== */
  function indexAt(px, py) {
    const c = Math.floor((px - originX()) / CELL);
    const r = Math.floor((py - originY()) / CELL);
    if (c < 0 || c >= cols || r < 0 || r >= rows) return -1;
    return r * cols + c;
  }

  function clearStates(keepSelected) {
    for (const n of nums) {
      if (keepSelected && n.state === "selected") continue;
      n.state = "none";
    }
  }

  // apply 3x3 magnify around center index; center gets `state`,
  // the 8 neighbours get "neighbour" (but never demote a selected cell).
  function applyCluster(centerIdx, state) {
    if (centerIdx < 0) return;
    const cc = centerIdx % cols, cr = Math.floor(centerIdx / cols);
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        const r = cr + dr, c = cc + dc;
        if (r < 0 || r >= rows || c < 0 || c >= cols) continue;
        const idx = r * cols + c;
        const n = nums[idx];
        if (!n) continue;
        if (idx === centerIdx) {
          // committing: don't downgrade a selected centre to hover state set
          if (state === "selected") n.state = "selected";
          else if (n.state !== "selected") n.state = "hover";
        } else {
          if (n.state !== "selected") n.state = "neighbour";
        }
      }
    }
  }

  function selectedCount() {
    let n = 0;
    for (const x of nums) if (x.state === "selected") n++;
    return n;
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
    const p = localPoint(e);
    pointer = p;
    const idx = indexAt(p.x, p.y);

    if (dragging) {
      // commit-select: accumulate, magnify follows cursor
      applyCluster(idx, "selected");
      // also magnify the live neighbourhood transiently
      hoverIndex = idx;
      hideHint();
    } else if (!isTouch) {
      // hover preview: transient, clears as you move
      clearStates(true /* keep selected from a prior drag? */);
      // hover is only a preview when there is no committed selection
      if (selectedCount() === 0) {
        clearStates(false);
        applyCluster(idx, "hover");
      }
      hoverIndex = idx;
    }
  }

  function onPointerDown(e) {
    if (busy) return;
    Sound.ensure && Sound.ensure();
    isTouch = (e.pointerType === "touch");
    const p = localPoint(e);
    pointer = p;
    const idx = indexAt(p.x, p.y);

    // starting a new drag clears the previous cluster (tap empty clears too)
    clearStates(false);
    dragging = true;
    hoverIndex = idx;
    if (idx >= 0) {
      applyCluster(idx, "selected");
      Sound.select && Sound.select();
      hideHint();
    }
    try { canvas.setPointerCapture(e.pointerId); } catch (_) {}
    resetIdle();
  }

  function onPointerUp() {
    if (dragging && selectedCount() > 0) Sound.key && Sound.key();
    dragging = false;
  }

  function onPointerLeave() {
    if (dragging) return;
    if (!isTouch && selectedCount() === 0) clearStates(false);
    hoverIndex = -1;
    pointer = { x: -9999, y: -9999 };
  }

  /* =====================================================
     RENDER LOOP
     ===================================================== */
  function frame(t) {
    if (!running) return;
    ctx.clearRect(0, 0, W, H);

    const ox = originX(), oy = originY();
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    for (let i = 0; i < nums.length; i++) {
      const n = nums[i];
      const c = i % cols, r = Math.floor(i / cols);
      let cx = ox + c * CELL + CELL / 2;
      let cy = oy + r * CELL + CELL / 2;

      // gentle float: one fixed axis, smooth ~2s loop
      if (!reduced) {
        const off = Math.sin((t / n.period) * Math.PI * 2 + n.phase) * n.amp;
        if (n.horizontal) cx += off; else cy += off;
      }

      // bouncy pop on fresh refill
      let popScale = 1;
      if (n.popping && !reduced) {
        const age = (t - n.born) / 500; // 0.5s
        if (age >= 1) { n.popping = false; popScale = 1; }
        else {
          // overshoot ease (bouncy)
          const k = age;
          popScale = 1 + Math.sin(k * Math.PI) * 0.35 * (1 - k);
        }
      }

      // animate scale + glow toward target state
      const target = SCALE[n.state] || 1;
      n.scale += (target - n.scale) * (reduced ? 1 : 0.28);
      const glowT = (n.state === "selected" || n.state === "hover") ? 1
                  : (n.state === "neighbour" ? 0.4 : 0);
      n.glow += (glowT - n.glow) * (reduced ? 1 : 0.28);

      const fs = 22 * n.scale * popScale;
      ctx.font = `700 ${fs}px "IBM Plex Mono", monospace`;

      // colour + glow: selected/hover are the bright "scary numbers"
      const base = 0.42 + n.glow * 0.55;
      if (n.state === "selected") {
        ctx.fillStyle = `rgba(207,232,245,${0.85 + n.glow * 0.15})`;
        ctx.shadowColor = "rgba(127,223,255,0.95)";
        ctx.shadowBlur = 16;
      } else if (n.state === "hover") {
        ctx.fillStyle = `rgba(207,232,245,${base})`;
        ctx.shadowColor = "rgba(127,223,255,0.8)";
        ctx.shadowBlur = 12;
      } else if (n.state === "neighbour") {
        ctx.fillStyle = `rgba(127,223,255,${0.55})`;
        ctx.shadowColor = "rgba(127,223,255,0.5)";
        ctx.shadowBlur = 6;
      } else {
        ctx.fillStyle = `rgba(127,223,255,${0.30})`;
        ctx.shadowColor = "rgba(127,223,255,0.4)";
        ctx.shadowBlur = 3;
      }

      ctx.fillText(String(n.val), cx, cy);
    }
    ctx.shadowBlur = 0;

    raf = requestAnimationFrame(frame);
  }

  /* =====================================================
     BINS + MYSTERIOUS BOX
     ===================================================== */
  function makeBins() {
    bins = [];
    const pool = BIN_NAMES.slice();
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    for (let i = 0; i < BIN_COUNT; i++) {
      bins.push({
        cap: 20 + Math.floor(Math.random() * 81), // 20..100
        filled: 0,
        name: pool[i],
        open: 0,            // box openProgress 0..1
      });
    }
  }

  function binProgress(b) { return Math.min(1, b.filled / b.cap); }
  function fileProgress() { return bins.reduce((s, b) => s + binProgress(b), 0) / bins.length; }

  function buildBins() {
    binsEl.innerHTML = "";
    bins.forEach((b, i) => {
      const el = document.createElement("div");
      el.className = "floor-bin";
      el.dataset.bin = i;
      el.innerHTML = `
        <div class="floor-bin__fill"></div>
        <div class="floor-bin__box" id="floor-box-${i}">${boxSVG(0)}</div>
        <div class="floor-bin__label">
          <span class="floor-bin__code">${String(i + 1).padStart(2, "0")}</span>
          <span class="floor-bin__name">${b.name}</span>
        </div>
        <div class="floor-bin__pct">0%</div>`;
      el.addEventListener("click", () => onBinTap(i));
      binsEl.appendChild(el);
    });
    refreshBins();
  }

  function refreshBins() {
    const list = $$(".floor-bin", binsEl);
    bins.forEach((b, i) => {
      const el = list[i]; if (!el) return;
      const p = Math.round(binProgress(b) * 100);
      el.querySelector(".floor-bin__fill").style.height = p + "%";
      el.querySelector(".floor-bin__pct").textContent = p + "%";
      el.classList.toggle("is-full", p >= 100);
    });
    const fp = Math.round(fileProgress() * 100);
    const comp = $("#floor-completion");
    if (comp) comp.textContent = fp + "%";
  }

  /* The mysterious box as an SVG path driven by one openProgress (0..1).
     Mirrors BoxShape.swift: two lid halves swing open via cos/sin, with a
     growing drop-shadow offset for a 0-perspective 3D feel. */
  function boxSVG(openProgress) {
    // local coordinate box (viewBox 0..100 wide, 0..70 tall)
    const VW = 100, VH = 70;
    const boxW = 64, boxH = boxW * 0.25;     // aspectRatio 0.25
    const shadowOffsetMax = boxH * (4 / 9);  // shadowRatio
    const startX = (VW - boxW) / 2;
    const baseY = VH - 6;                    // box sits near bottom

    const bLB = { x: startX, y: baseY };
    const bLT = { x: startX, y: baseY - boxH };
    const bRB = { x: startX + boxW, y: baseY };
    const bRT = { x: startX + boxW, y: baseY - boxH };

    const rad = openProgress * LID_RADIANS;

    const lidLT = {
      x: bLT.x + (boxW / 2) * Math.cos(-rad),
      y: bLT.y + (boxW / 2) * Math.sin(-rad),
    };
    const lidRT = {
      x: bRT.x - (boxW / 2) * Math.cos(rad),
      y: bRT.y - (boxW / 2) * Math.sin(rad),
    };

    const off = shadowOffsetMax * openProgress;
    let shLT, shRT, shLidLT, shLidRT;
    if (rad < Math.PI / 2) {
      shRT = { x: bRT.x - off * Math.cos(rad), y: bRT.y - off * Math.sin(rad) };
      shLT = { x: bLT.x + off * Math.cos(-rad), y: bLT.y + off * Math.sin(-rad) };
      shLidLT = { x: bLT.x + (boxW / 2 + off) * Math.cos(-rad), y: bLT.y + (boxW / 2 + off) * Math.sin(-rad) };
      shLidRT = { x: bRT.x - (boxW / 2 + off) * Math.cos(rad), y: bRT.y - (boxW / 2 + off) * Math.sin(rad) };
    } else {
      shRT = { x: bRT.x, y: bRT.y - off };
      shLT = { x: bLT.x, y: bLT.y - off };
      shLidLT = { x: lidLT.x, y: lidLT.y - off };
      shLidRT = { x: lidRT.x, y: lidRT.y - off };
    }

    const L = (a, b) => `M ${a.x.toFixed(2)} ${a.y.toFixed(2)} L ${b.x.toFixed(2)} ${b.y.toFixed(2)}`;
    // front face (filled feel via box outline)
    const front = `M ${bLT.x} ${bLT.y} L ${bLB.x} ${bLB.y} L ${bRB.x} ${bRB.y} L ${bRT.x} ${bRT.y} Z`;
    const lids = `${L(bLT, lidLT)} ${L(bRT, lidRT)}`;
    const shadow =
      `${L(shLT, shRT)} ${L(shLT, shLidLT)} ${L(shRT, shLidRT)} ` +
      `${L(shLidLT, lidLT)} ${L(shLidRT, lidRT)} ${L(shLT, bLT)} ${L(shRT, bRT)}`;

    return `<svg viewBox="0 0 ${VW} ${VH}" preserveAspectRatio="xMidYMax meet" aria-hidden="true">
      <path class="box-shadow-line" d="${shadow}"></path>
      <path d="${front} ${lids}"></path>
    </svg>`;
  }

  function setBoxOpen(i, v) {
    bins[i].open = v;
    const host = document.getElementById("floor-box-" + i);
    if (host) host.innerHTML = boxSVG(v);
  }

  /* tween helper (eased), respects reduced motion by snapping */
  function tween(ms, ease, onUpdate) {
    return new Promise((resolve) => {
      if (reduced || ms <= 0) { onUpdate(1); return resolve(); }
      const start = performance.now();
      (function step(now) {
        let k = Math.min(1, (now - start) / ms);
        onUpdate(ease ? ease(k) : k);
        if (k < 1) requestAnimationFrame(step); else resolve();
      })(performance.now());
    });
  }
  const easeInOut = (k) => k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;

  /* =====================================================
     BIN TAP — the exact open / fly / close / refill sequence
     ===================================================== */
  async function onBinTap(i) {
    if (busy) return;
    const count = selectedCount();
    if (count === 0) {
      // cold notice, do nothing else (occasional creepy roll handled by Corporate)
      if (Math.random() < 0.5) Corporate && Corporate.passive && Corporate.passive();
      return;
    }
    busy = true;
    resetIdle();
    const binEl = $$(".floor-bin", binsEl)[i];
    if (binEl) binEl.classList.add("floor-bin--target");

    // gather selected indices + their on-screen positions BEFORE refill
    const selected = [];
    for (let k = 0; k < nums.length; k++) {
      if (nums[k].state === "selected") {
        const ctr = cellCenter(k);
        const rect = canvas.getBoundingClientRect();
        selected.push({ idx: k, val: nums[k].val,
          sx: rect.left + ctr.x, sy: rect.top + ctr.y });
      }
    }

    // 1. LID OPENS (~0.6s ease-in-out)
    await tween(600, easeInOut, (k) => setBoxOpen(i, k));

    // 2. numbers fly INTO the box (~1s)
    Sound.settle && Sound.settle();
    await flyIntoBox(i, selected);

    // freeze floating during the close, like the reference
    // 3. LID CLOSES (~0.6s ease-in-out)
    await tween(600, easeInOut, (k) => setBoxOpen(i, 1 - k));
    setBoxOpen(i, 0);

    // 4. refill binned cells with fresh digits (~0.5s bouncy pop)
    const now = performance.now();
    for (const s of selected) {
      const n = nums[s.idx];
      n.val = Math.floor(Math.random() * 10);
      n.state = "none";
      n.scale = 0.2;
      n.glow = 0;
      n.born = now;
      n.popping = true;
      n.horizontal = Math.random() < 0.5;
      n.phase = Math.random() * Math.PI * 2;
    }

    // 5. increment bin progress + update bars and file completion
    bins[i].filled += count;
    refreshBins();
    Sound.chime && Sound.chime();
    Corporate && Corporate.friendly && Corporate.friendly();
    if (binEl) {
      binEl.classList.remove("floor-bin--target");
      binEl.classList.remove("floor-bin--settle"); void binEl.offsetWidth;
      binEl.classList.add("floor-bin--settle");
    }

    busy = false;

    if (fileProgress() >= 1) onFileComplete();
  }

  function flyIntoBox(i, selected) {
    return new Promise((resolve) => {
      if (reduced || selected.length === 0) return resolve();
      const boxHost = document.getElementById("floor-box-" + i);
      const br = boxHost.getBoundingClientRect();
      const tx = br.left + br.width / 2;
      const ty = br.top + br.height / 2;
      const flyers = [];
      for (const s of selected) {
        const f = document.createElement("div");
        f.className = "floor-flyer";
        f.textContent = s.val;
        f.style.left = "0px"; f.style.top = "0px";
        f.style.fontSize = "26px";
        f.style.transform = `translate(${s.sx}px, ${s.sy}px) scale(2.4)`;
        f.style.opacity = "1";
        document.body.appendChild(f);
        flyers.push(f);
        // hide the source number immediately (it's "in flight")
        nums[s.idx].state = "none";
        nums[s.idx].scale = 0;
      }
      // next frame: animate toward the box
      requestAnimationFrame(() => requestAnimationFrame(() => {
        flyers.forEach((f) => {
          const jitter = (Math.random() - 0.5) * 30;
          f.style.transform = `translate(${tx + jitter}px, ${ty}px) scale(0.4)`;
          f.style.opacity = "0";
        });
      }));
      setTimeout(() => { flyers.forEach((f) => f.remove()); resolve(); }, 1000);
    });
  }

  /* =====================================================
     COMPLETION
     ===================================================== */
  function onFileComplete() {
    Sound.done && Sound.done();
    Interstitial && Interstitial.show && Interstitial.show("FILE COMPLETE");
    Corporate && Corporate.friendly && Corporate.friendly();
    Store.set({ floorFilesComplete: (Store.get("floorFilesComplete") || 0) + 1 });
    // regenerate a fresh file after the beat
    setTimeout(() => {
      fileName = FILE_NAMES[Math.floor(Math.random() * FILE_NAMES.length)];
      const nameEl = $("#floor-file-name"); if (nameEl) nameEl.textContent = fileName;
      makeBins();
      buildBins();
      // fresh digits across the field too
      nums.forEach((n) => { n.val = Math.floor(Math.random() * 10); n.state = "none"; n.scale = 1; });
      showHint();
    }, 1400);
  }

  /* =====================================================
     WHEEL  (decorative rotating drum)
     12 stacked rects; gaps follow a symmetric x^2 ease
     (small at edges, largest in the middle); cycle to spin.
     ===================================================== */
  function buildWheel() {
    wheelEl.innerHTML = "";
    const N = 12;
    // symmetric increasing-then-decreasing deltas (x^2-ish), normalized to 1
    const segs = N - 1, m = Math.floor(segs / 2);
    let deltas = [];
    if (segs % 2 === 0) {
      const first = [];
      for (let k = 1; k <= m; k++) first.push(k);
      deltas = first.concat(first.slice().reverse());
    } else {
      const inc = [];
      for (let k = 1; k <= m + 1; k++) inc.push(k);
      deltas = inc.concat(inc.slice(0, -1).reverse());
    }
    const sum = deltas.reduce((a, b) => a + b, 0) || 1;
    // cumulative positions as fractions 0..1
    let acc = 0;
    wheelRects = [];
    for (let i = 0; i < N; i++) {
      const el = document.createElement("div");
      el.className = "floor-wheel__rect";
      wheelEl.appendChild(el);
      wheelRects.push({ el, pos: acc / sum });
      acc += (deltas[i] || 0);
    }
    paintWheel();
    clearInterval(wheelTimer);
    if (!reduced) wheelTimer = setInterval(cycleWheel, 120);
  }

  function paintWheel() {
    // rects nearer the centre are wider/brighter → drum illusion
    wheelRects.forEach((r) => {
      const center = 1 - Math.abs(r.pos - 0.5) * 2; // 0 at edges, 1 mid
      r.el.style.top = (r.pos * 100) + "%";
      r.el.style.width = (30 + center * 60) + "%";
      r.el.style.opacity = (0.25 + center * 0.6).toFixed(2);
      r.el.style.height = (3 + center * 3).toFixed(1) + "px";
    });
  }

  function cycleWheel() {
    // move the top rect to the bottom: shift all positions up by one slot
    if (wheelRects.length < 2) return;
    const positions = wheelRects.map((r) => r.pos);
    for (let i = 0; i < wheelRects.length; i++) {
      wheelRects[i].pos = positions[(i + 1) % positions.length];
    }
    paintWheel();
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
    hintTimer = setTimeout(hideHint, 6000);
  }

  let idleTimer = null;
  function resetIdle() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (!$("#screen-floor").hidden && Corporate) {
        Corporate.passive(); resetIdle();
      }
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
    buildWheel();
    showHint();
    resetIdle();
    raf = requestAnimationFrame(frame);
  }
  function stop() {
    running = false;
    if (raf) cancelAnimationFrame(raf), raf = null;
    clearInterval(wheelTimer);
    stopIdle();
  }

  let inited = false;
  function init() {
    if (inited) return; inited = true;
    wrap = $(".floor-stage");
    canvas = $("#floor-canvas");
    if (!canvas) return;
    ctx = canvas.getContext("2d");
    wheelEl = $("#floor-wheel");
    hintEl = $("#floor-hint");
    binsEl = $("#floor-bins");

    // file + bins
    fileName = FILE_NAMES[Math.floor(Math.random() * FILE_NAMES.length)];
    const nameEl = $("#floor-file-name"); if (nameEl) nameEl.textContent = fileName;
    makeBins();
    buildBins();

    // pointer wiring
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("pointerleave", onPointerLeave);
    window.addEventListener("resize", () => { if (running) layout(); });
  }

  return { init, start, stop };
})();
