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

  function updateMuteBtn() {
    const b = $("#mute-btn");
    const m = Store.get("muted");
    b.classList.toggle("is-muted", m);
    b.textContent = m ? "♪̶" : "♪";
    b.title = m ? "Sound off" : "Sound on";
  }

  function tickClock() {
    const el = $("#intake-clock");
    function upd() {
      const d = new Date();
      el.textContent = [d.getHours(), d.getMinutes(), d.getSeconds()]
        .map((x) => String(x).padStart(2, "0")).join(":");
    }
    upd(); setInterval(upd, 1000);
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
    // Phase 4: Refinement Floor entry + return + its own mute toggle
    const floorBtn = $("#floor-btn");
    if (floorBtn) floorBtn.addEventListener("click", () => { Sound.ok(); goFloor(); });
    const floorReturn = $("#floor-return-btn");
    if (floorReturn) floorReturn.addEventListener("click", () => { Sound.select(); goFloorBack(); });
    const floorMute = $("#floor-mute-btn");
    if (floorMute) {
      const syncFloorMute = () => {
        const m = Store.get("muted");
        floorMute.classList.toggle("is-muted", m);
        floorMute.textContent = m ? "♪̶" : "♪";
      };
      floorMute.addEventListener("click", () => {
        Store.set({ muted: !Store.get("muted") });
        updateMuteBtn(); syncFloorMute(); Sound.refreshHum();
      });
      syncFloorMute();
    }
    $("#mute-btn").addEventListener("click", () => {
      Store.set({ muted: !Store.get("muted") });
      updateMuteBtn();
      Sound.refreshHum();
    });
    const ambBtn = $("#ambient-btn");
    if (ambBtn) {
      ambBtn.addEventListener("click", () => {
        Store.set({ ambient: !Store.get("ambient") });
        Sound.ensure();
        Sound.refreshHum();
        ambBtn.classList.toggle("is-on", Store.get("ambient"));
      });
      ambBtn.classList.toggle("is-on", Store.get("ambient"));
    }

    // any console interaction resets the idle nudge timer
    ["pointerdown", "keydown"].forEach((ev) =>
      document.addEventListener(ev, () => {
        if (!$("#screen-console").hidden) Corporate.resetIdle();
      })
    );

    updateMuteBtn();
    rotateCatechism();
    tickClock();
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
    }
  }

  return { init, goConsole, goIntake, goFloor, goFloorBack };
})();

// expose for Terminal routing (Terminal calls App.goConsole at runtime)
window.App = App;

document.addEventListener("DOMContentLoaded", App.init);
