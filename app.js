/* ============================================================
   app.js — ORCHESTRATOR / entry point (ES module).

   Loaded via <script type="module" src="app.js"></script>.
   Imports the four feature areas, then defines the two pieces
   that tie them together and boots the app:

     Terminal — intake command line (routes to App + eggs).
     App      — screen state machine + global wiring.

   File map:
     core.js    constants, util, SudokuEngine, Store, Sound,
                Corporate, Field, Interstitial, badge helpers
     sudoku.js  Console + BreakRoom + WaffleParty + Report + Reveals
     ocr.js     OpticalIntake (photo → puzzle)
     floor.js   Refinement Floor mini-game
   ============================================================ */
import {
  CATECHISMS,
  $, $$,
  Store, Sound, Corporate, Field, Interstitial,
} from "./core.js";
import { Console, WaffleParty, Reveals } from "./sudoku.js";
import { RefinementFloor } from "./floor.js";

/* ---- Terminal (intake command line) ---- */
const Terminal = (function () {
  let input, log;

  const REJECTIONS = [
    "Input not recognized. Please refrain from disorderly entry.",
    "That command serves no quota. Try again.",
    "Unrecognized directive. The work is mysterious and important.",
    "Lumon does not acknowledge that request.",
  ];

  function write(text, cls = "t-sys") {
    const div = document.createElement("div");
    div.className = cls;
    div.textContent = text;
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
  }

  // Easter-egg payloads (Phase 2). Each feels discovered, not announced —
  // a terse terminal line plus a visual reveal handled by the Reveals module.
  const EGGS = {
    KIER: () => {
      write("ACCESSING FOUNDER RECORD...", "t-sys");
      setTimeout(() => Reveals.kier(), 450);
    },
    HELLY: () => {
      write("...", "t-sys");
      setTimeout(() => Reveals.helly(), 350);
    },
    MARK: () => {
      write("MARK S. — Macrodata Refinement.", "t-ok");
      setTimeout(() => Reveals.mark(), 350);
    },
    WAFFLE: () => {
      write("SPECIAL INCENTIVE PROTOCOL ENGAGED.", "t-ok");
      Store.set({ waffleUnlocked: true });
      setTimeout(() => WaffleParty.open(), 400);
    },
    "4 8 15 16 23 42": () => {
      write("SEQUENCE ACCEPTED.", "t-ok");
      setTimeout(() => Reveals.hatch(), 350);
    },
  };

  function route(raw) {
    const cmd = raw.trim().toUpperCase().replace(/\s+/g, " ");
    if (!cmd) return;
    Sound.ensure(); // unlock audio on first user gesture
    write("> " + cmd, "t-cmd");

    switch (cmd) {
      case "HELP":
        write("DIRECTIVES: BEGIN · REFINE · CLEAR · HELP", "t-sys");
        write("Some words carry meaning. Lumon watches.", "t-sys");
        return;
      case "CLEAR":
        log.innerHTML = "";
        return;
      case "BEGIN":
      case "REFINE":
        write("Initiating refinement protocol...", "t-ok");
        Sound.ok();
        setTimeout(() => App.goConsole(), 500);
        return;
    }

    if (EGGS[cmd]) { EGGS[cmd](); return; }

    write(REJECTIONS[Math.floor(Math.random() * REJECTIONS.length)], "t-err");
    Sound.err();
  }

  function init() {
    input = $("#terminal-input");
    log = $("#terminal-log");
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { route(input.value); input.value = ""; }
    });
    write("LUMON terminal ready. Type HELP.", "t-sys");
  }

  return { init, route, write };
})();

/* ---- App (screen state machine + wiring) ---- */
const App = (function () {
  let catechismTimer = null;

  function setTemper(t) {
    Store.set({ temper: t });
    $$(".temper__tile").forEach((tile) => {
      const active = tile.dataset.temper === t;
      tile.classList.toggle("temper__tile--active", active);
      tile.setAttribute("aria-checked", active ? "true" : "false");
    });
  }

  function rotateCatechism() {
    const el = $("#catechism");
    let i = Math.floor(Math.random() * CATECHISMS.length);
    el.textContent = "\u201C" + CATECHISMS[i] + "\u201D";
    function next() {
      el.style.opacity = "0";
      setTimeout(() => {
        i = (i + 1) % CATECHISMS.length;
        el.textContent = "\u201C" + CATECHISMS[i] + "\u201D";
        el.style.opacity = "1";
      }, 700);
    }
    clearInterval(catechismTimer);
    catechismTimer = setInterval(next, 8000);
  }

  function goConsole() {
    const intake = $("#screen-intake"), con = $("#screen-console");
    // brief "FILE ACCEPTED" interstitial beat
    Interstitial.show("FILE ACCEPTED");
    intake.classList.remove("screen--active");
    setTimeout(() => {
      intake.hidden = true;
      con.hidden = false;
      Field.stop();
      void con.offsetWidth;
      con.classList.add("screen--active");
      Store.set({ screen: "console" });
      Sound.refreshHum();
      Corporate.resetIdle();

      // resume in-progress file or generate a fresh one
      const s = Store.all();
      if (s.progress && s.solution && s.givenMask) Console.restore(s);
      else Console.newPuzzle(Store.get("temper"));
    }, 850);
  }

  function goIntake() {
    const intake = $("#screen-intake"), con = $("#screen-console");
    if (Console.isEditing && Console.isEditing()) Console.cancelEdit();
    con.classList.remove("screen--active");
    Corporate.stopIdle();
    setTimeout(() => {
      con.hidden = true;
      intake.hidden = false;
      void intake.offsetWidth;
      intake.classList.add("screen--active");
      Field.start();
      Store.set({ screen: "intake" });
    }, 500);
  }

  /* Phase 4: enter / leave the standalone Refinement Floor mini-game. */
  function goFloor() {
    const intake = $("#screen-intake"), floor = $("#screen-floor");
    Interstitial.show("FILE ACCEPTED");
    intake.classList.remove("screen--active");
    setTimeout(() => {
      intake.hidden = true;
      floor.hidden = false;
      Field.stop();
      void floor.offsetWidth;
      floor.classList.add("screen--active");
      Store.set({ screen: "floor" });
      Sound.refreshHum();
      RefinementFloor.init();
      RefinementFloor.start();
    }, 850);
  }

  function goFloorBack() {
    const intake = $("#screen-intake"), floor = $("#screen-floor");
    floor.classList.remove("screen--active");
    RefinementFloor.stop();
    setTimeout(() => {
      floor.hidden = true;
      intake.hidden = false;
      void intake.offsetWidth;
      intake.classList.add("screen--active");
      Field.start();
      Store.set({ screen: "intake" });
    }, 500);
  }

  /* About — a static read-only screen hosted in the shared CRT monitor. */
  function goAbout() {
    const intake = $("#screen-intake"), about = $("#screen-about");
    intake.classList.remove("screen--active");
    setTimeout(() => {
      intake.hidden = true;
      about.hidden = false;
      Field.stop();
      void about.offsetWidth;
      about.classList.add("screen--active");
      Store.set({ screen: "about" });
    }, 450);
  }

  function goAboutBack() {
    const intake = $("#screen-intake"), about = $("#screen-about");
    about.classList.remove("screen--active");
    setTimeout(() => {
      about.hidden = true;
      intake.hidden = false;
      void intake.offsetWidth;
      intake.classList.add("screen--active");
      Field.start();
      Store.set({ screen: "intake" });
    }, 450);
  }

  /* Audio is a single three-mode cycle shared by both control buttons:
       0 sound on        muted:false ambient:false
       1 sound+ambient   muted:false ambient:true
       2 sound off       muted:true  ambient:false
     Clicking advances 0 → 1 → 2 → 0. */
  function audioMode() {
    if (Store.get("muted")) return 2;
    return Store.get("ambient") ? 1 : 0;
  }
  function applyAudioBtn(btn) {
    if (!btn) return;
    const mode = audioMode();
    const glyph = btn.querySelector(".ctrlbtn__glyph");
    btn.classList.toggle("is-muted", mode === 2);
    btn.classList.toggle("is-ambient", mode === 1);
    if (mode === 2) { if (glyph) glyph.textContent = "♪"; btn.title = "SOUND OFF"; }
    else if (mode === 1) { if (glyph) glyph.textContent = "♪"; btn.title = "AMBEENT ON"; }
    else { if (glyph) glyph.textContent = "♪"; btn.title = "SOUND ON"; }
  }
  function syncAudioBtns() {
    applyAudioBtn($("#mute-btn"));
    applyAudioBtn($("#floor-mute-btn"));
  }
  function cycleAudio() {
    const next = (audioMode() + 1) % 3;
    if (next === 0) Store.set({ muted: false, ambient: false });
    else if (next === 1) Store.set({ muted: false, ambient: true });
    else Store.set({ muted: true, ambient: false });
    Sound.ensure();
    Sound.refreshHum();
    syncAudioBtns();
  }

  function tickClock() {
    const els = ["#intake-clock", "#console-clock", "#floor-clock", "#about-clock"]
      .map((s) => $(s)).filter(Boolean);
    function upd() {
      const d = new Date();
      const t = [d.getHours(), d.getMinutes(), d.getSeconds()]
        .map((x) => String(x).padStart(2, "0")).join(":");
      els.forEach((el) => { el.textContent = t; });
    }
    upd(); setInterval(upd, 1000);
  }

  /* Shared hex readout — the paired 0x…… code now lives in every CRT footer.
     It flickers on all three pages the way the Floor's always has. (The Floor
     screen keeps its own internal ticker while it's running; this drives the
     intake + console footers, and seeds all three.) */
  function rndHex(n) {
    let s = "";
    for (let k = 0; k < n; k++) s += "0123456789ABCDEF"[(Math.random() * 16) | 0];
    return s;
  }
  function tickHexFooters() {
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    // intake + console only; the Floor screen runs its own hex ticker while active
    const pairs = [
      ["#intake-hex-a", "#intake-hex-b"],
      ["#console-hex-a", "#console-hex-b"],
      ["#about-hex-a", "#about-hex-b"],
    ];
    function seed() {
      // seed all footers so none is blank before its screen is shown
      [...pairs, ["#floor-hex-a", "#floor-hex-b"]].forEach(([a, b]) => {
        const ea = $(a), eb = $(b);
        if (ea) ea.textContent = "0x" + rndHex(6);
        if (eb) eb.textContent = "0x" + rndHex(6);
      });
    }
    seed();
    if (reduced) return;
    setInterval(() => {
      // flicker one random side of one visible footer per tick
      const visible = pairs.filter(([a]) => {
        const el = $(a); return el && el.offsetParent !== null;
      });
      if (!visible.length) return;
      const [a, b] = visible[(Math.random() * visible.length) | 0];
      const which = Math.random() < 0.5 ? a : b;
      const el = $(which);
      if (el) el.textContent = "0x" + rndHex(6);
    }, 2600);
  }

  function keyboard(e) {
    // grid keyboard only when console is active
    if ($("#screen-console").hidden) return;
    const tag = document.activeElement && document.activeElement.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") return;

    if (e.key === "ArrowUp")    { Console.move(-1, 0); e.preventDefault(); }
    else if (e.key === "ArrowDown")  { Console.move(1, 0); e.preventDefault(); }
    else if (e.key === "ArrowLeft")  { Console.move(0, -1); e.preventDefault(); }
    else if (e.key === "ArrowRight") { Console.move(0, 1); e.preventDefault(); }
    else if (/^[1-9]$/.test(e.key)) { Console.enter(Number(e.key)); }
    else if (e.key === "0" || e.key === "Backspace" || e.key === "Delete") { Console.enter(0); }
  }

  /* ---- wide, real, moving terminal caret ----
     Modern browsers honour `caret-shape: block` (set in CSS). For the wide,
     glowing block that tracks the true insertion point everywhere, we render
     a synthetic caret positioned via a hidden text-mirror, and hide the
     native caret. It moves exactly with typing/selection because it's
     measured from the input's real selectionStart. */
  function enhanceTerminalCaret() {
    const input = $("#terminal-input");
    if (!input) return;
    const line = input.closest(".terminal__inputline");
    if (!line) return;

    const mirror = document.createElement("span");
    mirror.className = "terminal__measure";
    mirror.setAttribute("aria-hidden", "true");
    Object.assign(mirror.style, {
      position: "absolute", visibility: "hidden", whiteSpace: "pre",
      pointerEvents: "none", left: "0", top: "0",
    });
    const caret = document.createElement("span");
    caret.className = "terminal__caret";
    caret.setAttribute("aria-hidden", "true");

    if (getComputedStyle(line).position === "static") line.style.position = "relative";
    line.appendChild(mirror);
    line.appendChild(caret);
    input.classList.add("has-fake-caret"); // CSS hides the native caret

    function copyFont() {
      const cs = getComputedStyle(input);
      ["fontFamily", "fontSize", "fontWeight", "letterSpacing"].forEach((p) => {
        mirror.style[p] = cs[p];
      });
    }
    function place() {
      copyFont();
      const cs = getComputedStyle(input);
      const padL = parseFloat(cs.paddingLeft) || 0;
      const val = input.value;
      const pos = input.selectionStart == null ? val.length : input.selectionStart;
      mirror.textContent = val.slice(0, pos);
      const inputRect = input.getBoundingClientRect();
      const lineRect = line.getBoundingClientRect();
      const textW = mirror.getBoundingClientRect().width;
      // block caret sits AT the insertion point (just after typed text)
      const x = (inputRect.left - lineRect.left) + padL + textW - input.scrollLeft;
      caret.style.left = x + "px";
      caret.style.top = (inputRect.top - lineRect.top) + "px";
      caret.style.height = inputRect.height + "px";
    }
    function show(on) { caret.style.display = on ? "block" : "none"; }

    ["input", "keyup", "click", "select", "scroll"].forEach((ev) =>
      input.addEventListener(ev, place));
    input.addEventListener("focus", () => { show(true); place(); });
    input.addEventListener("blur", () => show(false));
    window.addEventListener("resize", place);
    show(document.activeElement === input);
    place();
  }

  /* ---- RESET! confirmation modal ----
     Wipes all browser-saved progress + lifetime stats after the user
     explicitly confirms. Built on the shared .modal shell. */
  const ResetConfirm = (function () {
    let el = null;
    function build() {
      if (el) return el;
      el = document.createElement("div");
      el.className = "modal";
      el.id = "reset-modal";
      el.innerHTML = `
        <div class="modal__scrim" data-close="1"></div>
        <div class="modal__panel confirm__panel" role="dialog" aria-modal="true" aria-label="Reset stored data">
          <div class="confirm__title">PURGE LOCAL RECORD?</div>
          <div class="confirm__body">
            This permanently erases every value Lumon has stored in this browser —
            your in-progress file, files refined, accuracy, average time, badge,
            floor completions and unlocked incentives.<br><br>
            This action cannot be undone.
          </div>
          <div class="confirm__actions">
            <button class="btn" data-close="1" id="reset-no">NO &mdash; KEEP</button>
            <button class="btn btn--danger" id="reset-yes">YES &mdash; RESET</button>
          </div>
        </div>`;
      document.body.appendChild(el);
      el.addEventListener("click", (e) => {
        if (e.target.dataset && e.target.dataset.close) close();
      });
      el.querySelector("#reset-yes").addEventListener("click", doReset);
      return el;
    }
    function open() { build(); requestAnimationFrame(() => el.classList.add("show")); }
    function close() { if (el) el.classList.remove("show"); }
    function doReset() {
      Sound.ok && Sound.ok();
      try { localStorage.clear(); } catch (e) {}
      window.location.reload();
    }
    return { open, close };
  })();

  function init() {
    Field.init();
    Field.start();
    Terminal.init();
    Console.init();

    // temper tiles
    $$(".temper__tile").forEach((tile) => {
      tile.addEventListener("click", () => { setTemper(tile.dataset.temper); Sound.select(); });
    });
    setTemper(Store.get("temper"));

    $("#begin-btn").addEventListener("click", () => { Sound.ok(); goConsole(); });
    $("#return-btn").addEventListener("click", () => { Sound.select(); goIntake(); });

    // About — an in-CRT screen, like the Refinement Floor
    const aboutBtn = $("#about-btn");
    if (aboutBtn) aboutBtn.addEventListener("click", () => { Sound.ok(); goAbout(); });
    const aboutReturn = $("#about-return-btn");
    if (aboutReturn) aboutReturn.addEventListener("click", () => { Sound.select(); goAboutBack(); });

    // Phase 4: Refinement Floor entry + return
    const floorBtn = $("#floor-btn");
    if (floorBtn) floorBtn.addEventListener("click", () => { Sound.ok(); goFloor(); });
    const floorReturn = $("#floor-return-btn");
    if (floorReturn) floorReturn.addEventListener("click", () => { Sound.select(); goFloorBack(); });

    // both square ♪ buttons share the single three-mode audio cycle
    ["#mute-btn", "#floor-mute-btn"].forEach((sel) => {
      const b = $(sel);
      if (b) b.addEventListener("click", () => { Sound.select(); cycleAudio(); });
    });

    // RESET! — wipe saved stats after an explicit confirmation
    const resetBtn = $("#reset-btn");
    if (resetBtn) resetBtn.addEventListener("click", () => { Sound.select(); ResetConfirm.open(); });

    // wide, real, moving caret for the intake terminal
    enhanceTerminalCaret();

    // any console interaction resets the idle nudge timer
    ["pointerdown", "keydown"].forEach((ev) =>
      document.addEventListener(ev, () => {
        if (!$("#screen-console").hidden) Corporate.resetIdle();
      })
    );

    syncAudioBtns();
    rotateCatechism();
    tickClock();
    tickHexFooters();
    document.addEventListener("keydown", keyboard);

    // resume to whichever screen the session left off on
    if (Store.get("screen") === "console") {
      // jump straight in without animation flash
      $("#screen-intake").classList.remove("screen--active");
      $("#screen-intake").hidden = true;
      $("#screen-console").hidden = false;
      $("#screen-console").classList.add("screen--active");
      Field.stop();
      Corporate.resetIdle();
      const s = Store.all();
      if (s.progress && s.solution && s.givenMask) Console.restore(s);
      else Console.newPuzzle(Store.get("temper"));
    } else if (Store.get("screen") === "floor") {
      $("#screen-intake").classList.remove("screen--active");
      $("#screen-intake").hidden = true;
      $("#screen-floor").hidden = false;
      $("#screen-floor").classList.add("screen--active");
      Field.stop();
      RefinementFloor.init();
      RefinementFloor.start();
    } else if (Store.get("screen") === "about") {
      $("#screen-intake").classList.remove("screen--active");
      $("#screen-intake").hidden = true;
      $("#screen-about").hidden = false;
      $("#screen-about").classList.add("screen--active");
      Field.stop();
    }
  }

  return { init, goConsole, goIntake, goFloor, goFloorBack, goAbout, goAboutBack };
})();

// expose for Terminal routing (Terminal calls App.goConsole at runtime)
window.App = App;

document.addEventListener("DOMContentLoaded", App.init);
