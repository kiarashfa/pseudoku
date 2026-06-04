/* ============================================================
   ocr.js — OpticalIntake: the photo → puzzle pipeline (Phase 3).
   Lazy-loads OpenCV.js + Tesseract.js on first use, runs grid
   detection / cell segmentation / digit recognition in-browser,
   then a human-review step before handing the result to Console.

   NOTE: ocr.js and sudoku.js reference each other (Console wires
   the scan button; OpticalIntake hands its result to
   Console.loadFromString). Both references run at call-time
   inside functions, so this ES-module cycle resolves cleanly.
   ============================================================ */
import {
  $, toast,
  SudokuEngine, Store, Sound, Corporate, Interstitial,
} from "./core.js";
import { Console } from "./sudoku.js";

export const OpticalIntake = (function () {

  /* ---- CDN sources (loaded on the client, never server-side) ---- */
  const OPENCV_SRC = "https://docs.opencv.org/4.9.0/opencv.js";
  const TESS_SRC   = "https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js";

  /* ---- module state ---- */
  let modalEl = null;
  let assetsReady = false;       // libraries loaded this session
  let busy = false;              // a scan is mid-flight
  let cvLoading = null;          // de-dupe concurrent loads
  let tessWorker = null;         // reused Tesseract worker
  let reviewState = null;        // { values:Int[81], conf:Float[81], warpURL }
  let reviewSel = -1;            // selected cell in review grid
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* =====================================================
     MODAL SHELL  (reuses the generic .modal styling)
     ===================================================== */
  function build() {
    if (modalEl) return;
    const el = document.createElement("div");
    el.id = "optical-modal";
    el.className = "modal optical";
    el.innerHTML = `
      <div class="modal__scrim" data-close="1"></div>
      <div class="modal__panel optical__panel" role="dialog" aria-modal="true" aria-label="Optical Intake">
        <button class="modal__x" data-close="1" aria-label="Close">✕</button>
        <div class="optical__head">OPTICS &amp; DESIGN INTAKE</div>
        <div class="optical__dept">IMPORT EXTERNAL DATA ARTIFACT</div>
        <div class="optical__stage" id="optical-stage"><!-- swapped per phase --></div>
      </div>`;
    document.body.appendChild(el);
    el.addEventListener("click", (e) => { if (e.target.dataset.close) close(); });
    modalEl = el;
  }

  function stage() { return document.getElementById("optical-stage"); }

  function open() {
    build();
    reviewState = null; reviewSel = -1;
    modalEl.classList.add("show");
    Sound.chime && Sound.chime();
    renderDropStage();
  }

  function close() {
    if (!modalEl) return;
    modalEl.classList.remove("show");
    // free any object URLs we created for previews
    if (reviewState && reviewState.warpURL) {
      try { URL.revokeObjectURL(reviewState.warpURL); } catch (e) {}
    }
  }

  /* =====================================================
     STAGE 1 — INTAKE DROP ZONE
     file picker + camera capture + drag-and-drop
     ===================================================== */
  function renderDropStage() {
    stage().innerHTML = `
      <div class="optical__drop" id="optical-drop" tabindex="0"
           role="button" aria-label="Submit image artifact">
        <div class="optical__drop-mark" aria-hidden="true">
          <svg viewBox="0 0 64 64" width="56" height="56">
            <rect x="8" y="8" width="48" height="48" fill="none"
                  stroke="currentColor" stroke-width="1.4" opacity=".6"/>
            <line x1="8"  y1="24" x2="56" y2="24" stroke="currentColor" stroke-width="1" opacity=".4"/>
            <line x1="8"  y1="40" x2="56" y2="40" stroke="currentColor" stroke-width="1" opacity=".4"/>
            <line x1="24" y1="8"  x2="24" y2="56" stroke="currentColor" stroke-width="1" opacity=".4"/>
            <line x1="40" y1="8"  x2="40" y2="56" stroke="currentColor" stroke-width="1" opacity=".4"/>
            <circle cx="32" cy="32" r="3" fill="currentColor"/>
          </svg>
        </div>
        <div class="optical__drop-title">SUBMIT FILE ARTIFACT</div>
        <div class="optical__drop-sub">Drag an image here, or use the controls below.<br>
          A clear, flat photo of a printed 9×9 grid refines best.</div>
      </div>
      <div class="optical__controls">
        <button class="btn btn--primary btn--sm" id="optical-choose">CHOOSE IMAGE</button>
        <button class="btn btn--sm" id="optical-camera">USE CAMERA</button>
      </div>
      <input id="optical-file"   type="file" accept="image/*" hidden />
      <input id="optical-camcap" type="file" accept="image/*" capture="environment" hidden />
      <div class="optical__note">All processing occurs on this device. Your image is never transmitted.</div>
    `;

    const fileInput = document.getElementById("optical-file");
    const camInput  = document.getElementById("optical-camcap");
    const drop      = document.getElementById("optical-drop");

    document.getElementById("optical-choose").addEventListener("click", () => {
      Sound.key && Sound.key(); fileInput.click();
    });
    document.getElementById("optical-camera").addEventListener("click", () => {
      Sound.key && Sound.key(); camInput.click();
    });
    fileInput.addEventListener("change", (e) => handleFile(e.target.files[0]));
    camInput .addEventListener("change", (e) => handleFile(e.target.files[0]));

    // drag-and-drop
    ["dragenter", "dragover"].forEach((ev) =>
      drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("is-over"); }));
    ["dragleave", "dragend"].forEach((ev) =>
      drop.addEventListener(ev, () => drop.classList.remove("is-over")));
    drop.addEventListener("drop", (e) => {
      e.preventDefault(); drop.classList.remove("is-over");
      const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) handleFile(f);
    });
    drop.addEventListener("click", () => { Sound.select && Sound.select(); fileInput.click(); });
    drop.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fileInput.click(); }
    });
  }

  function handleFile(file) {
    if (!file) return;
    if (!/^image\//.test(file.type)) {
      corporateError("ARTIFACT FORMAT NOT RECOGNIZED. SUBMIT AN IMAGE FILE.");
      return;
    }
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); beginProcessing(img); };
    img.onerror = () => { URL.revokeObjectURL(url);
      corporateError("ARTIFACT COULD NOT BE READ. RESUBMIT."); };
    img.src = url;
  }

  /* =====================================================
     STAGE — WORKING / PROGRESS PANEL
     ===================================================== */
  function renderWorking(label) {
    stage().innerHTML = `
      <div class="optical__work">
        <div class="optical__spinner" aria-hidden="true">
          <span></span><span></span><span></span>
        </div>
        <div class="optical__work-label" id="optical-work-label">${label}</div>
        <div class="optical__work-bar"><div class="optical__work-fill" id="optical-work-fill"></div></div>
        <div class="optical__work-sub" id="optical-work-sub"></div>
      </div>`;
  }
  function setWork(label, pct, sub) {
    const l = document.getElementById("optical-work-label");
    const f = document.getElementById("optical-work-fill");
    const s = document.getElementById("optical-work-sub");
    if (l && label != null) l.textContent = label;
    if (f && pct != null) f.style.width = Math.max(0, Math.min(100, pct)) + "%";
    if (s && sub != null) s.textContent = sub;
  }

  /* =====================================================
     LAZY ASSET LOADING  (OpenCV.js + Tesseract.js)
     ===================================================== */
  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = src; s.async = true;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error("load failed: " + src));
      document.head.appendChild(s);
    });
  }

  function loadOpenCV() {
    if (window.cv && window.cv.Mat) return Promise.resolve();
    if (cvLoading) return cvLoading;
    cvLoading = new Promise((resolve, reject) => {
      loadScript(OPENCV_SRC).then(() => {
        // OpenCV.js signals readiness via onRuntimeInitialized (WASM compile)
        const ready = () => resolve();
        if (window.cv && window.cv.Mat) return ready();
        if (window.cv) {
          // cv may be a module object whose runtime is still compiling
          window.cv.onRuntimeInitialized = ready;
          // safety: poll in case the callback was already consumed
          let tries = 0;
          const iv = setInterval(() => {
            if (window.cv && window.cv.Mat) { clearInterval(iv); ready(); }
            else if (++tries > 200) { clearInterval(iv); reject(new Error("opencv timeout")); }
          }, 100);
        } else reject(new Error("cv missing after load"));
      }).catch(reject);
    });
    return cvLoading;
  }

  function loadTesseract() {
    if (window.Tesseract) return Promise.resolve();
    return loadScript(TESS_SRC);
  }

  async function ensureAssets() {
    if (assetsReady) return true;
    renderWorking("AUTHORIZING OPTICAL INTAKE...");
    setWork(null, 8, "Requesting optical clearance.");
    try {
      await loadOpenCV();
      setWork(null, 55, "Optical core authorized.");
      await loadTesseract();
      setWork(null, 80, "Numeric reader authorized.");
      // warm a reusable Tesseract worker tuned for single digits
      await ensureWorker();
      setWork(null, 100, "Clearance granted.");
      assetsReady = true;
      return true;
    } catch (e) {
      return false;
    }
  }

  async function ensureWorker() {
    if (tessWorker) return tessWorker;
    // Tesseract 5 worker API
    tessWorker = await window.Tesseract.createWorker("eng", 1, {
      // keep quiet; no logger spam
    });
    await tessWorker.setParameters({
      tessedit_char_whitelist: "123456789",
      tessedit_pageseg_mode: "10", // PSM 10 = single character
      classify_bln_numeric_mode: "1",
    });
    return tessWorker;
  }

  /* =====================================================
     STAGE 2 — EXTRACT NUMERIC CONTENT
     ===================================================== */
  async function beginProcessing(img) {
    if (busy) return;
    busy = true;
    const ok = await ensureAssets();
    if (!ok) {
      busy = false;
      libraryFailure();
      return;
    }
    renderWorking("EXTRACTING NUMERIC CONTENT...");
    // allow the working panel to paint before heavy sync CV work
    await raf2();

    let warp = null, cellRects = null;
    try {
      setWork(null, 15, "Locating refinable structure.");
      const detected = detectAndWarp(img); // { warpMat, sideLen }
      if (!detected) {
        busy = false;
        corporateError("NO REFINABLE STRUCTURE DETECTED. RESUBMIT ARTIFACT.");
        return;
      }
      warp = detected.warpMat;
      await raf2();
      setWork(null, 35, "Segmenting 81 cells.");
      const seg = segmentCells(warp, detected.sideLen); // { canvases[81], ink[81] }
      await raf2();

      setWork("EXTRACTING NUMERIC CONTENT...", 45, "Reading numerals.");
      const { values, conf } = await Recognizer.classifyCells(seg, (done) => {
        setWork(null, 45 + Math.round((done / 81) * 50), "Reading numerals (" + done + "/81).");
      });

      // build a warped preview for the review comparison
      const warpURL = matToObjectURL(warp);

      // tidy native memory
      warp.delete();

      reviewState = { values, conf, warpURL };
      busy = false;
      setWork("VERIFYING COMPLIANCE...", 100, "Numeric content extracted.");
      await wait(420);
      renderReview();
    } catch (err) {
      busy = false;
      if (warp && warp.delete) { try { warp.delete(); } catch (e) {} }
      corporateError("OPTICAL INTAKE FAULTED. RESUBMIT ARTIFACT OR ENTER MANUALLY.");
    }
  }

  /* ---- OpenCV: detect largest quad + perspective warp ---- */
  function detectAndWarp(img) {
    const cv = window.cv;
    // cap working resolution for speed/memory on phones
    const MAXD = 1000;
    const scale = Math.min(1, MAXD / Math.max(img.width, img.height));
    const w = Math.round(img.width * scale), h = Math.round(img.height * scale);

    const cnv = document.createElement("canvas");
    cnv.width = w; cnv.height = h;
    cnv.getContext("2d").drawImage(img, 0, 0, w, h);

    const src = cv.imread(cnv);
    const gray = new cv.Mat(), blur = new cv.Mat(), thr = new cv.Mat();
    const contours = new cv.MatVector(), hier = new cv.Mat();
    let warpMat = null;

    try {
      cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
      cv.GaussianBlur(gray, blur, new cv.Size(5, 5), 0);
      cv.adaptiveThreshold(blur, thr, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C,
        cv.THRESH_BINARY_INV, 11, 2);
      // close gaps so the grid border is one contour
      const k = cv.Mat.ones(3, 3, cv.CV_8U);
      cv.dilate(thr, thr, k); k.delete();

      cv.findContours(thr, contours, hier, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

      // pick the largest 4-corner-ish contour by area
      let best = null, bestArea = 0;
      const imgArea = w * h;
      for (let i = 0; i < contours.size(); i++) {
        const c = contours.get(i);
        const area = cv.contourArea(c);
        if (area > imgArea * 0.12 && area > bestArea) {
          const peri = cv.arcLength(c, true);
          const approx = new cv.Mat();
          cv.approxPolyDP(c, approx, 0.02 * peri, true);
          if (approx.rows === 4 && cv.isContourConvex(approx)) {
            if (best) best.delete();
            best = approx; bestArea = area;
          } else approx.delete();
        }
        c.delete();
      }
      if (!best) return null;

      const corners = orderCorners(best);
      best.delete();

      // side length from corner geometry
      const side = Math.round(Math.max(
        dist(corners[0], corners[1]), dist(corners[1], corners[2]),
        dist(corners[2], corners[3]), dist(corners[3], corners[0])
      ));
      const S = Math.max(270, Math.min(900, side)); // clamp for sane cells

      const srcTri = cv.matFromArray(4, 1, cv.CV_32FC2, [
        corners[0].x, corners[0].y, corners[1].x, corners[1].y,
        corners[2].x, corners[2].y, corners[3].x, corners[3].y,
      ]);
      const dstTri = cv.matFromArray(4, 1, cv.CV_32FC2, [
        0, 0, S, 0, S, S, 0, S,
      ]);
      const M = cv.getPerspectiveTransform(srcTri, dstTri);
      warpMat = new cv.Mat();
      // warp from grayscale for a clean digit surface
      cv.warpPerspective(gray, warpMat, M, new cv.Size(S, S),
        cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar(255));

      srcTri.delete(); dstTri.delete(); M.delete();
      return { warpMat, sideLen: S };
    } finally {
      src.delete(); gray.delete(); blur.delete(); thr.delete();
      contours.delete(); hier.delete();
    }
  }

  // order 4 corners as TL, TR, BR, BL
  function orderCorners(approx) {
    const pts = [];
    for (let i = 0; i < 4; i++) pts.push({ x: approx.data32S[i * 2], y: approx.data32S[i * 2 + 1] });
    pts.sort((a, b) => (a.x + a.y) - (b.x + b.y));
    const tl = pts[0], br = pts[3];
    const rem = [pts[1], pts[2]];
    rem.sort((a, b) => (a.x - a.y) - (b.x - b.y)); // larger x-y => TR
    const tr = rem[1], bl = rem[0];
    return [tl, tr, br, bl];
  }
  function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }

  /* ---- segment warped square into 81 cleaned cell canvases ---- */
  function segmentCells(warpMat, S) {
    const cv = window.cv;
    const step = S / 9;
    const margin = Math.round(step * 0.12); // trim residual grid lines
    const canvases = [], ink = [];

    for (let r = 0; r < 9; r++) {
      for (let c = 0; c < 9; c++) {
        const x0 = Math.round(c * step) + margin;
        const y0 = Math.round(r * step) + margin;
        const cw = Math.round(step) - margin * 2;
        const ch = Math.round(step) - margin * 2;
        const rect = new cv.Rect(
          Math.max(0, x0), Math.max(0, y0),
          Math.max(1, Math.min(cw, S - x0)), Math.max(1, Math.min(ch, S - y0))
        );
        const roi = warpMat.roi(rect);
        const cell = new cv.Mat();
        // binarize cell: Otsu inverse → white digit on black
        cv.threshold(roi, cell, 0, 255, cv.THRESH_BINARY_INV + cv.THRESH_OTSU);

        // ink density on a centered inner region (ignore stray border ink)
        const ipad = Math.round(cell.rows * 0.16);
        let inkCount = 0, total = 0;
        for (let yy = ipad; yy < cell.rows - ipad; yy++) {
          for (let xx = ipad; xx < cell.cols - ipad; xx++) {
            total++;
            if (cell.ucharPtr(yy, xx)[0] > 0) inkCount++;
          }
        }
        const density = total ? inkCount / total : 0;
        ink.push(density);

        // export a padded, normalized canvas for the recognizer
        const out = document.createElement("canvas");
        out.width = 48; out.height = 48;
        const octx = out.getContext("2d");
        octx.fillStyle = "#fff"; octx.fillRect(0, 0, 48, 48); // recognizer wants dark-on-light
        // draw the cell (white-on-black) inverted back to black-on-white, centered
        const tmp = document.createElement("canvas");
        tmp.width = cell.cols; tmp.height = cell.rows;
        cv.imshow(tmp, cell); // white digit on black
        // invert via globalCompositeOperation
        octx.save();
        octx.translate(6, 6);
        const sw = 36, sh = 36;
        octx.filter = "invert(1)";
        octx.drawImage(tmp, 0, 0, sw, sh);
        octx.restore();
        canvases.push(out);

        roi.delete(); cell.delete();
      }
    }
    return { canvases, ink };
  }

  function matToObjectURL(mat) {
    const cnv = document.createElement("canvas");
    window.cv.imshow(cnv, mat);
    return cnv.toDataURL("image/png");
  }

  /* =====================================================
     RECOGNIZER  (pluggable digit step)
     Shipped: Tesseract.js, single-char, digit whitelist.
     Blank detection by ink density BEFORE classifying.
     PHASE4: swap classifyCells for a CNN without touching
     CV/segmentation/review code.
     ===================================================== */
  const Recognizer = (function () {
    const INK_BLANK = 0.022; // below this density → treat as empty cell

    async function classifyCells(seg, onProgress) {
      const worker = await ensureWorker();
      const values = new Array(81).fill(0);
      const conf = new Array(81).fill(1);

      for (let i = 0; i < 81; i++) {
        if (seg.ink[i] < INK_BLANK) {
          values[i] = 0; conf[i] = 1;        // confidently blank
        } else {
          try {
            const res = await worker.recognize(seg.canvases[i]);
            const raw = (res.data.text || "").replace(/[^1-9]/g, "");
            const digit = raw ? Number(raw[0]) : 0;
            // Tesseract confidence 0..100 → 0..1; low ink-but-no-digit = uncertain
            let cf = (res.data.confidence != null ? res.data.confidence : 0) / 100;
            if (!digit) { values[i] = 0; conf[i] = Math.min(cf, 0.4); }
            else { values[i] = digit; conf[i] = cf; }
          } catch (e) {
            values[i] = 0; conf[i] = 0.0;     // force review
          }
        }
        if (onProgress) onProgress(i + 1);
      }
      return { values, conf };
    }

    return { classifyCells, INK_BLANK };
  })();

  /* =====================================================
     STAGE 3 — VERIFY COMPLIANCE  (mandatory review)
     ===================================================== */
  const LOW_CONF = 0.62; // below → flag the cell amber

  function renderReview() {
    const st = reviewState;
    stage().innerHTML = `
      <div class="optical__review">
        <div class="optical__review-instr">
          VERIFYING COMPLIANCE — confirm the extracted numerals.
          Flagged cells are low-confidence; tap any cell, then a numeral to correct.
        </div>
        <div class="optical__review-body">
          <div class="optical__review-gridwrap">
            <div class="optical__rgrid" id="optical-rgrid" role="grid" aria-label="Review grid"></div>
          </div>
          <div class="optical__review-aside">
            <div class="optical__warp">
              <div class="optical__warp-label">EXTRACTED ARTIFACT</div>
              <img id="optical-warp-img" alt="Warped puzzle" src="${st.warpURL || ""}" />
            </div>
            <div class="optical__rpad" id="optical-rpad" aria-label="Correction pad">
              ${[1,2,3,4,5,6,7,8,9].map((n)=>`<button class="optical__rkey" data-rnum="${n}">${n}</button>`).join("")}
              <button class="optical__rkey optical__rkey--erase" data-rnum="0">⌫</button>
            </div>
          </div>
        </div>
        <div class="optical__review-err" id="optical-review-err" role="alert"></div>
        <div class="optical__review-actions">
          <button class="btn" data-close="1">CANCEL</button>
          <button class="btn" id="optical-rescan">RESUBMIT</button>
          <button class="btn btn--primary" id="optical-confirm">CONFIRM &amp; REFINE</button>
        </div>
      </div>`;

    buildReviewGrid();
    reviewSel = -1;

    const pad = document.getElementById("optical-rpad");
    pad.addEventListener("pointerdown", (e) => {
      const k = e.target.closest(".optical__rkey");
      if (!k) return;
      e.preventDefault();
      setReviewCell(Number(k.dataset.rnum));
    });
    document.getElementById("optical-rescan").addEventListener("click", () => {
      Sound.select && Sound.select(); renderDropStage();
    });
    document.getElementById("optical-confirm").addEventListener("click", confirmReview);

    // low-confidence corporate nudge
    const flagged = st.conf.filter((c, i) => st.values[i] !== 0 && c < LOW_CONF).length;
    if (flagged > 6) {
      toast(flagged + " CELLS REQUIRE VERIFICATION. PROCEED WITH CARE.", "passive");
    }
  }

  function buildReviewGrid() {
    const g = document.getElementById("optical-rgrid");
    g.innerHTML = "";
    for (let i = 0; i < 81; i++) {
      const c = document.createElement("div");
      c.className = "optical__rcell";
      c.dataset.i = i;
      c.dataset.r = Math.floor(i / 9);
      c.dataset.c = i % 9;
      c.addEventListener("pointerdown", () => selectReview(i));
      g.appendChild(c);
    }
    paintReview();
  }

  function selectReview(i) {
    reviewSel = i;
    Sound.select && Sound.select();
    paintReview();
  }

  function setReviewCell(v) {
    if (reviewSel < 0) return;
    reviewState.values[reviewSel] = v;
    reviewState.conf[reviewSel] = 1;   // user-corrected = trusted
    Sound.key && Sound.key();
    clearReviewError();
    paintReview();
  }

  function paintReview() {
    const cells = stage().querySelectorAll(".optical__rcell");
    const conflicts = SudokuEngine.findConflicts(reviewState.values);
    cells.forEach((cell) => {
      const i = Number(cell.dataset.i);
      const v = reviewState.values[i];
      cell.textContent = v === 0 ? "" : v;
      cell.className = "optical__rcell";
      if (v !== 0) cell.classList.add("is-filled");
      if (v !== 0 && reviewState.conf[i] < LOW_CONF) cell.classList.add("is-low");
      if (conflicts.has(i)) cell.classList.add("is-conflict");
      if (i === reviewSel) cell.classList.add("is-sel");
    });
  }

  function showReviewError(msg) {
    const e = document.getElementById("optical-review-err");
    if (e) e.textContent = msg;
    Sound.err && Sound.err();
  }
  function clearReviewError() {
    const e = document.getElementById("optical-review-err");
    if (e) e.textContent = "";
  }

  /* ---- CONFIRM: validate, then hand to the console ---- */
  function confirmReview() {
    const grid = reviewState.values.slice();

    // structural conflicts first
    const conflicts = SudokuEngine.findConflicts(grid);
    if (conflicts.size > 0) {
      showReviewError("FILE CONTAINS ANOMALIES — VERIFY INTAKE. (DUPLICATE NUMERALS)");
      paintReview();
      return;
    }
    const clueCount = grid.filter((v) => v !== 0).length;
    if (clueCount < 17) { // 17 is the known minimum for a unique Sudoku
      showReviewError("INSUFFICIENT NUMERIC CONTENT — VERIFY INTAKE.");
      return;
    }
    // must be solvable
    const test = grid.slice();
    if (!SudokuEngine.solve(test)) {
      showReviewError("FILE CONTAINS ANOMALIES — VERIFY INTAKE. (NO VALID SOLUTION)");
      return;
    }

    // accept → FILE ACCEPTED beat → load into console as locked givens
    clearReviewError();
    Sound.ok && Sound.ok();
    close();
    Interstitial.show("FILE ACCEPTED");
    setTimeout(() => {
      // loadFromString locks the non-zero cells as givens, exactly like paste
      Console.loadFromString(SudokuEngine.toString(grid));
      Corporate && Corporate.friendly && Corporate.friendly();
    }, 520);
  }

  /* =====================================================
     ERROR PATHS  (always leave a way back to manual entry)
     ===================================================== */
  function corporateError(msg) {
    toast(msg, "passive");
    Sound.err && Sound.err();
    // keep the modal open on the drop stage so the user can resubmit
    renderDropStage();
  }

  function libraryFailure() {
    stage().innerHTML = `
      <div class="optical__fail">
        <div class="optical__fail-mark">⚠</div>
        <div class="optical__fail-head">OPTICAL INTAKE UNAVAILABLE</div>
        <div class="optical__fail-sub">
          The optical apparatus could not be authorized at this time.
          Numeric content may still be entered by hand or pasted as a file string.
        </div>
        <div class="optical__review-actions">
          <button class="btn" id="optical-retry">RETRY AUTHORIZATION</button>
          <button class="btn btn--primary" data-close="1">RETURN TO MANUAL INTAKE</button>
        </div>
      </div>`;
    const r = document.getElementById("optical-retry");
    if (r) r.addEventListener("click", () => { Sound.select && Sound.select(); renderDropStage(); });
    toast("OPTICAL MODULE OFFLINE — MANUAL INTAKE REMAINS AVAILABLE.", "passive");
  }

  /* ---- small async helpers ---- */
  function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }
  function raf2() { return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); }

  return { open, close };
})();
