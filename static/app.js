/* Bus Attendance - frontend
 * Face detection + recognition run entirely in the browser (face-api.js).
 * The server only stores students, their 128-d face descriptors and attendance.
 */
(function () {
  "use strict";

  const MODEL_URL = "/static/models";
  const MATCH_THRESHOLD = 0.5;      // euclidean distance; lower = stricter (0.6 is face-api default)
  const SCAN_INTERVAL_MS = 300;     // how often a frame is analysed while scanning
  const RESCAN_COOLDOWN_MS = 8000;  // do not re-post the same student within this window
  // SSD MobileNet V1 is much better at finding partially covered faces (hijab, caps, glasses) than the
  // tiny detector; it is used once its weights load, the tiny detector stays as a fallback.
  const DETECTOR = { kind: "tiny" };
  const DETECT_OPTS = () =>
    DETECTOR.kind === "ssd"
      ? new faceapi.SsdMobilenetv1Options({ minConfidence: 0.4, maxResults: 10 })
      : new faceapi.TinyFaceDetectorOptions({ inputSize: 416, scoreThreshold: 0.3 });
  const SCAN_ERROR_LIMIT = 8;       // consecutive detection failures before the page reloads itself
  const SCAN_STUCK_MS = 8000;       // a detection call taking longer than this is considered hung

  const $ = (id) => document.getElementById(id);

  // ------------------------------------------------------------------ state
  let students = [];              // from /api/students (includes descriptors)
  let matcher = null;             // faceapi.FaceMatcher built from students
  let modelsReady = false;
  let scanStream = null, scanTimer = null, scanBusy = false, scanFacing = "environment";
  let scanWanted = false;           // the user pressed Start and has not pressed Stop (survives tab switches / screen lock)
  let scanBusySince = 0, scanErrors = 0, wakeLock = null;
  let addStream = null, addTimer = null, addBusy = false, addFacing = "user";
  let addSamples = [];            // Float32Array descriptors captured for the new student
  let addPhoto = "";              // data URL thumbnail for the new student
  let lastAddDetection = null;    // latest detection in the add-student camera
  let detailStudent = null;
  let busFilter = "";             // "" = all buses (Students tab + Scan tab present list)
  const recentlyMarked = new Map(); // student id -> timestamp of last post

  // --------------------------------------------------------------- helpers
  function todayStr() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }
  function nowTime() {
    const d = new Date();
    return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, "0")).join(":");
  }
  function weekdayName(iso) {
    return new Date(iso + "T00:00:00").toLocaleDateString(getLang() === "ar" ? "ar" : "en", { weekday: "long" });
  }
  function hijriDate(iso) {
    // Umm al-Qura calendar, Latin digits; falls back to the Gregorian date on very old browsers
    try {
      const loc = (getLang() === "ar" ? "ar-SA" : "en") + "-u-ca-islamic-umalqura-nu-latn";
      return new Intl.DateTimeFormat(loc, { day: "numeric", month: "long", year: "numeric" }).format(new Date(iso + "T00:00:00"));
    } catch (e) { return iso; }
  }
  function monthStart() {
    return todayStr().slice(0, 8) + "01";
  }
  let toastTimer = null;
  function toast(msg, kind = "") {
    const el = $("toast");
    el.textContent = msg;
    el.className = `toast ${kind}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add("hidden"), 2600);
  }
  async function api(path, opts = {}) {
    const res = await fetch(path, {
      headers: { "Content-Type": "application/json", "X-Lang": getLang() },
      ...opts,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || t("request_failed", { code: res.status }));
    return data;
  }
  function initials(name) {
    return name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join("");
  }
  function avatarHtml(s, big = false) {
    const cls = `avatar${big ? " big" : ""}`;
    if (s.photo) return `<img class="${cls}" src="${s.photo}" alt="">`;
    return `<div class="${cls} placeholder">${initials(s.name)}</div>`;
  }
  function busTag(s) {
    return s.bus_no ? `<span class="bus-tag">🚌 ${escapeHtml(s.bus_no)}</span>` : "";
  }
  function busList() {
    return [...new Set(students.map((s) => s.bus_no).filter(Boolean))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  }
  function renderBusChips() {
    const buses = busList();
    const html = buses.length
      ? [`<button class="chip${busFilter === "" ? " active" : ""}" data-bus="">${t("all_buses")}</button>`]
          .concat(buses.map((b) => `<button class="chip${busFilter === b ? " active" : ""}" data-bus="${escapeHtml(b)}">${t("bus_n", { n: escapeHtml(b) })}</button>`)).join("")
      : "";
    $("bus-chips").innerHTML = html;
    $("scan-bus-chips").innerHTML = html;
    const sel = $("export-bus");
    const current = sel.value;
    sel.innerHTML = `<option value="">${t("all_buses")}</option>` + buses.map((b) => `<option value="${escapeHtml(b)}">${t("bus_option", { n: escapeHtml(b) })}</option>`).join("");
    sel.value = buses.includes(current) ? current : "";
    updateExportLinks();
  }
  function setBusFilter(bus) {
    busFilter = bus;
    renderBusChips();
    renderStudents();
    renderStats();
    loadPresent();
  }
  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  async function openCamera(video, facing) {
    const constraints = { audio: false, video: { facingMode: { ideal: facing }, width: { ideal: 640 }, height: { ideal: 480 } } };
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch (e) {
      stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: true });
    }
    video.srcObject = stream;
    await new Promise((resolve) => {
      if (video.readyState >= 2) return resolve();
      video.onloadedmetadata = () => resolve();
      setTimeout(resolve, 4000); // never hang if the browser does not fire loadedmetadata (seen on some iOS versions)
    });
    try {
      await video.play();
    } catch (e) {
      console.warn("video.play failed", e);
      // autoplay blocked (iOS without a user gesture): a tap on the preview starts it
      video.addEventListener("click", () => video.play().catch(() => {}), { once: true });
    }
    return stream;
  }
  async function requestWakeLock() {
    try {
      if ("wakeLock" in navigator && !wakeLock) {
        wakeLock = await navigator.wakeLock.request("screen");
        wakeLock.addEventListener("release", () => { wakeLock = null; });
      }
    } catch (e) { /* not supported or denied: the screen may dim, scanning resumes when it wakes */ }
  }
  function releaseWakeLock() {
    if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
  }
  function setScanStatus(text, kind = "") {
    const el = $("scan-status");
    if (!el) return;
    el.textContent = text;
    el.className = `scan-status ${kind}`;
  }
  function stopStream(stream, video) {
    if (stream) stream.getTracks().forEach((t) => t.stop());
    if (video) video.srcObject = null;
  }
  function cropThumb(source, box, size = 112) {
    // source: video or image element; box: {x,y,width,height} in source pixel coords
    const c = document.createElement("canvas");
    c.width = size; c.height = size;
    const ctx = c.getContext("2d");
    const pad = Math.max(box.width, box.height) * 0.25;
    const side = Math.max(box.width, box.height) + pad * 2;
    const sx = box.x + box.width / 2 - side / 2;
    const sy = box.y + box.height / 2 - side / 2;
    ctx.drawImage(source, sx, sy, side, side, 0, 0, size, size);
    return c.toDataURL("image/jpeg", 0.8);
  }

  // ------------------------------------------------------------- models
  async function loadModels() {
    const st = $("model-status");
    try {
      await Promise.all([
        faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL),
        faceapi.nets.faceLandmark68TinyNet.loadFromUri(MODEL_URL),
        faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL),
      ]);
      modelsReady = true;
      st.textContent = t("models_ready");
      st.className = "model-status ok";
      $("btn-add-capture").disabled = !addStream;
      // the stronger detector is optional: 5.6 MB, cached by the browser after the first visit
      faceapi.nets.ssdMobilenetv1.loadFromUri(MODEL_URL)
        .then(() => { DETECTOR.kind = "ssd"; })
        .catch((e) => console.warn("SSD detector not loaded, using tiny detector", e));
    } catch (e) {
      console.error(e);
      st.textContent = t("models_failed");
      st.className = "model-status err";
    }
  }

  function rebuildMatcher() {
    const labeled = students
      .filter((s) => s.descriptors && s.descriptors.length)
      .map((s) => new faceapi.LabeledFaceDescriptors(String(s.id), s.descriptors.map((d) => new Float32Array(d))));
    matcher = labeled.length ? new faceapi.FaceMatcher(labeled, MATCH_THRESHOLD) : null;
  }

  // ------------------------------------------------------------ students
  async function loadStudents() {
    const data = await api(`/api/students?date=${todayStr()}`);
    students = data.students;
    rebuildMatcher();
    renderBusChips();
    renderStudents();
    renderStats();
  }

  function visibleStudents() {
    return busFilter ? students.filter((s) => s.bus_no === busFilter) : students;
  }
  function renderStats() {
    const pool = visibleStudents();
    const present = pool.filter((s) => s.present_today).length;
    $("stat-total").textContent = pool.length;
    $("stat-present").textContent = present;
    $("stat-absent").textContent = pool.length - present;
    $("present-count").textContent = `${present} / ${pool.length}`;
  }

  function renderStudents() {
    const q = $("search").value.trim().toLowerCase();
    const list = $("student-list");
    const rows = visibleStudents().filter((s) =>
      !q || s.name.toLowerCase().includes(q) || s.national_id.toLowerCase().includes(q) || (s.grade || "").toLowerCase().includes(q) || (s.bus_no || "").toLowerCase().includes(q)
    );
    list.innerHTML = rows.map((s) => `
      <li data-id="${s.id}">
        ${avatarHtml(s)}
        <div class="info">
          <div class="name">${escapeHtml(s.name)}</div>
          <div class="sub">${busTag(s)}<span class="ltr">${escapeHtml(s.national_id)}</span>${s.grade ? " · " + escapeHtml(s.grade) : ""} · ${t("days", { n: s.total_days })}</div>
        </div>
        ${s.present_today
          ? `<span class="badge present ltr">✓ ${escapeHtml((s.time_today || "").slice(0, 5))}</span>`
          : (s.descriptors && s.descriptors.length ? `<span class="badge absent">${t("absent")}</span>` : `<span class="badge noface">${t("no_face")}</span>`)}
      </li>`).join("");
    $("student-empty").classList.toggle("hidden", students.length > 0);
  }

  // ------------------------------------------------------------- present
  async function loadPresent() {
    const data = await api(`/api/attendance?date=${todayStr()}`);
    const list = $("present-list");
    const records = busFilter ? data.records.filter((r) => r.bus_no === busFilter) : data.records;
    list.innerHTML = records.map((r) => `
      <li data-record="${r.id}">
        ${avatarHtml(r)}
        <div class="info">
          <div class="name">${escapeHtml(r.name)}</div>
          <div class="sub">${busTag(r)}<span class="ltr">${escapeHtml(r.national_id)}</span>${r.grade ? " · " + escapeHtml(r.grade) : ""} · ${t("method_" + r.method)}</div>
        </div>
        <span class="badge present ltr">${escapeHtml(r.time.slice(0, 5))}</span>
        <button class="undo" data-undo="${r.id}">${t("undo")}</button>
      </li>`).join("");
    $("present-empty").classList.toggle("hidden", records.length > 0);
    const total = busFilter ? students.filter((s) => s.bus_no === busFilter).length : data.total_students;
    $("present-count").textContent = `${records.length} / ${total}`;
  }

  async function markPresent(student, method) {
    const res = await api("/api/attendance", {
      method: "POST",
      body: { student_id: student.id, day: todayStr(), time: nowTime(), method },
    });
    if (res.already_marked) {
      toast(t("already_marked", { name: student.name, t: res.time.slice(0, 5) }), "warn");
    } else {
      toast(t("marked", { name: student.name }), "ok");
      if (navigator.vibrate) navigator.vibrate(80);
    }
    const s = students.find((x) => x.id === student.id);
    if (s && !s.present_today) { s.present_today = true; s.time_today = res.time; s.total_days += 1; }
    renderStats();
    renderStudents();
    loadPresent();
    return res;
  }

  // ---------------------------------------------------------------- scan
  async function startScan(userAction = true) {
    if (!modelsReady) return toast(t("models_still_loading"), "warn");
    if (userAction) scanWanted = true;
    if (scanStream) return;
    try {
      scanStream = await openCamera($("scan-video"), scanFacing);
    } catch (e) {
      console.error(e);
      setScanStatus(t("camera_error", { name: e.name || "Error" }), "err");
      if (e.name === "NotReadableError" || e.name === "AbortError") {
        // the camera is still held by the previous session or another app: try once more shortly
        toast(t("camera_busy_retry"), "warn");
        setTimeout(() => { if (scanWanted && !scanStream) startScan(false); }, 1500);
        return;
      }
      scanWanted = false;
      return toast(`${t("camera_denied")} (${e.name || "Error"})`, "err");
    }
    // a track can end on its own (camera taken by a call/another app, device unplugged): resume automatically
    scanStream.getVideoTracks().forEach((track) => {
      track.onended = () => {
        if (!scanWanted) return;
        pauseScan();
        setScanStatus(t("camera_lost"), "warn");
        setTimeout(() => { if (scanWanted && !scanStream && !document.hidden) startScan(false); }, 1200);
      };
    });
    scanErrors = 0; scanBusy = false;
    $("scan-hint").classList.add("hidden");
    $("btn-scan-toggle").textContent = t("stop_camera");
    setScanStatus(t("scan_running", { faces: 0, det: DETECTOR.kind.toUpperCase() }), "ok");
    requestWakeLock();
    clearInterval(scanTimer);
    scanTimer = setInterval(scanFrame, SCAN_INTERVAL_MS);
  }
  // pause = release the camera but remember that scanning should continue (tab switch, screen lock, background)
  function pauseScan() {
    clearInterval(scanTimer); scanTimer = null;
    stopStream(scanStream, $("scan-video")); scanStream = null;
    scanBusy = false;
    const c = $("scan-canvas");
    c.getContext("2d").clearRect(0, 0, c.width, c.height);
    releaseWakeLock();
    $("scan-hint").classList.remove("hidden");
    $("btn-scan-toggle").textContent = t("start_camera");
  }
  function stopScan() {
    scanWanted = false;
    pauseScan();
    setScanStatus("");
  }
  function resumeScanIfWanted() {
    if (scanWanted && !scanStream && !document.hidden && $("tab-scan").classList.contains("active")) startScan(false);
  }
  async function scanFrame() {
    const video = $("scan-video");
    if (!scanStream || video.readyState < 2 || video.videoWidth === 0) return;
    if (scanBusy) {
      // watchdog: a detection that never returns (lost WebGL context after backgrounding) must not freeze scanning forever
      if (Date.now() - scanBusySince > SCAN_STUCK_MS) { scanBusy = false; scanErrors += 1; } else return;
    }
    scanBusy = true; scanBusySince = Date.now();
    try {
      const results = await faceapi.detectAllFaces(video, DETECT_OPTS()).withFaceLandmarks(true).withFaceDescriptors();
      scanErrors = 0;
      setScanStatus(t("scan_running", { faces: results.length, det: DETECTOR.kind.toUpperCase() }), "ok");
      const canvas = $("scan-canvas");
      const size = { width: video.videoWidth, height: video.videoHeight };
      faceapi.matchDimensions(canvas, size);
      const resized = faceapi.resizeResults(results, size);
      const ctx = canvas.getContext("2d");
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.lineWidth = 3;
      ctx.font = "bold 18px sans-serif";
      for (const r of resized) {
        const box = r.detection.box;
        let label = t("unknown"), color = "#e74c3c", student = null;
        if (matcher) {
          const best = matcher.findBestMatch(r.descriptor);
          if (best.label !== "unknown") {
            student = students.find((s) => String(s.id) === best.label);
            if (student) {
              label = `${student.name}${student.bus_no ? " · " + t("bus_option", { n: student.bus_no }) : ""} (${Math.round((1 - best.distance) * 100)}%)`;
              color = student.present_today ? "#2ecc71" : "#f1c40f";
            }
          }
        } else {
          label = t("no_students_registered");
        }
        ctx.strokeStyle = color;
        ctx.strokeRect(box.x, box.y, box.width, box.height);
        const tw = ctx.measureText(label).width + 12;
        ctx.fillStyle = color;
        ctx.fillRect(box.x, Math.max(0, box.y - 26), tw, 26);
        ctx.fillStyle = "#000";
        ctx.fillText(label, box.x + 6, Math.max(18, box.y - 7));

        if (student) {
          const last = recentlyMarked.get(student.id) || 0;
          if (!student.present_today && Date.now() - last > RESCAN_COOLDOWN_MS) {
            recentlyMarked.set(student.id, Date.now());
            markPresent(student, "face").catch((e) => toast(e.message, "err"));
          }
        }
      }
    } catch (e) {
      console.error(e);
      scanErrors += 1;
      setScanStatus(t("scan_error", { name: e.name || "Error", n: scanErrors }), "err");
      if (scanErrors >= SCAN_ERROR_LIMIT) {
        // the face engine is broken (typically a lost GPU context); a reload is the only reliable fix.
        // The page reopens on the Scan tab and starts the camera again by itself.
        try { sessionStorage.setItem("resumeScan", "1"); } catch (err) { /* ignore */ }
        toast(t("recovering"), "warn");
        setTimeout(() => location.reload(), 800);
      }
    } finally {
      scanBusy = false;
    }
  }

  // ----------------------------------------------------------- add student
  function resetAddForm() {
    const lastBus = $("add-bus").value;
    $("form-add").reset();
    $("add-bus").value = busFilter || lastBus;  // keep the bus when registering a whole bus in a row
    addSamples = []; addPhoto = ""; lastAddDetection = null;
    $("add-preview").classList.add("hidden");
    $("add-preview").src = "";
    $("add-error").classList.add("hidden");
    updateSamplesLabel();
  }
  function updateSamplesLabel() {
    const el = $("add-samples");
    if (addSamples.length === 0) {
      el.textContent = t("no_sample");
      el.className = "samples";
    } else {
      el.textContent = t("samples_ok", { n: addSamples.length }) + (addSamples.length < 3 ? t("samples_more") : "");
      el.className = "samples ok";
    }
  }
  async function startAddCam() {
    try {
      addStream = await openCamera($("add-video"), addFacing);
    } catch (e) {
      return toast(t("camera_denied"), "err");
    }
    $("add-preview").classList.add("hidden");
    $("add-hint").classList.add("hidden");
    $("btn-add-cam").textContent = t("flip");
    $("btn-add-capture").disabled = !modelsReady;
    addTimer = setInterval(addFrame, SCAN_INTERVAL_MS);
  }
  function stopAddCam() {
    clearInterval(addTimer); addTimer = null;
    stopStream(addStream, $("add-video")); addStream = null;
    const c = $("add-canvas");
    c.getContext("2d").clearRect(0, 0, c.width, c.height);
    $("add-hint").classList.remove("hidden");
    $("btn-add-cam").textContent = t("camera");
    $("btn-add-capture").disabled = true;
  }
  async function addFrame() {
    const video = $("add-video");
    if (addBusy || !addStream || !modelsReady || video.readyState < 2 || video.videoWidth === 0) return;
    addBusy = true;
    try {
      const det = await faceapi.detectSingleFace(video, DETECT_OPTS()).withFaceLandmarks(true).withFaceDescriptor();
      lastAddDetection = det || null;
      const canvas = $("add-canvas");
      const size = { width: video.videoWidth, height: video.videoHeight };
      faceapi.matchDimensions(canvas, size);
      const ctx = canvas.getContext("2d");
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (det) {
        const box = faceapi.resizeResults(det, size).detection.box;
        ctx.strokeStyle = "#2ecc71"; ctx.lineWidth = 3;
        ctx.strokeRect(box.x, box.y, box.width, box.height);
      }
    } catch (e) {
      console.error(e);
    } finally {
      addBusy = false;
    }
  }
  function captureSample() {
    if (!lastAddDetection) return toast(t("no_face_detected"), "warn");
    if (addSamples.length >= 5) return toast(t("enough_samples"), "warn");
    addSamples.push(lastAddDetection.descriptor);
    if (!addPhoto) addPhoto = cropThumb($("add-video"), lastAddDetection.detection.box);
    updateSamplesLabel();
    toast(t("sample_captured", { n: addSamples.length }), "ok");
  }
  async function useUploadedPhoto(file) {
    if (!modelsReady) return toast(t("models_still_loading"), "warn");
    stopAddCam();
    const err = $("add-error");
    err.classList.add("hidden");
    try {
      const img = await faceapi.bufferToImage(file);
      const preview = $("add-preview");
      preview.src = img.src;
      preview.classList.remove("hidden");
      $("add-hint").classList.add("hidden");
      const det = await faceapi.detectSingleFace(img, DETECTOR.kind === "ssd" ? new faceapi.SsdMobilenetv1Options({ minConfidence: 0.3 }) : new faceapi.TinyFaceDetectorOptions({ inputSize: 512, scoreThreshold: 0.3 }))
        .withFaceLandmarks(true).withFaceDescriptor();
      if (!det) {
        err.textContent = t("no_face_in_photo");
        err.classList.remove("hidden");
        return;
      }
      addSamples.push(det.descriptor);
      addPhoto = cropThumb(img, det.detection.box);
      updateSamplesLabel();
      toast(t("face_from_photo"), "ok");
    } catch (e) {
      console.error(e);
      err.textContent = t("bad_image");
      err.classList.remove("hidden");
    }
  }
  async function saveStudent(ev) {
    ev.preventDefault();
    const err = $("add-error");
    err.classList.add("hidden");
    const btn = $("btn-add-save");
    btn.disabled = true;
    try {
      const body = {
        name: $("add-name").value.trim(),
        national_id: $("add-no").value.trim(),
        grade: $("add-grade").value.trim(),
        bus_no: $("add-bus").value.trim(),
        parent_phone: $("add-parent").value.trim(),
        photo: addPhoto,
        descriptors: addSamples.map((d) => Array.from(d)),
      };
      if (!body.descriptors.length && !confirm(t("save_without_face"))) {
        return;
      }
      await api("/api/students", { method: "POST", body });
      toast(t("added", { name: body.name }), "ok");
      closeModal("modal-add");
      await loadStudents();
    } catch (e) {
      err.textContent = e.message;
      err.classList.remove("hidden");
    } finally {
      btn.disabled = false;
    }
  }

  // ---------------------------------------------------------------- detail
  async function openDetail(id) {
    const s = students.find((x) => x.id === id);
    if (!s) return;
    detailStudent = s;
    $("detail-photo").outerHTML = avatarHtml(s, true).replace(/^<(\w+)/, '<$1 id="detail-photo"');
    $("detail-name").textContent = s.name;
    $("detail-meta").innerHTML = `<span class="ltr">${escapeHtml(s.national_id)}</span>${s.grade ? " · " + escapeHtml(s.grade) : ""}${s.bus_no ? " · " + t("bus_option", { n: escapeHtml(s.bus_no) }) : ""} · ${s.descriptors && s.descriptors.length ? t("face_samples", { n: s.descriptors.length }) : t("no_face_registered")}`;
    $("detail-status").textContent = s.present_today ? t("present_at", { t: (s.time_today || "").slice(0, 5) }) : t("not_marked");
    $("detail-parent").innerHTML = s.parent_phone
      ? `${t("parent")} <a class="tel ltr" href="tel:${escapeHtml(s.parent_phone.replace(/[^+\d]/g, ""))}">📞 ${escapeHtml(s.parent_phone)}</a>`
      : `${t("parent")} ${t("no_phone")}`;
    $("btn-detail-mark").disabled = !!s.present_today;
    $("detail-history").innerHTML = `<li>${t("loading")}</li>`;
    openModal("modal-detail");
    try {
      const data = await api(`/api/students/${id}/history`);
      $("detail-history").innerHTML = data.records.length
        ? data.records.map((r) => `<li><span>${weekdayName(r.day)} ${hijriDate(r.day)} <span class="ltr muted">(${r.day})</span></span><span><span class="ltr">${r.time.slice(0, 5)}</span> · ${t("method_" + r.method)}</span></li>`).join("")
        : `<li class='muted'>${t("no_history")}</li>`;
    } catch (e) {
      $("detail-history").innerHTML = `<li class='muted'>${escapeHtml(e.message)}</li>`;
    }
  }

  // ---------------------------------------------------------------- modals
  function openModal(id) { $(id).classList.remove("hidden"); }
  function closeModal(id) {
    $(id).classList.add("hidden");
    if (id === "modal-add") stopAddCam();
  }

  // ---------------------------------------------------------------- export
  const WEEK_START = 0; // 0 = Sunday, 1 = Monday
  let period = "daily";
  function isoDate(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }
  function exportRange() {
    if (period === "daily") {
      const d = $("export-day").value || todayStr();
      return { from: d, to: d };
    }
    if (period === "weekly") {
      const d = new Date(($("export-day").value || todayStr()) + "T00:00:00");
      const diff = (d.getDay() - WEEK_START + 7) % 7;
      const from = new Date(d); from.setDate(d.getDate() - diff);
      const to = new Date(from); to.setDate(from.getDate() + 6);
      return { from: isoDate(from), to: isoDate(to) };
    }
    if (period === "monthly") {
      const m = $("export-month").value || todayStr().slice(0, 7);
      const [y, mo] = m.split("-").map(Number);
      const last = new Date(y, mo, 0).getDate();
      return { from: `${m}-01`, to: `${m}-${String(last).padStart(2, "0")}` };
    }
    return { from: $("export-from").value || monthStart(), to: $("export-to").value || todayStr() };
  }
  function setPeriod(p) {
    period = p;
    document.querySelectorAll("#period-seg .seg-btn").forEach((b) => b.classList.toggle("active", b.dataset.period === p));
    $("grp-day").classList.toggle("hidden", !(p === "daily" || p === "weekly"));
    $("grp-month").classList.toggle("hidden", p !== "monthly");
    $("grp-custom").classList.toggle("hidden", p !== "custom");
    $("lbl-day").textContent = t(p === "weekly" ? "week_of" : "day");
    updateExportLinks();
  }
  function updateExportLinks() {
    const { from, to } = exportRange();
    const bus = encodeURIComponent($("export-bus").value || "");
    const q = `from=${from}&to=${to}&bus=${bus}&period=${period}&lang=${getLang()}`;
    $("btn-excel").href = `/api/export/excel?${q}`;
    $("btn-pdf").href = `/api/export/pdf?${q}`;
    $("range-caption").innerHTML = t("range_caption", {
      from: `${weekdayName(from)} ${hijriDate(from)} <span class="ltr">(${from})</span>`,
      to: `${weekdayName(to)} ${hijriDate(to)} <span class="ltr">(${to})</span>`,
    });
  }

  // ---------------------------------------------------------------- wiring
  function wire() {
    // Tabs
    document.querySelectorAll(".tab-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.querySelectorAll(".tab-btn").forEach((b) => b.classList.toggle("active", b === btn));
        document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.id === btn.dataset.tab));
        if (btn.dataset.tab === "tab-scan") { loadPresent(); resumeScanIfWanted(); }
        else { pauseScan(); loadStudents(); }
      });
    });

    // Students tab
    $("search").addEventListener("input", renderStudents);
    $("student-list").addEventListener("click", (e) => {
      const li = e.target.closest("li[data-id]");
      if (li) openDetail(Number(li.dataset.id));
    });
    $("btn-add").addEventListener("click", () => { resetAddForm(); openModal("modal-add"); });
    $("export-day").value = todayStr();
    $("export-month").value = todayStr().slice(0, 7);
    $("export-from").value = monthStart();
    $("export-to").value = todayStr();
    ["export-day", "export-month", "export-from", "export-to", "export-bus"].forEach((id) => $(id).addEventListener("change", updateExportLinks));
    $("period-seg").addEventListener("click", (e) => { const b = e.target.closest("[data-period]"); if (b) setPeriod(b.dataset.period); });
    setPeriod("daily");

    // Bus filter chips (both tabs share the same filter)
    ["bus-chips", "scan-bus-chips"].forEach((id) =>
      $(id).addEventListener("click", (e) => {
        const chip = e.target.closest("[data-bus]");
        if (chip) setBusFilter(chip.dataset.bus);
      })
    );

    // Add student modal
    $("btn-add-cam").addEventListener("click", async () => {
      if (addStream) { addFacing = addFacing === "user" ? "environment" : "user"; stopAddCam(); }
      await startAddCam();
    });
    $("btn-add-capture").addEventListener("click", captureSample);
    $("add-file").addEventListener("change", (e) => { if (e.target.files[0]) useUploadedPhoto(e.target.files[0]); e.target.value = ""; });
    $("form-add").addEventListener("submit", saveStudent);

    // Detail modal
    $("btn-detail-mark").addEventListener("click", async () => {
      if (!detailStudent) return;
      try { await markPresent(detailStudent, "manual"); closeModal("modal-detail"); }
      catch (e) { toast(e.message, "err"); }
    });
    $("btn-detail-delete").addEventListener("click", async () => {
      if (!detailStudent || !confirm(t("confirm_delete", { name: detailStudent.name }))) return;
      try {
        await api(`/api/students/${detailStudent.id}`, { method: "DELETE" });
        toast(t("deleted"));
        closeModal("modal-detail");
        await loadStudents();
      } catch (e) { toast(e.message, "err"); }
    });

    // Close buttons + backdrop
    document.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", () => closeModal(b.dataset.close)));
    document.querySelectorAll(".modal").forEach((m) => m.addEventListener("click", (e) => { if (e.target === m) closeModal(m.id); }));

    // Scan tab
    $("btn-scan-toggle").addEventListener("click", () => (scanStream ? stopScan() : startScan(true)));
    $("btn-scan-flip").addEventListener("click", async () => {
      scanFacing = scanFacing === "environment" ? "user" : "environment";
      if (scanStream) { pauseScan(); await startScan(false); }
    });
    $("present-list").addEventListener("click", async (e) => {
      const btn = e.target.closest("[data-undo]");
      if (!btn) return;
      try {
        await api(`/api/attendance/${btn.dataset.undo}`, { method: "DELETE" });
        toast(t("removed"));
        await Promise.all([loadPresent(), loadStudents()]);
      } catch (err) { toast(err.message, "err"); }
    });
    $("manual-search").addEventListener("input", () => {
      const q = $("manual-search").value.trim().toLowerCase();
      const box = $("manual-results");
      if (!q) { box.innerHTML = ""; return; }
      const rows = visibleStudents().filter((s) => !s.present_today && (s.name.toLowerCase().includes(q) || s.national_id.toLowerCase().includes(q))).slice(0, 6);
      box.innerHTML = rows.map((s) => `
        <li data-manual="${s.id}">
          ${avatarHtml(s)}
          <div class="info"><div class="name">${escapeHtml(s.name)}</div><div class="sub">${busTag(s)}<span class="ltr">${escapeHtml(s.national_id)}</span>${s.grade ? " · " + escapeHtml(s.grade) : ""}</div></div>
          <span class="badge present">${t("mark")}</span>
        </li>`).join("") || `<li><div class="info sub">${t("no_match")}</div></li>`;
    });
    $("manual-results").addEventListener("click", async (e) => {
      const li = e.target.closest("[data-manual]");
      if (!li) return;
      const s = students.find((x) => x.id === Number(li.dataset.manual));
      if (!s) return;
      try { await markPresent(s, "manual"); $("manual-search").value = ""; $("manual-results").innerHTML = ""; }
      catch (err) { toast(err.message, "err"); }
    });

    // Language toggle: re-render everything that is built in JS
    $("btn-lang").addEventListener("click", () => setLang(getLang() === "ar" ? "en" : "ar"));
    document.addEventListener("langchange", () => {
      $("btn-scan-toggle").textContent = scanStream ? t("stop_camera") : t("start_camera");
      $("btn-add-cam").textContent = addStream ? t("flip") : t("camera");
      updateSamplesLabel();
      setPeriod(period);
      renderBusChips();
      renderStudents();
      renderStats();
      loadPresent();
    });
    updateSamplesLabel();

    // Stop cameras when the page is hidden (saves battery, releases the camera)
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) { pauseScan(); stopAddCam(); }
      else { requestWakeLock(); resumeScanIfWanted(); }
    });
    window.addEventListener("pageshow", resumeScanIfWanted);
  }

  // ------------------------------------------------------------------ boot
  wire();
  loadStudents().catch((e) => toast(e.message, "err"));
  loadModels().then(() => {
    let resume = false;
    try { resume = sessionStorage.getItem("resumeScan") === "1"; sessionStorage.removeItem("resumeScan"); } catch (e) { /* ignore */ }
    if (resume) { document.querySelector('.tab-btn[data-tab="tab-scan"]').click(); startScan(true); }
  });
})();
