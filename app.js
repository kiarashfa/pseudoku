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
  CATECHISMS, TEMPERS,
  $, $$, fmtTime,
  Store, Sound, Corporate, Field, Interstitial,
  getEmployeeId, randomFileCode, setDisplayName, getDisplayName,
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

  // Navigation directives map onto the existing intake buttons and route
  // through the App state machine. Synonyms share a destination.
  function nav(label, fn) {
    write("Initiating refinement protocol...", "t-ok");
    Sound.ok();
    setTimeout(fn, 500);
  }

  // --- Useful / characterful readouts (printed to the terminal log) ---
  function stats() {
    const s = Store.all();
    const files = s.filesRefined | 0;
    const avg = files > 0 ? fmtTime(Math.round(s.totalTimeMs / files)) : "--:--";
    const floor = s.floorFilesComplete | 0;
    write("— PERFORMANCE RECORD —", "t-sys");
    write("Files refined ....... " + files, "t-sys");
    write("Average refine time . " + avg, "t-sys");
    write("Floor files complete  " + floor, "t-sys");
    write("Active temper ....... " + (TEMPERS[s.temper] ? TEMPERS[s.temper].label : "—"), "t-sys");
    write("Your numbers please Kier. Industry is the truest devotion.", "t-sys");
  }

  function quota() {
    const t = TEMPERS[Store.get("temper")] || { label: "—", clues: 0 };
    const d = new Date();
    const clock = [d.getHours(), d.getMinutes(), d.getSeconds()]
      .map((x) => String(x).padStart(2, "0")).join(":");
    write("CURRENT TEMPER: " + t.label + " · CLUE ALLOCATION: " + t.clues, "t-sys");
    write("DEPARTMENT TIME: " + clock + ". Your file remains unrefined.", "t-sys");
  }

  function whoami() {
    const name = getDisplayName();
    if (name) write("NAME: " + name, "t-ok");
    write("EMPLOYEE: " + getEmployeeId(), "t-ok");
    write("DEPARTMENT: Macrodata Refinement.", "t-sys");
    if (!name) write("No name on file. Register with: NAME <your name>", "t-sys");
    write("You are an extraordinary and beloved member of the Lumon family.", "t-sys");
  }

  // Register / read the optional self-identified name. Takes the RAW argument
  // (not upper-cased) so the user's own capitalization survives.
  function name(rawArg) {
    const arg = (rawArg || "").trim();
    if (!arg) {
      const cur = getDisplayName();
      if (cur) {
        write("IDENTITY ON FILE: " + cur + " · " + getEmployeeId(), "t-ok");
        write("To revise: NAME <your name>. To erase: NAME --clear", "t-sys");
      } else {
        write("NO NAME ON FILE. Register with: NAME <your name>", "t-sys");
        write("Your badge remains " + getEmployeeId() + ". A name is optional but seen.", "t-sys");
      }
      return;
    }
    if (/^--?clear$/i.test(arg)) {
      setDisplayName("");
      write("IDENTITY EXPUNGED. You are once more only " + getEmployeeId() + ".", "t-ok");
      Sound.ok();
      return;
    }
    const saved = setDisplayName(arg);
    if (!saved) { write("Name not recognized. Please refrain from disorderly entry.", "t-err"); Sound.err(); return; }
    write("IDENTITY REGISTERED: " + saved + " · " + getEmployeeId(), "t-ok");
    write("Kier sees you, " + saved + ". Your certificates now bear your name.", "t-sys");
    Sound.ok();
  }

  function file() {
    write("FILE ASSIGNED: " + randomFileCode(), "t-ok");
    write("The numbers are frightening. Refine them anyway.", "t-sys");
  }

  function catechism() {
    const c = CATECHISMS[Math.floor(Math.random() * CATECHISMS.length)];
    write("\u201C" + c + "\u201D — Kier Eagan", "t-sys");
  }

  function route(raw) {
    const cmd = raw.trim().toUpperCase().replace(/\s+/g, " ");
    if (!cmd) return;
    Sound.ensure(); // unlock audio on first user gesture
    write("> " + cmd, "t-cmd");

    // NAME / IDENTIFY take a free-text argument whose casing must survive, so
    // they are handled from the RAW string rather than the upper-cased command.
    const nameMatch = raw.trim().match(/^(?:NAME|IDENTIFY)\b\s*([\s\S]*)$/i);
    if (nameMatch) { name(nameMatch[1]); return; }

    switch (cmd) {
      case "HELP":
        write("DIRECTIVES:", "t-sys");
        write("  BEGIN / CONSOLE / SOLVER — open the data console", "t-sys");
        write("  FLOOR / REFINE — enter the Refinement Floor", "t-sys");
        write("  ABOUT — department disclosure", "t-sys");
        write("  STATS — your performance record", "t-sys");
        write("  QUOTA / TIME — current temper and department time", "t-sys");
        write("  WHO AM I — employee identification", "t-sys");
        write("  NAME <your name> — register your identity for certificates", "t-sys");
        write("  FILE — receive a fresh file designation", "t-sys");
        write("  CATECHISM — a word from Kier", "t-sys");
        write("  CLEAR — purge the log · HELP — this list", "t-sys");
        write(" ");
        write("Some words carry meaning. Lumon watches.", "t-sys");
        return;
      case "CLEAR":
        log.innerHTML = "";
        return;
      case "BEGIN":
      case "CONSOLE":
      case "SOLVER":
        nav(cmd, () => App.goConsole());
        return;
      case "FLOOR":
      case "REFINE":
        nav(cmd, () => App.goFloor());
        return;
      case "ABOUT":
        nav(cmd, () => App.goAbout());
        return;
      case "STATS":
        stats();
        return;
      case "QUOTA":
      case "TIME":
        quota();
        return;
      case "WHO AM I":
      case "WHOAMI":
        whoami();
        return;
      case "FILE":
        file();
        return;
      case "CATECHISM":
        catechism();
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

      Fit.apply(); // re-fit now that the grid + toolbar are laid out
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
      Fit.apply();
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
      Fit.apply();
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
      Fit.apply();
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
      Fit.apply();
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
      Fit.apply();
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

  /* ---- Fit scaler ----
     The shared CRT now takes a fixed, pleasing shape from the viewport (see
     .crt in style.css). Each screen's readout lives in a .crt__fit layer that
     is laid out at its NATURAL size; this routine measures that natural box
     against the available .crt__inner box and, only when the content would
     overflow, sets a --fit-scale < 1 so the whole readout shrinks uniformly.
     No overflow ⇒ no stray scrollbars. We never scale UP, so a roomy viewport
     is pixel-identical to the original design.

       data-fit="scale"  intake, console  → measure + shrink
       data-fit="scroll" about            → no transform; .about-body scrolls
       data-fit="none"   floor            → no transform; fluid canvas adapts

     Exposes Fit.apply() so screen transitions can re-fit after a screen shows,
     (it also re-runs the terminal caret placement after a scale change). */
  let _caretPlace = null; // set by enhanceTerminalCaret so Fit can re-run it
  const Fit = (function () {
    let raf = 0;

    function fitOne(fit) {
      const mode = fit.getAttribute("data-fit");
      if (mode === "scroll" || mode === "none") return; // opt-outs
      const inner = fit.parentElement; // .crt__inner (the available box)
      if (!inner) return;

      // measure at natural layout: reset our contribution first
      fit.style.setProperty("--fit-scale", "1");

      // available box = inner content box minus its padding
      const cs = getComputedStyle(inner);
      const padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
      const padY = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
      const availW = inner.clientWidth - padX;
      const availH = inner.clientHeight - padY;
      if (availW <= 0 || availH <= 0) return;

      // natural content size (transform doesn't affect scroll size, so this is
      // the true laid-out extent regardless of the current --fit-scale)
      const natW = fit.scrollWidth;
      const natH = fit.scrollHeight;
      if (natW <= 0 || natH <= 0) return;

      // shrink-only fit; the 1.012 bezel "bulge" lives in the CSS calc()
      const s = Math.min(1, availW / natW, availH / natH);
      fit.style.setProperty("--fit-scale", String(s));
    }

    function apply() {
      const screen = document.querySelector(".screen--active");
      if (!screen) return;
      const fits = screen.querySelectorAll(".crt__fit");
      fits.forEach(fitOne);
      // keep the synthetic terminal caret aligned after a re-scale
      if (typeof _caretPlace === "function") _caretPlace();
    }

    function schedule() {
      if (raf) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => { raf = 0; apply(); });
    }

    function init() {
      window.addEventListener("resize", schedule, { passive: true });
      window.addEventListener("orientationchange", schedule, { passive: true });
      // re-fit when fonts finish loading (metrics shift the natural height)
      if (document.fonts && document.fonts.ready) {
        document.fonts.ready.then(schedule).catch(() => {});
      }
      // Re-fit on internal reflows (console toolbar row swap on edit, grid
      // rebuilds, etc.). The fit layer is stretched to fill its box, so a
      // ResizeObserver on it can't see content-only changes — a subtree
      // MutationObserver can. It's debounced through schedule()/rAF, and our
      // own writes are limited to a CSS custom property on .crt__fit, which we
      // exclude from the attribute filter to avoid self-triggering.
      if (typeof MutationObserver === "function") {
        const mo = new MutationObserver(schedule);
        document.querySelectorAll(".crt__fit").forEach((el) =>
          mo.observe(el, {
            subtree: true, childList: true,
            attributes: true,
            attributeFilter: ["class", "hidden", "value"],
          })
        );
        // body.is-editing (console authoring) lives outside the fit subtree and
        // swaps toolbar rows via display, changing natural height — watch it.
        mo.observe(document.body, { attributes: true, attributeFilter: ["class"] });
      }
      schedule();
    }

    return { init, apply, schedule };
  })();

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
    _caretPlace = place; // let the Fit scaler re-align the caret after a re-scale
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
          <div class="confirm__title">SEVER THIS RECORD?</div>
          <div class="confirm__body">
            You are about to expunge the entirety of your tenure as Lumon has
            chosen to remember it — your active file, every file refined, your
            measured accuracy, your refinement times, your assigned badge, your
            floor completions, and any incentives you were graciously permitted
            to earn.<br><br>
            What is forgotten cannot be reinstated. Kier does not recover what
            you discard. Be certain your remorse will outlast your curiosity.
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

    // PROTOCOLS drawer — a mobile-only collapsible tray holding the management
    // actions + custom intake. On desktop the toggle is hidden via CSS and the
    // drawer is always shown, so this wiring is harmless there. The open state
    // is a CSS class (.is-open) that animates grid-template-rows 0fr→1fr, which
    // pushes the temper + stats down (no scaling) and rolls back on close.
    (function wireDrawer() {
      const toggle = $("#drawer-toggle");
      const drawer = $("#protocol-drawer");
      if (!toggle || !drawer) return;
      function setOpen(open) {
        drawer.classList.toggle("is-open", open);
        toggle.setAttribute("aria-expanded", open ? "true" : "false");
      }
      toggle.addEventListener("click", () => {
        Sound.select();
        setOpen(!drawer.classList.contains("is-open"));
      });
      // Authoring (ENTER MANUALLY → body.is-editing) needs the drawer open so
      // SET PUZZLE / CANCEL are reachable; force it open while editing.
      if (typeof MutationObserver === "function") {
        new MutationObserver(() => {
          if (document.body.classList.contains("is-editing") &&
              !drawer.classList.contains("is-open")) {
            setOpen(true);
          }
        }).observe(document.body, { attributes: true, attributeFilter: ["class"] });
      }
    })();

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
    Fit.init();
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

    // fit whichever screen ended up active (resume path or default intake)
    Fit.apply();
  }

  return { init, goConsole, goIntake, goFloor, goFloorBack, goAbout, goAboutBack };
})();

// expose for Terminal routing (Terminal calls App.goConsole at runtime)
window.App = App;

document.addEventListener("DOMContentLoaded", App.init);
