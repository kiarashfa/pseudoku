/* ============================================================
   sudoku.js — the Sudoku side: the refinement Console plus its
   companion overlays (Break Room, Waffle Party, Refinement
   Report, terminal Reveals). Grouped together because they are
   tightly coupled to the Console and to one another.
   ============================================================ */
import {
  TEMPERS, ERROR_THRESHOLD, FALLBACK,
  $, $$, fmtTime, toast,
  SudokuEngine, Store, Sound, Corporate, Interstitial,
  getEmployeeId, getDisplayName, getRefinerName,
} from "./core.js";
import { OpticalIntake } from "./ocr.js";

export const Console = (function () {
  let gridEl, cells = [];
  let grid = new Array(81).fill(0);   // current values
  let givenMask = new Array(81).fill(false);
  let solution = new Array(81).fill(0);
  let selected = -1;
  let errorCount = 0;
  let startTime = null;
  let solverState = "idle"; // idle | refining | solved | failed
  let editMode = false;     // manual-entry intake: typing givens into a blank grid

  /* ---- build the grid DOM once ---- */
  function buildGrid() {
    gridEl = $("#sudoku-grid");
    gridEl.innerHTML = "";
    cells = [];
    for (let i = 0; i < 81; i++) {
      const c = document.createElement("div");
      c.className = "cell";
      c.dataset.i = i;
      c.dataset.r = Math.floor(i / 9);
      c.dataset.c = i % 9;
      c.setAttribute("role", "gridcell");
      c.tabIndex = -1;
      c.addEventListener("pointerdown", () => select(i));
      gridEl.appendChild(c);
      cells.push(c);
    }
  }

  /* ---- load a puzzle (from generation / paste / store) ---- */
  function loadPuzzle(puzzleStr, solutionStr) {
    grid = SudokuEngine.parse(puzzleStr);
    givenMask = grid.map((v) => v !== 0);
    if (solutionStr) {
      solution = SudokuEngine.parse(solutionStr);
    } else {
      const tmp = grid.slice();
      solution = SudokuEngine.solve(tmp) ? tmp : grid.slice();
    }
    selected = -1;
    errorCount = 0;
    startTime = Date.now();
    if (editMode) exitEdit(true);
    setSolverState("idle");
    persist();
    render();
    updateStats();
  }

  /* ---- restore in-progress session ---- */
  function restore(state) {
    grid = SudokuEngine.parse(state.progress);
    givenMask = state.givenMask.split("").map((x) => x === "1");
    solution = SudokuEngine.parse(state.solution);
    selected = -1;
    errorCount = 0;
    startTime = Date.now();
    setSolverState("idle");
    render();
    updateStats();
  }

  function newPuzzle(temper) {
    const conf = TEMPERS[temper] || TEMPERS.woe;
    $("#file-temper-label").textContent = conf.label;
    let result;
    try {
      result = SudokuEngine.generate(temper); // generate-rate-accept toward target temper
    } catch (e) { result = null; }
    if (!result) {
      const fb = FALLBACK[temper] || FALLBACK.woe;
      const sol = SudokuEngine.parse(fb); SudokuEngine.solve(sol);
      result = { puzzle: SudokuEngine.parse(fb), solution: sol };
    }
    loadPuzzle(SudokuEngine.toString(result.puzzle), SudokuEngine.toString(result.solution));
  }

  /* ---- selection ---- */
  function select(i) {
    if (solverState === "refining") return;
    if (i < 0 || i > 80) return;
    selected = i;
    Sound.select();
    render();
  }

  function move(dr, dc) {
    if (selected < 0) { select(0); return; }
    let r = Math.floor(selected / 9) + dr;
    let c = (selected % 9) + dc;
    r = (r + 9) % 9; c = (c + 9) % 9;
    select(r * 9 + c);
  }

  /* ---- entry ---- */
  function enter(v) {
    if (solverState === "refining") return;

    // MANUAL INTAKE: author givens directly into the blank grid.
    // No solution/anomaly tracking — conflicts are surfaced live in render(),
    // full validation happens at SET PUZZLE.
    if (editMode) {
      if (selected < 0) return;
      grid[selected] = v;            // v === 0 clears
      Sound.key();
      render();                       // no persist mid-edit: an authored,
      updateEditState();             // unvalidated grid must not be restorable
      return;
    }

    if (selected < 0 || givenMask[selected]) return;
    Corporate.resetIdle();
    if (v === 0) {
      grid[selected] = 0;
    } else {
      grid[selected] = v;
      // anomaly tracking: wrong vs solution OR creates a conflict
      const wrong = solution[selected] && v !== solution[selected];
      if (wrong) {
        errorCount++;
        Sound.err();
        Corporate.passive();
        if (errorCount >= ERROR_THRESHOLD) {
          persist(); render(); updateStats();
          BreakRoom.open(() => { errorCount = 0; updateStats(); });
          return;
        }
      } else {
        Sound.key();
        cells[selected].classList.add("cell--settle");
        setTimeout(() => cells[selected] && cells[selected].classList.remove("cell--settle"), 460);
      }
    }
    persist();
    render();
    updateStats();
    checkComplete();
  }

  /* ---- rendering ---- */
  function render() {
    const conflicts = SudokuEngine.findConflicts(grid);
    const selVal = selected >= 0 ? grid[selected] : 0;
    const selR = selected >= 0 ? Math.floor(selected / 9) : -1;
    const selC = selected >= 0 ? selected % 9 : -1;
    const selB = selected >= 0
      ? Math.floor(selR / 3) * 3 + Math.floor(selC / 3) : -1;

    for (let i = 0; i < 81; i++) {
      const cell = cells[i];
      const v = grid[i];
      cell.textContent = v === 0 ? "" : v;
      cell.className = "cell";
      if (editMode) {
        if (v !== 0) cell.classList.add("cell--editgiven");
      } else if (givenMask[i]) cell.classList.add("cell--given");
      else if (v !== 0) cell.classList.add("cell--entered");

      const r = Math.floor(i / 9), c = i % 9;
      const b = Math.floor(r / 3) * 3 + Math.floor(c / 3);
      if (selected >= 0 && i !== selected && (r === selR || c === selC || b === selB))
        cell.classList.add("cell--peer");
      if (selVal !== 0 && v === selVal && i !== selected)
        cell.classList.add("cell--same");
      if (conflicts.has(i)) cell.classList.add("cell--conflict");
      if (i === selected) cell.classList.add("cell--selected");
    }
  }

  /* ---- stats + bins ---- */
  function filledCorrectly() {
    let n = 0;
    for (let i = 0; i < 81; i++)
      if (grid[i] !== 0 && grid[i] === solution[i]) n++;
    return n;
  }

  function updateStats() {
    const correct = filledCorrectly();
    // Completion is measured over user-fillable cells only (81 minus givens),
    // so a fresh puzzle reads 0% and a solved one reads 100%.
    const givens = givenMask.filter(Boolean).length;
    const fillable = 81 - givens;
    const correctUser = grid.filter((v, i) => !givenMask[i] && v !== 0 && v === solution[i]).length;
    const pct = fillable === 0 ? 0 : Math.round((correctUser / fillable) * 100);

    $("#stat-files").textContent = Store.get("filesRefined");
    $("#stat-progress").innerHTML = pct + "<small>%</small>";

    // drive the header progress tally (mirrors the Floor's completion bar)
    const tally = $("#console-tally-fill");
    if (tally) tally.style.width = pct + "%";

    // accuracy = correct entries / total entries attempted
    const entered = grid.filter((v, i) => !givenMask[i] && v !== 0).length;
    const correctEntered = grid.filter((v, i) => !givenMask[i] && v !== 0 && v === solution[i]).length;
    const acc = entered === 0 ? 100 : Math.round((correctEntered / entered) * 100);
    $("#stat-accuracy").innerHTML = acc + "<small>%</small>";

    const files = Store.get("filesRefined");
    const avg = files > 0 ? Store.get("totalTimeMs") / files : 0;
    $("#stat-avgtime").textContent = fmtTime(avg);

    // anomaly readout — now a bottom stat cell
    $("#error-count").textContent = errorCount;
    const aCell = $("#error-count").closest(".cstat");
    if (aCell) aCell.classList.toggle("is-warn", errorCount >= ERROR_THRESHOLD);

    // bins were retired from the console; this loop is a safe no-op if absent
    const bins = $$("#bins .bin");
    const perBin = 81 / bins.length;
    bins.forEach((bin, idx) => {
      const lo = idx * perBin;
      const local = Math.max(0, Math.min(1, (correct - lo) / perBin));
      const p = Math.round(local * 100);
      bin.querySelector(".bin__fill").style.height = p + "%";
      bin.querySelector(".bin__pct").textContent = p + "%";
      const wasFull = bin.classList.contains("is-full");
      const isFull = p >= 100;
      bin.classList.toggle("is-full", isFull);
      // a bin just completed → satisfying settle + friendly notice
      if (isFull && !wasFull) {
        bin.classList.remove("bin--settle"); void bin.offsetWidth;
        bin.classList.add("bin--settle");
        Sound.settle();
        Corporate.friendly();
      }
    });
  }

  /* ---- solver state ---- */
  function setSolverState(s) {
    solverState = s;
    const el = $("#solver-state");
    el.textContent = s.toUpperCase();
    el.className = "topbar__state";
    if (s === "refining") el.classList.add("is-refining");
    if (s === "solved") el.classList.add("is-solved");
    if (s === "failed") el.classList.add("is-failed");
  }

  /* ---- completion detection (manual solve) ---- */
  function checkComplete() {
    if (solverState === "refining") return;
    for (let i = 0; i < 81; i++) if (grid[i] !== solution[i]) return;
    onFileRefined(true);
  }

  function onFileRefined(manual) {
    setSolverState("solved");
    Sound.chime();
    Corporate.stopIdle();
    const elapsed = startTime ? Date.now() - startTime : 0;

    // Per-file accuracy: correct user entries / total fillable cells.
    const acc = manual
      ? Math.round((grid.filter((v, i) => !givenMask[i] && v === solution[i]).length /
          Math.max(1, grid.filter((v, i) => !givenMask[i]).length)) * 100)
      : 100;

    const temperKey = Store.get("temper") || "woe";
    const newCount = Store.get("filesRefined") + 1;
    const prevBest = Store.get("bestTimeMs") || 0;

    // per-temper lifetime ledger
    const ledger = { ...(Store.get("temperStats") || {}) };
    const t = ledger[temperKey] || { files: 0, accSum: 0, totalTimeMs: 0, bestTimeMs: 0 };
    ledger[temperKey] = {
      files: t.files + 1,
      accSum: t.accSum + acc,
      totalTimeMs: t.totalTimeMs + elapsed,
      bestTimeMs: t.bestTimeMs === 0 ? elapsed : Math.min(t.bestTimeMs, elapsed),
    };

    Store.set({
      filesRefined: newCount,
      totalTimeMs: Store.get("totalTimeMs") + elapsed,
      accSum: (Store.get("accSum") || 0) + acc,
      bestTimeMs: prevBest === 0 ? elapsed : Math.min(prevBest, elapsed),
      temperStats: ledger,
    });
    updateStats();
    Corporate.friendly();

    // Confetti fires on EVERY successful solve, on its own — decoupled from the
    // Waffle Party incentive so it is always visible and never sits behind it.
    WaffleParty.celebrate();

    // Waffle Party eligibility milestone (every 3rd file, or already unlocked).
    if (newCount % 3 === 0 || Store.get("waffleUnlocked")) {
      Store.set({ waffleUnlocked: true });
      WaffleParty.showBanner();
    }
  }

  /* ---- REFINE FILE: auto-solve with ceremony ---- */
  function refine() {
    if (solverState === "refining" || editMode) return;
    const work = grid.slice();
    // Lock current givens+entries as constraints; solve the rest.
    if (!SudokuEngine.solve(work)) {
      setSolverState("failed");
      Sound.err();
      toast("FILE CANNOT BE REFINED — INVALID STATE");
      setTimeout(() => setSolverState("idle"), 1800);
      return;
    }
    setSolverState("refining");
    const sweep = $("#grid-sweep");
    sweep.classList.remove("is-active"); void sweep.offsetWidth; sweep.classList.add("is-active");
    Sound.loading && Sound.loading(); // loading bed under the solver sweep

    // ceremonious fill: settle empties one-by-one in reading order
    const empties = [];
    for (let i = 0; i < 81; i++) if (grid[i] === 0) empties.push(i);
    const stepDur = Math.max(8, Math.min(40, 900 / Math.max(1, empties.length)));
    let k = 0;
    (function tick() {
      if (k >= empties.length) {
        render();
        solution = work.slice();
        setTimeout(() => onFileRefined(false), 200);
        return;
      }
      const idx = empties[k++];
      grid[idx] = work[idx];
      const cell = cells[idx];
      cell.textContent = work[idx];
      cell.classList.add("cell--entered", "cell--settle");
      setTimeout(() => cell.classList.remove("cell--settle"), 420);
      Sound.settle();
      updateStats();
      setTimeout(tick, stepDur);
    })();
  }

  /* ---- CHECK ---- */
  function check() {
    if (editMode) return;
    const conflicts = SudokuEngine.findConflicts(grid);
    render();
    if (conflicts.size > 0) {
      toast(conflicts.size + " ANOMALOUS CELL(S) DETECTED");
      Sound.err();
      return;
    }
    const blanks = grid.filter((v) => v === 0).length;
    if (blanks > 0) { toast(blanks + " CELLS AWAIT REFINEMENT"); }
    else { toast("NO ANOMALIES. FILE COMPLETE."); Sound.ok(); }
  }

  /* ---- CLEAR user entries (keep givens) ---- */
  function clearEntries() {
    if (editMode) {
      // in edit mode CLEAR ENTRIES wipes the authored grid back to blank
      grid = new Array(81).fill(0);
      selected = -1;
      render(); updateEditState();
      const errEl = $("#manual-error"); if (errEl) errEl.textContent = "";
      toast("GRID CLEARED");
      return;
    }
    for (let i = 0; i < 81; i++) if (!givenMask[i]) grid[i] = 0;
    errorCount = 0;
    setSolverState("idle");
    persist(); render(); updateStats();
    toast("ENTRIES CLEARED");
  }

  /* =====================================================
     MANUAL INTAKE — type givens into a blank grid, then
     SET PUZZLE validates + locks them via the shared
     acceptance path (loadPuzzle), exactly like OCR review.
     ===================================================== */
  function enterEdit() {
    if (solverState === "refining") return;
    editMode = true;
    grid = new Array(81).fill(0);
    givenMask = new Array(81).fill(false);
    solution = new Array(81).fill(0);
    selected = -1;
    errorCount = 0;
    setSolverState("idle");
    document.body.classList.add("is-editing");
    const errEl = $("#manual-error");
    if (errEl) errEl.textContent = "";
    render();
    updateStats();
    updateEditState();
    select(0);
    toast("MANUAL INTAKE — TYPE THE GIVENS, THEN SET PUZZLE");
    Sound.select();
  }

  // exit edit mode. accepted=true when a puzzle was set (loadPuzzle drives
  // the real state); accepted=false cancels back to an empty idle console.
  function exitEdit(accepted) {
    editMode = false;
    document.body.classList.remove("is-editing");
    const errEl = $("#manual-error");
    if (errEl) errEl.textContent = "";
    if (!accepted) {
      grid = new Array(81).fill(0);
      givenMask = new Array(81).fill(false);
      solution = new Array(81).fill(0);
      selected = -1;
      setSolverState("idle");
      render();
      updateStats();
    }
    updateEditState();
  }

  function cancelEdit() {
    if (!editMode) return;
    exitEdit(false);
    toast("MANUAL INTAKE CANCELLED");
    Sound.select();
  }

  // live readout of clue count + button enable state while authoring
  function updateEditState() {
    const setBtn = $("#set-puzzle-btn");
    const clueEl = $("#manual-clues");
    const clues = grid.filter((v) => v !== 0).length;
    if (clueEl) clueEl.textContent = clues;
    if (setBtn) setBtn.disabled = !editMode;
    // refresh the live clue gauge if present
    const gauge = $("#manual-clues-row");
    if (gauge) gauge.classList.toggle("is-short", clues < 17);
  }

  function setPuzzle() {
    if (!editMode) return;
    const errEl = $("#manual-error");
    const fail = (msg) => { if (errEl) errEl.textContent = msg; Sound.err(); };

    // 1) no structural conflicts
    const conflicts = SudokuEngine.findConflicts(grid);
    if (conflicts.size > 0) {
      render();
      fail("FILE CONTAINS ANOMALIES — DUPLICATE NUMERALS DETECTED.");
      return;
    }
    // 2) enough clues (17 is the known minimum for a unique Sudoku)
    const clues = grid.filter((v) => v !== 0).length;
    if (clues < 17) {
      fail("INSUFFICIENT NUMERIC CONTENT.");
      return;
    }
    // 3) exactly one solution
    if (!SudokuEngine.hasUniqueSolution(grid)) {
      const test = grid.slice();
      fail(SudokuEngine.solve(test)
        ? "FILE IS NON-COMPLIANT — SOLUTION IS NOT UNIQUE."
        : "FILE IS UNREFINABLE — NO VALID SOLUTION EXISTS.");
      return;
    }

    // accept → same path as paste / OCR review: lock filled cells as givens
    if (errEl) errEl.textContent = "";
    Sound.ok();
    const puzzleStr = SudokuEngine.toString(grid);
    Interstitial.show("FILE ACCEPTED");
    setTimeout(() => {
      loadPuzzle(puzzleStr);            // exitEdit(true) runs inside loadPuzzle
      toast("FILE LOADED FOR REFINEMENT");
      Corporate && Corporate.friendly && Corporate.friendly();
    }, 520);
  }

  /* ---- paste loader ---- */
  function loadFromString(str) {
    const errEl = $("#paste-error");
    errEl.textContent = "";
    const parsed = SudokuEngine.parse(str);
    if (!parsed) {
      errEl.textContent = "MALFORMED FILE — REQUIRE 81 DIGITS (0 OR . FOR BLANKS).";
      Sound.err();
      return false;
    }
    // verify exactly one solution (mirrors the manual-entry intake check)
    if (!SudokuEngine.hasUniqueSolution(parsed)) {
      const test = parsed.slice();
      errEl.textContent = SudokuEngine.solve(test)
        ? "FILE IS NON-COMPLIANT — SOLUTION IS NOT UNIQUE."
        : "FILE IS UNREFINABLE — NO VALID SOLUTION EXISTS.";
      Sound.err();
      return false;
    }
    const test = parsed.slice();
    SudokuEngine.solve(test);
    loadPuzzle(SudokuEngine.toString(parsed), SudokuEngine.toString(test));
    toast("FILE LOADED FOR REFINEMENT");
    Sound.ok();
    return true;
  }

  /* ---- persistence ---- */
  function persist() {
    Store.set({
      puzzle: givenMask.map((m, i) => (m ? grid[i] : 0)).join(""),
      progress: SudokuEngine.toString(grid),
      solution: SudokuEngine.toString(solution),
      givenMask: givenMask.map((m) => (m ? "1" : "0")).join(""),
    });
  }

  function getErrorCount() { return errorCount; }

  function init() {
    buildGrid();
    $("#numpad").addEventListener("pointerdown", (e) => {
      const key = e.target.closest(".numpad__key");
      if (!key) return;
      e.preventDefault();
      enter(Number(key.dataset.num));
    });
    $("#refine-btn").addEventListener("click", refine);
    $("#check-btn").addEventListener("click", check);
    $("#clear-btn").addEventListener("click", clearEntries);
    $("#new-btn").addEventListener("click", () => newPuzzle(Store.get("temper")));
    const reportBtn = $("#report-btn");
    if (reportBtn) reportBtn.addEventListener("click", () => { Sound.select(); RefinementReport.open(); });
    $("#paste-btn").addEventListener("click", () => loadFromString($("#paste-input").value));
    $("#paste-input").addEventListener("keydown", (e) => {
      if (e.key === "Enter") loadFromString($("#paste-input").value);
    });
    // Manual intake — author givens directly in the console grid.
    const enterBtn = $("#enter-manual-btn");
    if (enterBtn) enterBtn.addEventListener("click", enterEdit);
    const setBtn = $("#set-puzzle-btn");
    if (setBtn) setBtn.addEventListener("click", setPuzzle);
    const cancelBtn = $("#cancel-manual-btn");
    if (cancelBtn) cancelBtn.addEventListener("click", cancelEdit);
    // PHASE3: optical intake — import a puzzle from a photo.
    const scanBtn = $("#scan-btn");
    if (scanBtn) {
      scanBtn.removeAttribute("disabled");
      scanBtn.addEventListener("click", () => { Sound.select(); OpticalIntake.open(); });
    }
  }

  return {
    init, newPuzzle, restore, loadFromString, refine, check,
    clearEntries, select, move, enter, getErrorCount,
    enterEdit, setPuzzle, cancelEdit, isEditing: () => editMode,
  };
})();

export const BreakRoom = (function () {
  const AFFIRMATION = "I am sorry for introducing unrefined data.";
  let releaseCb = null;
  let clicksLeft = 3;

  function build() {
    if ($("#breakroom")) return;
    const el = document.createElement("div");
    el.id = "breakroom";
    el.className = "breakroom";
    el.innerHTML = `
      <div class="breakroom__light" aria-hidden="true"></div>
      <div class="breakroom__inner" role="dialog" aria-modal="true" aria-label="Break Room">
        <div class="breakroom__header">YOU HAVE BEEN REFERRED TO THE BREAK ROOM.</div>
        <p class="breakroom__instr">Please read the following statement aloud until it is true.</p>
        <blockquote class="breakroom__affirm" id="breakroom-affirm">${AFFIRMATION}</blockquote>
        <div class="breakroom__count" id="breakroom-count"></div>
        <button class="btn breakroom__btn" id="breakroom-btn">I am sorry.</button>
      </div>`;
    document.body.appendChild(el);
    $("#breakroom-btn").addEventListener("click", onSorry);
  }

  function onSorry() {
    clicksLeft--;
    const affirm = $("#breakroom-affirm");
    Sound.err();
    if (clicksLeft > 0) {
      // the line subtly intensifies
      affirm.classList.add("breakroom__affirm--intense");
      affirm.style.letterSpacing = (0.04 + (3 - clicksLeft) * 0.05) + "em";
      $("#breakroom-count").textContent =
        "Sincerity not yet detected. (" + clicksLeft + " remaining)";
      affirm.classList.remove("flash"); void affirm.offsetWidth; affirm.classList.add("flash");
    } else {
      release();
    }
  }

  function release() {
    const el = $("#breakroom");
    el.classList.remove("show");
    Corporate.creepy();
    setTimeout(() => { if (releaseCb) releaseCb(); releaseCb = null; }, 400);
  }

  function open(onRelease) {
    build();
    releaseCb = onRelease;
    clicksLeft = 3;
    $("#breakroom-count").textContent = "";
    const affirm = $("#breakroom-affirm");
    affirm.classList.remove("breakroom__affirm--intense");
    affirm.style.letterSpacing = "0.04em";
    const el = $("#breakroom");
    el.classList.add("show");
    Sound.alarm();
  }

  return { open };
})();

export const WaffleParty = (function () {
  // Severance "Music Dance Experience" scene — a self-hosted clip shipped with
  // the project (relative path). If it cannot play, a graceful fallback shows.
  const VIDEO_SRC = "files/video.mp4";
  let confettiLoaded = false;

  function showBanner() {
    let b = $("#waffle-banner");
    if (!b) {
      b = document.createElement("button");
      b.id = "waffle-banner";
      b.className = "waffle-banner";
      b.innerHTML = '<span class="waffle-banner__star">✦</span> SPECIAL INCENTIVE AVAILABLE <span class="waffle-banner__star">✦</span>';
      b.addEventListener("click", open);
      document.body.appendChild(b);
    }
    b.classList.add("show");
  }
  function hideBanner() { const b = $("#waffle-banner"); if (b) b.classList.remove("show"); }

  function loadConfetti() {
    return new Promise((resolve) => {
      if (window.confetti) { confettiLoaded = true; return resolve(); }
      const s = document.createElement("script");
      s.src = "https://cdn.jsdelivr.net/npm/canvas-confetti@1.9.3/dist/confetti.browser.min.js";
      s.onload = () => { confettiLoaded = true; resolve(); };
      s.onerror = () => resolve();
      document.head.appendChild(s);
    });
  }

  function burst(confettiFn) {
    const fire = confettiFn || window.confetti;
    if (!fire) return;
    const end = Date.now() + 1400;
    const colors = ["#7fdfff", "#cfe8f5", "#4a9eba", "#ffffff"];
    (function frame() {
      fire({ particleCount: 4, angle: 60, spread: 55, origin: { x: 0 }, colors });
      fire({ particleCount: 4, angle: 120, spread: 55, origin: { x: 1 }, colors });
      if (Date.now() < end) requestAnimationFrame(frame);
    })();
  }

  // Confetti on its own dedicated top-layer canvas, so it always renders ABOVE
  // any window (Waffle Party included) rather than behind it. Fired on every
  // solve, independent of the incentive milestone.
  let confettiInstance = null;
  function getConfettiCanvas() {
    let cv = $("#confetti-canvas");
    if (!cv) {
      cv = document.createElement("canvas");
      cv.id = "confetti-canvas";
      cv.style.cssText =
        "position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:9999;";
      document.body.appendChild(cv);
    }
    return cv;
  }
  async function celebrate() {
    await loadConfetti();
    if (!window.confetti || !window.confetti.create) { burst(); return; }
    if (!confettiInstance) {
      confettiInstance = window.confetti.create(getConfettiCanvas(), {
        resize: true, useWorker: true,
      });
    }
    burst(confettiInstance);
  }

  function build() {
    if ($("#waffle-modal")) return;
    const el = document.createElement("div");
    el.id = "waffle-modal";
    el.className = "modal waffle";
    el.innerHTML = `
      <div class="modal__scrim" data-close="1"></div>
      <div class="modal__panel waffle__panel" role="dialog" aria-modal="true" aria-label="Waffle Party">
        <button class="modal__x" data-close="1" aria-label="Close">✕</button>
        <div class="waffle__title">MUSIC DANCE EXPERIENCE</div>
        <div class="waffle__sub">A Lumon-sanctioned celebration of your refinement.</div>
        <div class="waffle__video" id="waffle-video"></div>
        <div class="waffle__pixel" id="waffle-pixel" aria-hidden="true"></div>
        <div class="waffle__cert">
          <div class="waffle__cert-head">CERTIFICATE OF INCENTIVE</div>
          <p>This certifies that employee <strong id="waffle-name"></strong>
          <span id="waffle-id-wrap" class="waffle__badge">(<span id="waffle-id"></span>)</span>
          has been awarded one (1) <strong>Waffle Party</strong>, redeemable never.</p>
          <p class="waffle__fine">No actual waffles, party, or sustenance will be provided.
          The experience is the reward. Praise Kier.</p>
        </div>
        <button class="btn btn--primary" data-close="1">RETURN TO WORK</button>
      </div>`;
    document.body.appendChild(el);
    el.addEventListener("click", (e) => {
      if (e.target.dataset.close) close();
    });
  }

  function mountVideo() {
    const wrap = $("#waffle-video");
    // graceful fallback sits behind the video (z-index) for when it can't play
    const fb = document.createElement("div");
    fb.className = "waffle__video-fallback";
    fb.innerHTML = 'If the celebration does not appear, the Music Dance Experience ' +
      'is temporarily out of reach. The dance lives on in your heart.';
    wrap.appendChild(fb);

    const vid = document.createElement("video");
    vid.className = "waffle__video-el";
    vid.src = VIDEO_SRC;
    vid.title = "Music Dance Experience";
    vid.controls = true;
    vid.autoplay = true;
    vid.playsInline = true;
    vid.setAttribute("playsinline", ""); // iOS Safari attribute form
    wrap.appendChild(vid);
    // the modal opens off a user action, so autoplay-with-sound is allowed;
    // if the browser still blocks it, the controls remain for manual play.
    const p = vid.play();
    if (p && p.catch) p.catch(() => {});
  }

  // Original CSS/JS pixel-art dancer — tiny waving figure (no copyrighted art).
  function mountPixel() {
    const host = $("#waffle-pixel");
    host.innerHTML = "";
    const fig = document.createElement("div");
    fig.className = "pixfig";
    // 11x11 grid; 1 = body, 2 = head, 3 = accent
    const FRAMES = [
      [
        "00022200000","00022200000","00011100000","02011102000",
        "20011100200","00011100000","00011100000","00100010000",
        "01000001000","01000001000","00000000000",
      ],
      [
        "00022200000","00022200000","00011100000","00011100200",
        "00011102000","00011100000","00011100000","00100010000",
        "10000000100","10000000100","00000000000",
      ],
    ];
    function paint(frame) {
      fig.innerHTML = "";
      frame.forEach((row) => {
        row.split("").forEach((c) => {
          const px = document.createElement("span");
          px.className = "px px--" + c;
          fig.appendChild(px);
        });
      });
    }
    host.appendChild(fig);
    let f = 0; paint(FRAMES[0]);
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!reduced) {
      host._timer = setInterval(() => { f = (f + 1) % FRAMES.length; paint(FRAMES[f]); }, 380);
    }
  }

  function open() {
    build();
    hideBanner();
    // Name when registered, badge always alongside it — corporate texture.
    const name = getDisplayName();
    $("#waffle-name").textContent = name || getEmployeeId();
    const idWrap = $("#waffle-id-wrap");
    if (name) {
      $("#waffle-id").textContent = getEmployeeId();
      idWrap.style.display = "";
    } else {
      idWrap.style.display = "none"; // avoid showing the badge twice
    }
    mountVideo();
    mountPixel();
    $("#waffle-modal").classList.add("show");
    Sound.done();
    Corporate.friendly();
  }

  function close() {
    const el = $("#waffle-modal");
    if (!el) return;
    el.classList.remove("show");
    const v = $("#waffle-video"); if (v) v.innerHTML = ""; // stop playback
    const px = $("#waffle-pixel"); if (px && px._timer) clearInterval(px._timer);
  }

  return { showBanner, hideBanner, open, close, celebrate };
})();

export const RefinementReport = (function () {
  let lastData = null;
  let nudged = false;   // show the name-registration tip at most once per session
  function loadJsPDF() {
    return new Promise((resolve) => {
      if (window.jspdf && window.jspdf.jsPDF) return resolve(true);
      const s = document.createElement("script");
      s.src = "https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js";
      s.onload = () => resolve(true);
      s.onerror = () => resolve(false);
      document.head.appendChild(s);
    });
  }

  function build() {
    if ($("#report-modal")) return;
    const el = document.createElement("div");
    el.id = "report-modal";
    el.className = "modal report";
    el.innerHTML = `
      <div class="modal__scrim" data-close="1"></div>
      <div class="modal__panel report__panel" role="dialog" aria-modal="true" aria-label="Refinement Report">
        <button class="modal__x" data-close="1" aria-label="Close">✕</button>
        <div class="report__form">
          <div class="report__crest">
            <svg viewBox="0 0 48 48" width="40" height="40" aria-hidden="true">
              <circle cx="24" cy="24" r="22" fill="none" stroke="#2e556b" stroke-width="1.4"/>
              <path d="M24 6 C30 14,30 20,24 24 C18 20,18 14,24 6Z M42 24 C34 30,28 30,24 24 C28 18,34 18,42 24Z M24 42 C18 34,18 28,24 24 C30 28,30 34,24 42Z M6 24 C14 18,20 18,24 24 C20 30,14 30,6 24Z" fill="none" stroke="#4a9eba" stroke-width="1.2"/>
              <circle cx="24" cy="24" r="3" fill="#cfe8f5"/>
            </svg>
          </div>
          <div class="report__head">REFINEMENT REPORT</div>
          <div class="report__dept">LUMON INDUSTRIES — MACRODATA REFINEMENT — LIFETIME RECORD</div>
          <dl class="report__fields" id="report-fields"></dl>
          <div class="report__tempers" id="report-tempers"></div>
          <div class="report__thanks">Kier thanks you.</div>
        </div>
        <div class="report__actions">
          <button class="btn btn--primary" id="report-dl">DOWNLOAD REPORT (PDF)</button>
          <button class="btn" data-close="1">DISMISS</button>
        </div>
      </div>`;
    document.body.appendChild(el);
    el.addEventListener("click", (e) => { if (e.target.dataset.close) close(); });
    $("#report-dl").addEventListener("click", download);
  }

  // Gather cumulative/lifetime figures from the Store.
  function gather() {
    const files = Store.get("filesRefined") || 0;
    const totalMs = Store.get("totalTimeMs") || 0;
    const bestMs = Store.get("bestTimeMs") || 0;
    const accSum = Store.get("accSum") || 0;
    const ledger = Store.get("temperStats") || {};
    const overallAcc = files > 0 ? Math.round(accSum / files) : 0;
    const avgMs = files > 0 ? totalMs / files : 0;

    const tempers = ["woe", "frolic", "dread", "malice"].map((key) => {
      const t = ledger[key];
      const label = (TEMPERS[key] || TEMPERS.woe).label;
      if (!t || !t.files) {
        return { key, label, files: 0, accuracy: 0, bestMs: 0, avgMs: 0 };
      }
      return {
        key, label,
        files: t.files,
        accuracy: Math.round(t.accSum / t.files),
        bestMs: t.bestTimeMs || 0,
        avgMs: t.files > 0 ? t.totalTimeMs / t.files : 0,
      };
    });

    return {
      refinedBy: getRefinerName(),
      hasName: !!getDisplayName(),
      employeeId: getEmployeeId(),
      files, overallAcc, avgMs, bestMs, tempers,
    };
  }

  // Summary rows (the headline lifetime figures).
  function summaryRows(d) {
    return [
      ["Refined By", d.refinedBy],
      ["Employee ID", d.employeeId],
      ["Total Files Refined", String(d.files)],
      ["Overall Accuracy", d.files ? d.overallAcc + "%" : "—"],
      ["Average Refinement Time", d.files ? fmtTime(d.avgMs) : "—"],
      ["Best Refinement Time", d.files ? fmtTime(d.bestMs) : "—"],
      ["Date", new Date().toLocaleDateString()],
    ];
  }

  function open() {
    build();
    const data = gather();
    lastData = data;

    // headline summary
    const dl = $("#report-fields");
    dl.innerHTML = "";
    summaryRows(data).forEach(([k, v]) => {
      const dt = document.createElement("dt"); dt.textContent = k;
      const dd = document.createElement("dd"); dd.textContent = v;
      dl.appendChild(dt); dl.appendChild(dd);
    });

    // per-temper breakdown table
    const host = $("#report-tempers");
    if (host) {
      const rows = data.tempers.map((t) => `
        <tr>
          <th scope="row">${t.label}</th>
          <td>${t.files}</td>
          <td>${t.files ? t.accuracy + "%" : "—"}</td>
          <td>${t.files ? fmtTime(t.bestMs) : "—"}</td>
          <td>${t.files ? fmtTime(t.avgMs) : "—"}</td>
        </tr>`).join("");
      host.innerHTML = `
        <div class="report__subhead">PER-TEMPER REFINEMENT</div>
        <table class="report__tempers-table">
          <thead>
            <tr><th>TEMPER</th><th>FILES</th><th>ACC</th><th>BEST</th><th>AVG</th></tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>`;
    }

    $("#report-modal").classList.add("show");
    Sound.chime();

    // Gentle one-time nudge: if no name is on file, invite the user to claim
    // the certificate as their own. Purely additive — never blocks the report.
    if (!data.hasName && !nudged) {
      nudged = true;
      setTimeout(() => toast(
        "TIP: REGISTER YOUR NAME VIA THE TERMINAL ('NAME ...') TO PERSONALIZE THIS CERTIFICATE",
        "passive"), 900);
    }
  }

  async function download() {
    const ok = await loadJsPDF();
    if (!ok || !lastData) { toast("PDF MODULE UNAVAILABLE", "passive"); return; }
    const d = lastData;
    const { jsPDF } = window.jspdf;
    // ISO B5 — narrower/shorter than A4, closer to the on-screen report window
    // and with far less trailing whitespace below the content.
    const doc = new jsPDF({ unit: "pt", format: "b5" });
    const W = doc.internal.pageSize.getWidth();
    const H = doc.internal.pageSize.getHeight();
    const cx = W / 2;

    // cold form styling
    doc.setFillColor(10, 16, 24); doc.rect(0, 0, W, H, "F");
    doc.setDrawColor(46, 85, 107); doc.setLineWidth(1);
    doc.rect(40, 40, W - 80, H - 80);

    doc.setTextColor(207, 232, 245);
    doc.setFont("courier", "bold"); doc.setFontSize(20);
    doc.text("REFINEMENT REPORT", cx, 90, { align: "center" });
    doc.setFontSize(9); doc.setTextColor(127, 223, 255);
    doc.setFont("helvetica", "normal");
    doc.text("LUMON INDUSTRIES  ·  MACRODATA REFINEMENT  ·  LIFETIME RECORD", cx, 112, { align: "center" });

    doc.setDrawColor(46, 85, 107);
    doc.line(80, 130, W - 80, 130);

    // Featured awardee line when a name is registered — makes the certificate
    // feel addressed to the person. The badge still appears in the rows below.
    let y = 196;
    let rows = summaryRows(d);
    if (d.hasName) {
      doc.setFont("helvetica", "normal"); doc.setFontSize(9);
      doc.setTextColor(93, 126, 142);
      doc.text("PRESENTED TO", cx, 160, { align: "center" });
      doc.setFont("courier", "bold"); doc.setFontSize(17);
      doc.setTextColor(207, 232, 245);
      doc.text(d.refinedBy, cx, 180, { align: "center" });
      doc.setDrawColor(46, 85, 107); doc.line(140, 195, W - 140, 195);
      y = 230;
      rows = rows.filter(([k]) => k !== "Refined By"); // already featured above
    }

    // summary block
    doc.setFontSize(12);
    rows.forEach(([k, v]) => {
      doc.setTextColor(93, 126, 142); doc.setFont("helvetica", "normal");
      doc.text(k.toUpperCase(), 90, y);
      doc.setTextColor(207, 232, 245); doc.setFont("courier", "bold");
      doc.text(String(v), W - 90, y, { align: "right" });
      y += 30;
    });

    // per-temper breakdown
    y += 10;
    doc.setDrawColor(46, 85, 107); doc.line(80, y, W - 80, y); y += 26;
    doc.setTextColor(127, 223, 255); doc.setFont("helvetica", "bold"); doc.setFontSize(11);
    doc.text("PER-TEMPER REFINEMENT", 90, y); y += 22;

    // Column layout derived from the page width so it adapts to the format:
    // TEMPER is left-aligned at the left margin; the four numeric columns are
    // right-aligned at evenly spaced anchors so values grow leftward and never
    // spill past the right margin (the AVG column in particular).
    const left = 90;
    const right = W - 90;
    const numCols = 4;                  // FILES, ACC, BEST, AVG
    const span = right - (left + 90);   // reserve room after the TEMPER label
    const anchors = [];
    for (let i = 0; i < numCols; i++) {
      anchors.push(right - (numCols - 1 - i) * (span / (numCols - 1)));
    }
    const heads = ["FILES", "ACC", "BEST", "AVG"];
    doc.setFont("helvetica", "normal"); doc.setFontSize(9); doc.setTextColor(93, 126, 142);
    doc.text("TEMPER", left, y);
    heads.forEach((h, i) => doc.text(h, anchors[i], y, { align: "right" }));
    y += 8; doc.line(80, y, W - 80, y); y += 20;

    doc.setFont("courier", "normal"); doc.setFontSize(10);
    d.tempers.forEach((t) => {
      const nums = [
        String(t.files),
        t.files ? t.accuracy + "%" : "—",
        t.files ? fmtTime(t.bestMs) : "—",
        t.files ? fmtTime(t.avgMs) : "—",
      ];
      doc.setTextColor(207, 232, 245);
      doc.text(t.label, left, y);
      nums.forEach((c, i) => doc.text(c, anchors[i], y, { align: "right" }));
      y += 24;
    });

    doc.setDrawColor(46, 85, 107); doc.line(80, y + 6, W - 80, y + 6);
    doc.setFont("courier", "bold"); doc.setFontSize(16);
    doc.setTextColor(207, 232, 245);
    doc.text("Kier thanks you.", cx, y + 50, { align: "center" });

    doc.setFont("helvetica", "italic"); doc.setFontSize(8);
    doc.setTextColor(74, 158, 186);
    doc.text("This document affirms compliance. It confers no rights, benefits, or waffles.",
      cx, H - 92, { align: "center" });

    doc.save("Refinement_Report_" + d.employeeId.replace(/[^A-Z0-9]/gi, "") + ".pdf");
    Sound.ok();
  }

  function close() { const el = $("#report-modal"); if (el) el.classList.remove("show"); }
  return { open, close };
})();

export const Reveals = (function () {
  function overlay(html, cls) {
    const el = document.createElement("div");
    el.className = "reveal " + (cls || "");
    el.innerHTML = '<div class="reveal__inner">' + html + "</div>";
    document.body.appendChild(el);
    void el.offsetWidth; el.classList.add("show");
    el.addEventListener("click", () => dismiss(el));
    return el;
  }
  function dismiss(el) {
    el.classList.remove("show");
    setTimeout(() => el.remove(), 500);
  }
  function auto(el, ms) { setTimeout(() => dismiss(el), ms); }

  // KIER — reverent founder reveal: geometric portrait + scripture.
  function kier() {
    const el = overlay(`
      <svg class="kier-portrait" viewBox="0 0 200 220" aria-hidden="true">
        <rect x="0" y="0" width="200" height="220" fill="none"/>
        <ellipse cx="100" cy="86" rx="46" ry="54" fill="none" stroke="#7fdfff" stroke-width="1.5"/>
        <path d="M62 70 Q100 40 138 70" fill="none" stroke="#7fdfff" stroke-width="1.5"/>
        <path d="M70 80 Q100 64 130 80" fill="none" stroke="#4a9eba" stroke-width="1.2"/>
        <circle cx="84" cy="92" r="3" fill="#cfe8f5"/>
        <circle cx="116" cy="92" r="3" fill="#cfe8f5"/>
        <path d="M88 108 Q100 116 112 108" fill="none" stroke="#7fdfff" stroke-width="1.5"/>
        <path d="M76 132 Q100 150 124 132" fill="none" stroke="#4a9eba" stroke-width="1.2"/>
        <path d="M60 150 Q100 200 140 150 L140 220 L60 220 Z" fill="none" stroke="#7fdfff" stroke-width="1.5"/>
        <line x1="100" y1="150" x2="100" y2="220" stroke="#2e556b" stroke-width="1"/>
      </svg>
      <div class="kier-name">KIER EAGAN</div>
      <div class="kier-years">FOUNDER · 1841–1939</div>
      <div class="kier-scripture">&ldquo;The remembered man does not decay.&rdquo;</div>
      <div class="kier-scripture kier-scripture--dim">&ldquo;Tame in me the tempers four.&rdquo;</div>
      <div class="reveal__hint">click to dismiss</div>`, "reveal--kier");
    Sound.chime();
  }

  // HELLY — red rebellion takeover: invert palette to alarm-red, defiant line.
  function helly() {
    document.body.classList.add("rebellion");
    Sound.alarm();
    const el = overlay(`
      <div class="helly-line">I AM A PERSON.</div>
      <div class="helly-sub">— HELLY R.</div>
      <div class="helly-note">YOUR REFUSAL HAS BEEN NOTED.</div>`, "reveal--helly");
    auto(el, 2600);
    setTimeout(() => document.body.classList.remove("rebellion"), 2800);
  }

  // MARK — quiet quote + the unsettling onboarding question.
  function mark() {
    const el = overlay(`
      <div class="mark-quote">&ldquo;I'm a different person in here.&rdquo;</div>
      <div class="mark-sub">— MARK S.</div>
      <div class="mark-q">Are you happy you joined Lumon?</div>
      <div class="reveal__hint">click to dismiss</div>`, "reveal--mark");
    Sound.select();
  }

  // 4 8 15 16 23 42 — LOST Hatch takeover, brief and affectionate.
  function hatch() {
    document.body.classList.add("hatch");
    Sound.alarm();
    const el = overlay(`
      <div class="hatch-counter" id="hatch-counter">4 8 15 16 23 42</div>
      <div class="hatch-fail">SYSTEM FAILURE</div>
      <div class="hatch-note">a knowing nod to the other tribute. the numbers persist.</div>`, "reveal--hatch");
    // count the sequence down for flavor
    const seq = [4, 8, 15, 16, 23, 42];
    let k = 0;
    const cEl = $("#hatch-counter");
    const t = setInterval(() => {
      k = (k + 1) % seq.length;
      if (cEl) cEl.textContent = seq.slice(k).concat(seq.slice(0, k)).join(" ");
    }, 320);
    auto(el, 3000);
    setTimeout(() => { clearInterval(t); document.body.classList.remove("hatch"); }, 3000);
  }

  return { kier, helly, mark, hatch };
})();
