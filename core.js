/* ============================================================
   LUMON INDUSTRIES — MACRODATA REFINEMENT
   core.js — shared foundation for every screen.

   Contents (in dependency order):
     constants / corpora   TEMPERS, MESSAGES, CATECHISMS, FALLBACK, ...
     util                  $, $$, fmtTime, toast
     SudokuEngine          pure solver / generator / validator (no DOM)
     Store                 localStorage-backed session state
     Sound                 .ogg sample playback + synth ambient hum
     Corporate             tiered corporate-message system
     Field                 intake drifting-number canvas
     Interstitial          the "FILE ACCEPTED / COMPLETE" beat
     badge helpers         getEmployeeId, randomFileCode

   Everything here is imported by sudoku.js, ocr.js, floor.js
   and app.js. core.js itself imports nothing.
   ============================================================ */

/* ---- constants / config ---- */
export const TEMPERS = {
  woe:    { label: "WOE",    clues: 42, tier: 1 },
  frolic: { label: "FROLIC", clues: 34, tier: 2 },
  dread:  { label: "DREAD",  clues: 28, tier: 3 },
  malice: { label: "MALICE", clues: 24, tier: 4 },
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

  /* ============================================================
     CONSTRAINT PROPAGATION LAYER (additive, pure)

     Norvig-style candidate model used for: difficulty rating
     (WOE/FROLIC/DREAD/MALICE), a fast logical solver, and a fast
     uniqueness check. None of this changes the existing public
     signatures; it only adds fast paths and new methods.

     Tiers (cheapest first):
       1 WOE    naked singles + hidden singles
       2 FROLIC locked candidates (pointing / claiming)
       3 DREAD  naked pairs + hidden pairs
       4 MALICE logic stalls -> search/backtracking required
     ============================================================ */

  // --- unit & peer geometry (computed once) ---------------------
  const UNITS = (function () {
    const units = [];
    for (let r = 0; r < 9; r++) units.push([...Array(9)].map((_, c) => r * 9 + c));
    for (let c = 0; c < 9; c++) units.push([...Array(9)].map((_, r) => r * 9 + c));
    for (let b = 0; b < 9; b++) {
      const br = Math.floor(b / 3) * 3, bc = (b % 3) * 3, g = [];
      for (let dr = 0; dr < 3; dr++) for (let dc = 0; dc < 3; dc++)
        g.push((br + dr) * 9 + (bc + dc));
      units.push(g);
    }
    return units; // 27 units: rows 0-8, cols 9-17, boxes 18-26
  })();

  // unitsOf[i] = the three units containing cell i; PEERS[i] = the 20 cells
  // sharing a unit with i (excluding i).
  const UNITS_OF = [...Array(81)].map(() => []);
  for (let u = 0; u < UNITS.length; u++)
    for (const i of UNITS[u]) UNITS_OF[i].push(u);
  const PEERS = (function () {
    const peers = [...Array(81)].map(() => new Set());
    for (let i = 0; i < 81; i++) {
      for (const u of UNITS_OF[i]) for (const j of UNITS[u]) if (j !== i) peers[i].add(j);
    }
    return peers.map((s) => [...s]);
  })();

  // Candidate sets are 9-bit masks: bit (v-1) set => v is possible.
  const ALL = 0b111111111;
  const BITCOUNT = new Int8Array(512);
  for (let m = 0; m < 512; m++) BITCOUNT[m] = (m & 1) + BITCOUNT[m >> 1];
  const bitToVal = (m) => 31 - Math.clz32(m) + 1; // value of a single-bit mask
  const maskVals = (m) => { const a = []; for (let v = 1; v <= 9; v++) if (m & (1 << (v - 1))) a.push(v); return a; };

  // Build candidate masks from a grid. Returns Int16Array(81) or null on
  // immediate contradiction. Filled cells get the single placed bit.
  function buildCandidates(grid) {
    const cand = new Int16Array(81).fill(ALL);
    for (let i = 0; i < 81; i++) {
      const v = grid[i];
      if (v !== 0) {
        cand[i] = 1 << (v - 1);
        for (const p of PEERS[i]) {
          cand[p] &= ~(1 << (v - 1));
          if (cand[p] === 0 && grid[p] === 0) return null; // wiped out an empty cell
        }
      }
    }
    return cand;
  }

  const solvedMask = (cand) => { for (let i = 0; i < 81; i++) if (BITCOUNT[cand[i]] !== 1) return false; return true; };

  // Assign a single bit to cell i: eliminate every OTHER candidate from i,
  // letting the natural reduction-to-singleton inside eliminate() propagate
  // the placement to peers. (Do NOT pre-set cand[i]=bit — that would short-
  // circuit eliminate's singleton trigger and skip peer propagation.)
  // Mutates cand. Returns false on contradiction.
  function assign(cand, i, bit) {
    const others = cand[i] & ~bit;
    if (others === 0) {
      // already the single bit (or empty): still must ensure peers are pruned
      if (cand[i] === bit) for (const p of PEERS[i]) if (!eliminate(cand, p, bit)) return false;
      return cand[i] === bit;
    }
    for (let v = 1; v <= 9; v++) if (others & (1 << (v - 1))) {
      if (!eliminate(cand, i, 1 << (v - 1))) return false;
    }
    return true;
  }
  function eliminate(cand, i, bit) {
    if (!(cand[i] & bit)) return true;       // already gone
    cand[i] &= ~bit;
    if (cand[i] === 0) return false;          // contradiction
    if (BITCOUNT[cand[i]] === 1) {            // became a naked single -> push to peers
      const only = cand[i];
      for (const p of PEERS[i]) if (!eliminate(cand, p, only)) return false;
    }
    return true;
  }

  // --- Tier 1: singles -----------------------------------------
  // Returns 1 if a placement was made, 0 if none, -1 on contradiction.
  function stepSingles(cand) {
    // naked single
    for (let i = 0; i < 81; i++) {
      if (BITCOUNT[cand[i]] === 1) continue;
      if (BITCOUNT[cand[i]] === 0) return -1;
    }
    // hidden single: a value with exactly one home in some unit
    for (const unit of UNITS) {
      for (let v = 1; v <= 9; v++) {
        const bit = 1 << (v - 1);
        let where = -1, n = 0;
        for (const i of unit) if (cand[i] & bit) { n++; where = i; if (n > 1) break; }
        if (n === 1 && BITCOUNT[cand[where]] !== 1) {
          return assign(cand, where, bit) ? 1 : -1;
        }
      }
    }
    return 0;
  }

  // --- Tier 2: locked candidates (pointing / claiming) ----------
  function stepLocked(cand) {
    let changed = 0;
    for (let b = 0; b < 9; b++) {
      const box = UNITS[18 + b];
      for (let v = 1; v <= 9; v++) {
        const bit = 1 << (v - 1);
        const cells = box.filter((i) => cand[i] & bit);
        if (cells.length < 2) continue;
        const rows = new Set(cells.map((i) => Math.floor(i / 9)));
        const cols = new Set(cells.map((i) => i % 9));
        // pointing: confined to one row/col within the box -> clear rest of that line
        if (rows.size === 1) {
          const r = [...rows][0];
          for (let c = 0; c < 9; c++) { const i = r * 9 + c; if (!box.includes(i) && (cand[i] & bit)) { if (!eliminate(cand, i, bit)) return -1; changed = 1; } }
        }
        if (cols.size === 1) {
          const c = [...cols][0];
          for (let r = 0; r < 9; r++) { const i = r * 9 + c; if (!box.includes(i) && (cand[i] & bit)) { if (!eliminate(cand, i, bit)) return -1; changed = 1; } }
        }
      }
    }
    // claiming: a value in a row/col confined to one box -> clear rest of that box
    for (let u = 0; u < 18; u++) {
      const line = UNITS[u];
      for (let v = 1; v <= 9; v++) {
        const bit = 1 << (v - 1);
        const cells = line.filter((i) => cand[i] & bit);
        if (cells.length < 2) continue;
        const boxes = new Set(cells.map((i) => Math.floor(Math.floor(i / 9) / 3) * 3 + Math.floor((i % 9) / 3)));
        if (boxes.size === 1) {
          const box = UNITS[18 + [...boxes][0]];
          for (const i of box) if (!line.includes(i) && (cand[i] & bit)) { if (!eliminate(cand, i, bit)) return -1; changed = 1; }
        }
      }
    }
    return changed;
  }

  // --- Tier 3: naked & hidden pairs ----------------------------
  function stepPairs(cand) {
    let changed = 0;
    for (const unit of UNITS) {
      // naked pair: two cells sharing the same 2-candidate mask
      for (let a = 0; a < unit.length; a++) {
        const ia = unit[a];
        if (BITCOUNT[cand[ia]] !== 2) continue;
        for (let b = a + 1; b < unit.length; b++) {
          const ib = unit[b];
          if (cand[ib] !== cand[ia]) continue;
          const pairMask = cand[ia];
          for (const i of unit) if (i !== ia && i !== ib && (cand[i] & pairMask)) {
            if (!eliminate(cand, i, cand[i] & pairMask)) return -1; changed = 1;
          }
        }
      }
      // hidden pair: two values whose only homes in the unit are the same 2 cells
      const homes = {};
      for (let v = 1; v <= 9; v++) {
        const bit = 1 << (v - 1);
        homes[v] = unit.filter((i) => cand[i] & bit);
      }
      for (let v1 = 1; v1 <= 9; v1++) {
        if (homes[v1].length !== 2) continue;
        for (let v2 = v1 + 1; v2 <= 9; v2++) {
          if (homes[v2].length !== 2) continue;
          if (homes[v1][0] !== homes[v2][0] || homes[v1][1] !== homes[v2][1]) continue;
          const keep = (1 << (v1 - 1)) | (1 << (v2 - 1));
          for (const i of homes[v1]) if (cand[i] & ~keep) {
            if (!eliminate(cand, i, cand[i] & ~keep)) return -1; changed = 1;
          }
        }
      }
    }
    return changed;
  }

  // Run logic to a fixpoint. Returns { cand, status, hardest } where
  // status is "solved" | "stuck" | "contradiction" and hardest is the
  // top tier that fired (1..3); 0 means trivially complete from givens.
  function propagate(grid) {
    const cand = buildCandidates(grid);
    if (!cand) return { cand: null, status: "contradiction", hardest: 0 };
    let hardest = 0;
    for (;;) {
      if (solvedMask(cand)) return { cand, status: "solved", hardest };
      let r = stepSingles(cand);
      if (r === -1) return { cand, status: "contradiction", hardest };
      if (r === 1) { hardest = Math.max(hardest, 1); continue; }
      r = stepLocked(cand);
      if (r === -1) return { cand, status: "contradiction", hardest };
      if (r === 1) { hardest = Math.max(hardest, 2); continue; }
      r = stepPairs(cand);
      if (r === -1) return { cand, status: "contradiction", hardest };
      if (r === 1) { hardest = Math.max(hardest, 3); continue; }
      return { cand, status: "stuck", hardest }; // logic exhausted
    }
  }

  // Difficulty rating. Returns one of the temper keys, or "invalid".
  //   solved by logic -> woe/frolic/dread by hardest tier used
  //   logic stalls (still needs guessing) -> malice
  const TIER_KEY = ["woe", "woe", "frolic", "dread"]; // index = hardest (0..3)
  function rate(grid) {
    const { status, hardest } = propagate(grid);
    if (status === "contradiction") return "invalid";
    if (status === "solved") return TIER_KEY[hardest];
    return "malice"; // stuck but consistent -> requires search
  }

  // Logical solve: propagate, then fall back to search only if needed.
  // Writes the solution into `grid` in place. Returns true if solved.
  function solveFast(grid) {
    const res = propagate(grid);
    if (res.status === "contradiction") return false;
    if (res.status === "solved") {
      for (let i = 0; i < 81; i++) grid[i] = bitToVal(res.cand[i]);
      return true;
    }
    // search with propagation at each node (operate on candidate masks)
    const solution = searchCand(res.cand);
    if (!solution) return false;
    for (let i = 0; i < 81; i++) grid[i] = bitToVal(solution[i]);
    return true;
  }

  // Backtracking search over candidate masks, propagating after each guess.
  // Returns a solved mask array or null. Used by solveFast / countFast.
  function searchCand(cand) {
    // pick MRV cell among unsolved
    let best = -1, bestN = 10;
    for (let i = 0; i < 81; i++) {
      const n = BITCOUNT[cand[i]];
      if (n === 1) continue;
      if (n < bestN) { bestN = n; best = i; if (n === 2) break; }
    }
    if (best === -1) return cand;     // all singletons -> solved
    for (const v of maskVals(cand[best])) {
      const next = cand.slice();
      if (assign(next, best, 1 << (v - 1)) && reduceFix(next)) {
        const got = searchCand(next);
        if (got) return got;
      }
    }
    return null;
  }
  // re-run singles fixpoint after an assign during search (cheap, keeps tree small)
  function reduceFix(cand) {
    for (;;) {
      const r = stepSingles(cand);
      if (r === -1) return false;
      if (r === 0) return true;
    }
  }

  // Count solutions up to `limit` using propagation (fast uniqueness).
  function countFast(grid, limit) {
    const res = propagate(grid);
    if (res.status === "contradiction") return 0;
    if (res.status === "solved") return 1;
    let count = 0;
    (function rec(cand) {
      if (count >= limit) return;
      let best = -1, bestN = 10;
      for (let i = 0; i < 81; i++) { const n = BITCOUNT[cand[i]]; if (n === 1) continue; if (n < bestN) { bestN = n; best = i; if (n === 2) break; } }
      if (best === -1) { count++; return; }
      for (const v of maskVals(cand[best])) {
        const next = cand.slice();
        if (assign(next, best, 1 << (v - 1)) && reduceFix(next)) rec(next);
        if (count >= limit) return;
      }
    })(res.cand);
    return count;
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

  // Solve in place. Returns true if solved. Now propagation-first
  // (solveFast), which dramatically prunes search on hard grids.
  function solve(grid) {
    return solveFast(grid);
  }

  // Original plain MRV backtracker, retained for reference / safety net.
  function solveBacktrack(grid) {
    const spot = findBestCell(grid);
    if (spot === null) return true;        // no empties -> solved
    if (spot.cands.length === 0) return false;
    for (const v of spot.cands) {
      grid[spot.i] = v;
      if (solveBacktrack(grid)) return true;
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
    return countFast(grid.slice(), 2) === 1;
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

  // Carve a unique puzzle from a full solution, removing as many clues
  // as possible (down toward `floor`) while preserving uniqueness.
  // `floor` just bounds how aggressive removal gets; uniqueness is the
  // real constraint. Returns { puzzle, solution }.
  function carveUnique(floor) {
    const solution = generateFull();
    const puzzle = solution.slice();
    const order = shuffle([...Array(81).keys()]);
    let clues = 81;
    for (const idx of order) {
      if (clues <= floor) break;
      const backup = puzzle[idx];
      if (backup === 0) continue;
      puzzle[idx] = 0;
      if (hasUniqueSolution(puzzle)) clues--;
      else puzzle[idx] = backup; // reverting — removal broke uniqueness
    }
    return { puzzle, solution };
  }

  // Per-temper carve floor: harder tempers want sparser grids, which
  // tend to demand harder techniques. These are starting pressures for
  // the accept loop, not the accept criterion (rate() is).
  const CARVE_FLOOR = { woe: 40, frolic: 32, dread: 26, malice: 22 };

  // generate(target):
  //   - string temper key ("woe".."malice"): generate-rate-accept loop,
  //     returning a puzzle whose hardest required technique matches the
  //     target temper. Falls back to the closest rating after a budget.
  //   - number: legacy clue-count carve (back-compat for old callers).
  // Returns { puzzle, solution, temper, clues }.
  function generate(target) {
    if (typeof target === "number") {
      const r = carveUnique(target);
      r.temper = rate(r.puzzle);
      r.clues = r.puzzle.filter((n) => n !== 0).length;
      return r;
    }
    const want = TEMPERS[target] ? target : "woe";
    const order = ["woe", "frolic", "dread", "malice"];
    const wantIdx = order.indexOf(want);
    const baseFloor = CARVE_FLOOR[want] ?? 30;
    const BUDGET = 80;
    let best = null, bestDist = Infinity;
    for (let attempt = 0; attempt < BUDGET; attempt++) {
      // jitter the floor a little each attempt so puzzles aren't all the
      // same clue count and the loop explores nearby difficulty.
      const floor = baseFloor + (Math.floor(Math.random() * 5) - 2);
      const r = carveUnique(floor);
      const got = rate(r.puzzle);
      if (got === want) {
        r.temper = got;
        r.clues = r.puzzle.filter((n) => n !== 0).length;
        return r;
      }
      const dist = got === "invalid" ? 99 : Math.abs(order.indexOf(got) - wantIdx);
      if (dist < bestDist) { bestDist = dist; best = { ...r, temper: got }; }
    }
    best.clues = best.puzzle.filter((n) => n !== 0).length;
    return best; // closest rating found within budget
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
    // additive constraint-propagation layer:
    rate, propagate, buildCandidates, solveBacktrack,
    countSolutions: countFast, maskVals,
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
    bestTimeMs: 0,        // lifetime fastest single refinement (0 = none yet)
    accSum: 0,            // sum of per-file accuracy %, for lifetime mean
    // per-temper lifetime ledger: { files, accSum, totalTimeMs, bestTimeMs }
    temperStats: { woe: null, frolic: null, dread: null, malice: null },
    muted: false,
    ambient: false,    // low hum toggle
    screen: "intake",
    employeeId: null,  // persisted MDR-#### badge
    displayName: null, // optional self-registered name for certificates
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

/* ---- Sound ----
   File-backed one-shot samples (decoded WebAudio buffers) plus the synthesized
   ambient office hum. Every UI cue plays a real .ogg from /soundfx; the hum
   stays procedural.

   Each event is [filename, gain, poolSize]. WebAudio buffer sources are already
   polyphonic, so rapid repeats never get cut off; the pool size is a *voice cap*
   on top of that — when more than `poolSize` copies of the same cue are sounding
   at once, the oldest is stolen. That keeps fast typing crisp without letting a
   burst (e.g. the refine sweep) stack into a clipping wall. pool 1 = "restart,
   never overlap" (used for the long boot / loading beds).

   A few events deliberately share a file (type+key = keys, ok+chime = card);
   the buffer is fetched/decoded once per file.
*/
export const Sound = (function () {
  const SFX = "soundfx/";
  // event → [filename, gain, poolSize]
  const SAMPLES = {
    boot:     ["boot.ogg",     0.70, 2], // "FILE ACCEPTED" page transition (console/floor/about)
    loading:  ["loading.ogg",  0.60, 1], // solver sweep when REFINE FILE is pressed
    type:     ["keys.ogg",     0.50, 6], // terminal typing (repeats a lot)
    key:      ["keys.ogg",     0.45, 4], // number / keypad entry, manual givens, OCR cell edit
    select:   ["pop.ogg",      0.60, 3], // UI clicks + navigation
    ok:       ["card.ogg",     0.70, 3], // confirm / accept + OCR file/camera buttons
    err:      ["beep.ogg",     0.55, 4], // rejected / invalid / error-nature events
    chime:    ["card.ogg",     0.60, 2], // positive milestone (solve / reveal / bin credit / OCR open)
    done:     ["tada.ogg",     0.85, 2], // celebration: confetti burst + floor file complete
    report:   ["lumon.ogg",    0.85, 2], // the Refinement Report window opening
    glitch:   ["glitch.ogg",   0.80, 2], // unsettling easter eggs (break room / helly / hatch)
    reset:    ["elevator.ogg", 0.80, 1], // the RESET button
    mouse:    ["mouse.ogg",    0.60, 3], // floor: number selection (released click / brush)
    swoosh:   ["swoosh.ogg",   0.60, 3], // floor: the selection starts flying toward a bin
    dump:     ["bin.ogg",      0.60, 3], // floor: the numbers land / are dumped in the bin
    process:  ["process.ogg",  0.70, 1], // optical intake: reading numerals from the image
    binOpen:  ["open.ogg",     0.70, 2], // floor: a bin's lids swing open
    binClose: ["close.ogg",    0.70, 2], // floor: a bin's lids swing shut
  };

  let ctx = null;
  const buffers = {};      // filename → decoded AudioBuffer (shared across events)
  const voices = {};       // event name → array of currently-sounding sources

  function ensure() {
    if (!ctx) {
      try { ctx = new (window.AudioContext || window.webkitAudioContext)(); }
      catch (e) { return null; }
      preload();
    }
    if (ctx.state === "suspended") ctx.resume().catch(() => {});
    return ctx;
  }

  // Decode every distinct file up-front so cues fire with no first-hit latency.
  function preload() {
    new Set(Object.values(SAMPLES).map((s) => s[0])).forEach((file) => {
      if (buffers[file]) return;
      fetch(SFX + file)
        .then((r) => r.arrayBuffer())
        .then((b) => ctx.decodeAudioData(b))
        .then((decoded) => { buffers[file] = decoded; })
        .catch(() => {}); // a missing/blocked sample simply stays silent
    });
  }

  function play(name) {
    if (Store.get("muted")) return;
    if (!ensure()) return;
    const spec = SAMPLES[name]; if (!spec) return;
    const [file, gain, pool] = spec;
    const fire = (buf) => {
      if (Store.get("muted")) return;
      const live = (voices[name] || []).filter((s) => s._on);
      // voice cap: steal the oldest sounding voice when the pool is full
      while (live.length >= (pool || 1)) {
        const old = live.shift();
        try { old.stop(); } catch (e) {}
        old._on = false;
      }
      const src = ctx.createBufferSource(), g = ctx.createGain();
      src.buffer = buf; g.gain.value = gain;
      src.connect(g); g.connect(ctx.destination);
      src._on = true;
      src.onended = () => { src._on = false; };
      src.start();
      live.push(src);
      voices[name] = live;
    };
    const buf = buffers[file];
    if (buf) { fire(buf); return; }
    // not decoded yet → fetch+decode, then play
    fetch(SFX + file)
      .then((r) => r.arrayBuffer())
      .then((b) => ctx.decodeAudioData(b))
      .then((decoded) => { buffers[file] = decoded; fire(decoded); })
      .catch(() => {});
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
    boot:     () => play("boot"),
    loading:  () => play("loading"),
    type:     () => play("type"),
    key:      () => play("key"),
    select:   () => play("select"),
    ok:       () => play("ok"),
    err:      () => play("err"),
    chime:    () => play("chime"),
    done:     () => play("done"),
    report:   () => play("report"),
    glitch:   () => play("glitch"),
    reset:    () => play("reset"),
    mouse:    () => play("mouse"),
    swoosh:   () => play("swoosh"),
    dump:     () => play("dump"),
    process:  () => play("process"),
    binOpen:  () => play("binOpen"),
    binClose: () => play("binClose"),
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
    // The interstitial itself is silent for "FILE ACCEPTED": real page changes
    // (console/floor/about) sound boot.ogg in their own handlers, while loading
    // a file into the already-open console (OCR / manual SET) already cued ok.
    // Other interstitials (FILE COMPLETE, BOX BALANCED…) keep the short cue.
    if (!/FILE ACCEPTED/i.test(text)) Sound.ok();
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

// Optional self-registered name. Sanitized: trimmed, control chars stripped,
// collapsed whitespace, capped at 40 chars. Returns the stored name or null.
export function setDisplayName(raw) {
  const clean = String(raw || "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 40);
  Store.set({ displayName: clean || null });
  return clean || null;
}
export function getDisplayName() { return Store.get("displayName") || null; }
// Name when set, otherwise the badge — so certificates always render.
export function getRefinerName() { return getDisplayName() || getEmployeeId(); }

export function randomFileCode() {
  const L = "ABCDEFGHJKLMNPRSTUVWXY";
  return (10 + Math.floor(Math.random() * 89)) +
    L[Math.floor(Math.random() * L.length)] + "-" +
    (1 + Math.floor(Math.random() * 9));
}

