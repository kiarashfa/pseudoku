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
    // physical-keyboard support for the review grid (the virtual pad isn't the
    // only way to correct a cell). Installed once; gated to the review stage.
    document.addEventListener("keydown", onReviewKey);
    modalEl = el;
  }

  // Route desktop keystrokes to the selected review cell while the review grid
  // is on screen: 1-9 sets the value, 0/Backspace/Delete clears it, arrows move
  // the selection. Bails entirely when the review grid isn't mounted, so it
  // never interferes with the drop/working stages or other screens.
  function onReviewKey(e) {
    if (!modalEl || !modalEl.classList.contains("show")) return;
    if (!document.getElementById("optical-rgrid")) return; // not in review stage
    if (/^[1-9]$/.test(e.key))                                  { e.preventDefault(); setReviewCell(Number(e.key)); }
    else if (e.key === "0" || e.key === "Backspace" || e.key === "Delete") { e.preventDefault(); setReviewCell(0); }
    else if (e.key.indexOf("Arrow") === 0)                      { e.preventDefault(); moveReview(e.key); }
  }
  function moveReview(key) {
    let i = reviewSel < 0 ? 0 : reviewSel;
    const r = Math.floor(i / 9), c = i % 9;
    if (key === "ArrowUp"    && r > 0) i -= 9;
    else if (key === "ArrowDown"  && r < 8) i += 9;
    else if (key === "ArrowLeft"  && c > 0) i -= 1;
    else if (key === "ArrowRight" && c < 8) i += 1;
    selectReview(i);
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
      Sound.ok && Sound.ok(); fileInput.click();
    });
    document.getElementById("optical-camera").addEventListener("click", () => {
      Sound.ok && Sound.ok(); camInput.click();
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
      Sound.process && Sound.process();
      setWork(null, 55, "Optical core authorized.");
      await loadTesseract();
      Sound.process && Sound.process();
      setWork(null, 80, "Numeric reader authorized.");
      // warm a reusable Tesseract worker tuned for single digits
      await ensureWorker();
      Sound.process && Sound.process();
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
    // start the working cue immediately — from "Requesting optical clearance."
    // (ensureAssets can take seconds to load OpenCV/Tesseract on first run)
    Sound.process && Sound.process();
    const ok = await ensureAssets();
    if (!ok) {
      busy = false;
      libraryFailure();
      return;
    }
    renderWorking("EXTRACTING NUMERIC CONTENT...");
    Sound.process && Sound.process();
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
      Sound.process && Sound.process();
      setWork(null, 35, "Segmenting 81 cells.");
      const seg = segmentCells(warp, detected.sideLen); // { canvases[81], ink[81] }
      await raf2();

      Sound.process && Sound.process();
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
    const iw = Math.round(img.width * scale), ih = Math.round(img.height * scale);

    // PAD with a white margin. Many sources (screenshots, tightly-cropped
    // scans like a flush-to-edge printed grid) put the puzzle border right at
    // the image edge. Without margin, the border merges with the frame and the
    // quad detector locks onto the image rectangle instead of the true grid —
    // which is exactly what stretches a flat puzzle horizontally on warp.
    // A clean white gutter on all sides makes the grid a fully-enclosed contour.
    const pad = Math.round(Math.max(iw, ih) * 0.06);
    const w = iw + pad * 2, h = ih + pad * 2;

    const cnv = document.createElement("canvas");
    cnv.width = w; cnv.height = h;
    const cctx = cnv.getContext("2d");
    cctx.fillStyle = "#fff"; cctx.fillRect(0, 0, w, h);
    cctx.drawImage(img, pad, pad, iw, ih);

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

      // pick the largest near-square 4-corner contour by area
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
            // reject quads that aren't roughly square. A real grid is 1:1; a
            // stretched/degenerate quad (e.g. one edge riding the frame) is not.
            // Using the bounding rect of the 4 pts keeps this cheap.
            const r = cv.boundingRect(approx);
            const ar = r.width / Math.max(1, r.height);
            if (ar > 0.7 && ar < 1.43) {
              if (best) best.delete();
              best = approx; bestArea = area;
            } else approx.delete();
          } else approx.delete();
        }
        c.delete();
      }
      if (!best) return null;

      let corners = orderCorners(best);
      best.delete();

      // sub-pixel corner refinement: snap each approx corner to the true
      // grid corner using cornerSubPix on the grayscale image. This tightens
      // the deskew on messy / slightly-bowed photos where approxPolyDP lands
      // a few px off the real intersection.
      try {
        const cornMat = cv.matFromArray(4, 1, cv.CV_32FC2, [
          corners[0].x, corners[0].y, corners[1].x, corners[1].y,
          corners[2].x, corners[2].y, corners[3].x, corners[3].y,
        ]);
        const winSize = new cv.Size(
          Math.max(5, Math.round(Math.min(w, h) * 0.012)),
          Math.max(5, Math.round(Math.min(w, h) * 0.012))
        );
        const zeroZone = new cv.Size(-1, -1);
        const crit = new cv.TermCriteria(
          cv.TermCriteria_EPS + cv.TermCriteria_MAX_ITER, 30, 0.01);
        cv.cornerSubPix(gray, cornMat, winSize, zeroZone, crit);
        const refined = [];
        for (let i = 0; i < 4; i++) {
          refined.push({ x: cornMat.data32F[i * 2], y: cornMat.data32F[i * 2 + 1] });
        }
        cornMat.delete();
        // only trust refinement if it didn't fly off (stay within ~3% of frame)
        const tol = Math.max(w, h) * 0.03;
        const sane = refined.every((p, i) => dist(p, corners[i]) < tol);
        if (sane) corners = refined;
      } catch (e) { /* keep coarse corners on any failure */ }

      // side length from corner geometry — average opposing edges so a skewed
      // capture doesn't bias the square toward its longest side
      const wTop = dist(corners[0], corners[1]);
      const wBot = dist(corners[3], corners[2]);
      const hLft = dist(corners[0], corners[3]);
      const hRgt = dist(corners[1], corners[2]);
      const side = Math.round(Math.max((wTop + wBot) / 2, (hLft + hRgt) / 2));
      // bump the working square up: larger warp → bigger cells → sharper digits.
      const S = Math.max(450, Math.min(1200, side)); // clamp for sane cells

      const srcTri = cv.matFromArray(4, 1, cv.CV_32FC2, [
        corners[0].x, corners[0].y, corners[1].x, corners[1].y,
        corners[2].x, corners[2].y, corners[3].x, corners[3].y,
      ]);
      const dstTri = cv.matFromArray(4, 1, cv.CV_32FC2, [
        0, 0, S, 0, S, S, 0, S,
      ]);
      const M = cv.getPerspectiveTransform(srcTri, dstTri);
      warpMat = new cv.Mat();
      // warp from grayscale for a clean digit surface; cubic resampling keeps
      // thin printed strokes crisp under the perspective transform
      cv.warpPerspective(gray, warpMat, M, new cv.Size(S, S),
        cv.INTER_CUBIC, cv.BORDER_CONSTANT, new cv.Scalar(255));

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

  /* ---- segment warped square into 81 cleaned cell canvases ----
     Each cell yields:
       - ink density (for the blank gate, measured on the cleaned digit mask)
       - three normalized canvases (canA / canB / canC) for the vote:
           canA: digit tight-cropped, centered, GENEROUS padding, upscaled
           canB: same digit, slightly larger scale + thinner padding
           canC: mid padding — tiebreaker pass
     Pipeline per cell: crop with margin → hybrid binarize → remove grid
     lines → keep the largest central blob → tight bbox → center on a
     square canvas with white padding → upscale.                          */
  function segmentCells(warpMat, S) {
    const cv = window.cv;
    const step = S / 9;
    const margin = Math.round(step * 0.10); // trim residual grid lines
    const canvases = [], canvasesB = [], canvasesC = [], ink = [];

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

        const result = cleanCell(roi); // { mask, density } mask = white digit on black
        ink.push(result.density);

        const { canA, canB, canC } = renderDigitCanvases(result.mask, result.bbox);
        canvases.push(canA);
        canvasesB.push(canB);
        canvasesC.push(canC);

        result.mask.delete();
        roi.delete();
      }
    }
    return { canvases, canvasesB, canvasesC, ink };
  }

  /* ---- per-cell cleaning: binarize, strip grid lines, isolate digit ----
     Returns a white-digit-on-black mask, the digit bounding box (or null),
     and an ink density measured on that mask's central region.            */
  function cleanCell(roi) {
    const cv = window.cv;
    const work = new cv.Mat();
    // upsample the small cell first so thin strokes survive thresholding
    const TARGET = 90;
    cv.resize(roi, work, new cv.Size(TARGET, TARGET), 0, 0, cv.INTER_CUBIC);
    // gentle denoise without smearing strokes
    cv.GaussianBlur(work, work, new cv.Size(3, 3), 0);

    // --- hybrid binarization: adaptive (handles uneven light) AND'd with a
    //     global Otsu (kills broad shadows the adaptive pass leaves behind) ---
    const adapt = new cv.Mat(), otsu = new cv.Mat(), bin = new cv.Mat();
    cv.adaptiveThreshold(work, adapt, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C,
      cv.THRESH_BINARY_INV, 19, 8);
    cv.threshold(work, otsu, 0, 255, cv.THRESH_BINARY_INV + cv.THRESH_OTSU);
    cv.bitwise_and(adapt, otsu, bin); // white = ink, black = paper
    adapt.delete(); otsu.delete(); work.delete();

    // --- aggressive grid-line removal -------------------------------------
    // Long thin horizontal / vertical runs are border remnants, not digits.
    // Build line masks with 1-D structuring elements sized to the cell, then
    // subtract them — but ONLY in the border bands. A printed "9" tail (and the
    // strokes of 1/4/7) can run near-vertically across much of the cell; if we
    // subtract full-cell lines everywhere we clip those tails and the 9 reads
    // as 0/blank. Grid-line remnants, by contrast, hug the cell edges (the crop
    // already trimmed most of them). So we detect long runs, then erase the
    // detection inside the central digit box before subtracting.
    const span = bin.cols;
    const horK = cv.getStructuringElement(cv.MORPH_RECT,
      new cv.Size(Math.max(10, Math.round(span * 0.80)), 1));
    const verK = cv.getStructuringElement(cv.MORPH_RECT,
      new cv.Size(1, Math.max(10, Math.round(span * 0.80))));
    const hor = new cv.Mat(), ver = new cv.Mat(), lines = new cv.Mat();
    cv.morphologyEx(bin, hor, cv.MORPH_OPEN, horK);
    cv.morphologyEx(bin, ver, cv.MORPH_OPEN, verK);
    cv.add(hor, ver, lines);
    // dilate detected lines slightly to cover their full thickness
    const lineDil = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(2, 2));
    cv.dilate(lines, lines, lineDil);
    // protect the centre: blank the line mask inside the inner digit region so
    // we never subtract a stroke that passes through where the glyph lives
    const band = Math.round(span * 0.18); // border band width on each side
    const innerRect = new cv.Rect(band, band,
      Math.max(1, bin.cols - band * 2), Math.max(1, bin.rows - band * 2));
    const innerROI = lines.roi(innerRect);
    innerROI.setTo(new cv.Scalar(0));
    innerROI.delete();
    cv.subtract(bin, lines, bin);
    horK.delete(); verK.delete(); hor.delete(); ver.delete();
    lines.delete(); lineDil.delete();

    // repair small breaks the line subtraction may have caused
    const closeK = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(3, 3));
    cv.morphologyEx(bin, bin, cv.MORPH_CLOSE, closeK);
    // strip salt noise
    cv.morphologyEx(bin, bin, cv.MORPH_OPEN, closeK);
    closeK.delete();

    // --- keep only the largest blob whose centroid is near the cell centre.
    //     Border crumbs and neighbouring-cell bleed get dropped.            ---
    const labels = new cv.Mat(), stats = new cv.Mat(), centroids = new cv.Mat();
    const n = cv.connectedComponentsWithStats(bin, labels, stats, centroids, 8, cv.CV_32S);
    const cx = bin.cols / 2, cy = bin.rows / 2;
    const maxR = bin.cols * 0.42; // centroid must sit within this of centre
    let bestLabel = -1, bestArea = 0, bbox = null;
    const minArea = (bin.cols * bin.rows) * 0.012;
    const maxArea = (bin.cols * bin.rows) * 0.85;
    for (let l = 1; l < n; l++) {
      const area = stats.intAt(l, cv.CC_STAT_AREA);
      if (area < minArea || area > maxArea) continue;
      const ccx = centroids.doubleAt(l, 0), ccy = centroids.doubleAt(l, 1);
      if (Math.hypot(ccx - cx, ccy - cy) > maxR) continue;
      if (area > bestArea) {
        bestArea = area; bestLabel = l;
        bbox = {
          x: stats.intAt(l, cv.CC_STAT_LEFT),
          y: stats.intAt(l, cv.CC_STAT_TOP),
          w: stats.intAt(l, cv.CC_STAT_WIDTH),
          h: stats.intAt(l, cv.CC_STAT_HEIGHT),
        };
      }
    }

    // build the cleaned mask = only the winning blob (white on black)
    const mask = cv.Mat.zeros(bin.rows, bin.cols, cv.CV_8U);
    if (bestLabel >= 0) {
      for (let yy = bbox.y; yy < bbox.y + bbox.h; yy++) {
        for (let xx = bbox.x; xx < bbox.x + bbox.w; xx++) {
          if (labels.intAt(yy, xx) === bestLabel) mask.ucharPtr(yy, xx)[0] = 255;
        }
      }
    }
    labels.delete(); stats.delete(); centroids.delete(); bin.delete();

    // density of the kept blob over the whole cell — the blank gate reads this
    const density = bestArea / (mask.rows * mask.cols);
    return { mask, density, bbox: bestLabel >= 0 ? bbox : null };
  }

  /* ---- render the cleaned mask into two normalized recognizer canvases ----
     Both are black digit on white. We tight-crop to the bbox, center it on a
     square, add generous white padding, and upscale — Tesseract reads a big,
     centered, well-margined glyph far better than a raw cell crop.          */
  function renderDigitCanvases(mask, bbox) {
    const cv = window.cv;
    const OUT = 64; // final canvas is OUT×OUT, upscaled from the small mask

    function make(padFrac, scaleFrac) {
      const out = document.createElement("canvas");
      out.width = OUT; out.height = OUT;
      const octx = out.getContext("2d");
      octx.fillStyle = "#fff"; octx.fillRect(0, 0, OUT, OUT); // white paper
      if (!bbox) return out; // blank cell → leave white

      // crop the digit out of the mask
      const crop = mask.roi(new cv.Rect(bbox.x, bbox.y, bbox.w, bbox.h));
      const tmp = document.createElement("canvas");
      tmp.width = bbox.w; tmp.height = bbox.h;
      cv.imshow(tmp, crop); // white digit on black
      crop.delete();

      // scale the digit so its longer side fills scaleFrac of the inner box
      const inner = OUT * scaleFrac;
      const s = inner / Math.max(bbox.w, bbox.h);
      const dw = Math.max(1, Math.round(bbox.w * s));
      const dh = Math.max(1, Math.round(bbox.h * s));
      const dx = Math.round((OUT - dw) / 2);
      const dy = Math.round((OUT - dh) / 2);

      // draw inverted (black digit on the white canvas), centered, with the
      // padding implied by scaleFrac < 1
      octx.save();
      octx.imageSmoothingEnabled = true;
      octx.filter = "invert(1)";
      octx.drawImage(tmp, dx, dy, dw, dh);
      octx.restore();
      void padFrac; // padding is expressed through scaleFrac; kept for clarity
      return out;
    }

    // Pass A: generous padding (digit fills ~58% of the box → big white margin)
    // Pass B: tighter, larger glyph (~74%) — a second opinion for the vote
    // Pass C: mid padding (~66%) — tiebreaker, often rescues a clipped 9
    return { canA: make(0.42, 0.58), canB: make(0.26, 0.74), canC: make(0.34, 0.66) };
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
    const INK_BLANK = 0.010; // mask blob density below this → empty cell

    // recognize one canvas, return { digit, conf } (conf 0..1)
    async function readOne(worker, canvas) {
      try {
        const res = await worker.recognize(canvas);
        const raw = (res.data.text || "").replace(/[^1-9]/g, "");
        const digit = raw ? Number(raw[0]) : 0;
        let cf = (res.data.confidence != null ? res.data.confidence : 0) / 100;
        if (cf < 0) cf = 0; if (cf > 1) cf = 1;
        return { digit, conf: cf };
      } catch (e) {
        return { digit: 0, conf: 0 };
      }
    }

    async function classifyCells(seg, onProgress) {
      const worker = await ensureWorker();
      const values = new Array(81).fill(0);
      const conf = new Array(81).fill(1);

      for (let i = 0; i < 81; i++) {
        if (seg.ink[i] < INK_BLANK) {
          values[i] = 0; conf[i] = 1;        // confidently blank
        } else {
          // --- three-pass vote: read all normalized variants of the cell ---
          const reads = [
            await readOne(worker, seg.canvases[i]),
            await readOne(worker, seg.canvasesB[i]),
            await readOne(worker, seg.canvasesC[i]),
          ];

          // tally digits across passes, weighted by confidence
          const tally = {}; // digit → { count, confSum, confMax }
          for (const r of reads) {
            if (!r.digit) continue;
            const t = tally[r.digit] || (tally[r.digit] = { count: 0, confSum: 0, confMax: 0 });
            t.count++; t.confSum += r.conf; t.confMax = Math.max(t.confMax, r.conf);
          }

          let digit = 0, cf = 0;
          const entries = Object.keys(tally);
          if (entries.length === 0) {
            // INK present (blank gate already passed) but no pass read a digit.
            // This is the classic clipped-9 / odd-glyph case — never silently
            // drop it. Surface it for mandatory review at zero confidence.
            digit = 0; cf = 0;
          } else {
            // pick the digit with the most votes; break ties by summed conf
            entries.sort((x, y) => {
              const dx = tally[x], dy = tally[y];
              if (dy.count !== dx.count) return dy.count - dx.count;
              return dy.confSum - dx.confSum;
            });
            digit = Number(entries[0]);
            const t = tally[digit];
            if (t.count === 3)      cf = Math.min(1, t.confMax + 0.15); // unanimous
            else if (t.count === 2) cf = Math.min(0.9, t.confMax + 0.05); // majority
            else                    cf = Math.min(0.5, t.confMax); // plurality → review
          }

          values[i] = digit;
          // a detected-ink cell that produced no digit must go to review
          conf[i] = digit ? cf : 0;
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
