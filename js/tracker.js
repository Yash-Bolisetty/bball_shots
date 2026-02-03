/* ===== tracker.js — Live tracking: sensors, waveform, court, session management ===== */

const Tracker = (() => {
  // State
  let session = null;
  let isRecording = false;
  let buffer = new IMUBuffer();
  let shotDetector = new ShotDetector();
  let movementDetector = new MovementDetector();
  let startTime = 0;
  let timerInterval = null;

  // Position state
  let courtPos = { x: 0, y: 0 };
  let gpsWatchId = null;
  let lastGPS = null;

  // Calibration state
  let calibrating = false;
  let calibrationTarget = null;
  let calibrationSamples = [];
  let calibrationTimeout = null;
  let gpsCalibration = { rim: null, top3: null, left: null, right: null };

  // Motion calibration state
  const CALIB_STEPS = [
    { key: 'walking',   label: 'Walking',            instruction: 'Walk normally with phone in pocket', duration: 10 },
    { key: 'running',   label: 'Running',             instruction: 'Jog or run with phone in pocket',   duration: 10 },
    { key: 'dribbling', label: 'Dribbling + Running', instruction: 'Dribble with right hand while moving, phone in left pocket', duration: 10 },
    { key: 'shooting',  label: 'Shooting',            instruction: 'Take 3-5 jump shots at normal pace', duration: 20 },
  ];
  let motionCalActive = false;
  let motionCalStep = -1;
  let motionCalBuffers = {};  // key -> imu sample array
  let motionCalTimer = null;
  let motionCalCountdown = 0;
  let motionCalStartTime = 0;

  // Waveform state
  let waveformCanvas, waveformCtx;
  let waveformData = []; // last ~10s of aMag values for drawing

  // Court canvas
  let courtCanvas, courtCtx;

  // DOM refs
  let dpr = 1;

  // ===== Init =====
  function init() {
    waveformCanvas = document.getElementById('waveform-canvas');
    courtCanvas = document.getElementById('court-canvas');
    dpr = window.devicePixelRatio || 1;

    setupControls();
    setupDropdowns();
    setupZoneConfirm();
    resizeCanvases();
    drawCourt();

    window.addEventListener('resize', () => {
      resizeCanvases();
      drawCourt();
    });
  }

  function onShow() {
    resizeCanvases();
    drawCourt();
    renderWaveform();
  }

  function resizeCanvases() {
    dpr = window.devicePixelRatio || 1;

    if (waveformCanvas) {
      const w = waveformCanvas.clientWidth;
      const h = waveformCanvas.clientHeight;
      waveformCanvas.width = w * dpr;
      waveformCanvas.height = h * dpr;
      waveformCtx = waveformCanvas.getContext('2d');
      waveformCtx.scale(dpr, dpr);
    }

    if (courtCanvas) {
      const w = courtCanvas.clientWidth;
      const h = courtCanvas.clientHeight;
      courtCanvas.width = w * dpr;
      courtCanvas.height = h * dpr;
      courtCtx = courtCanvas.getContext('2d');
      courtCtx.scale(dpr, dpr);
    }
  }

  // ===== Controls =====
  function setupControls() {
    document.getElementById('btn-start').addEventListener('click', toggleRecording);
    document.getElementById('btn-export').addEventListener('click', exportSession);
    document.getElementById('btn-motion-cal').addEventListener('click', startMotionCal);
    document.getElementById('cal-skip').addEventListener('click', skipMotionCalStep);
    document.getElementById('cal-cancel').addEventListener('click', cancelMotionCal);
    document.getElementById('cal-result-ok').addEventListener('click', closeCalResult);
    document.getElementById('cal-result-clear').addEventListener('click', clearCalResult);
  }

  function toggleRecording() {
    if (isRecording) {
      stopRecording();
    } else {
      startRecording();
    }
  }

  async function startRecording() {
    // Request motion permission on iOS
    if (typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function') {
      try {
        const perm = await DeviceMotionEvent.requestPermission();
        if (perm !== 'granted') {
          alert('Motion sensor permission denied.');
          return;
        }
      } catch (err) {
        alert('Motion permission error: ' + err.message);
        return;
      }
    }

    // Reset state
    session = new Session();
    buffer = new IMUBuffer();
    shotDetector = new ShotDetector();
    movementDetector = new MovementDetector();
    waveformData = [];
    courtPos = { x: 0, y: 0 };
    gpsCalibration = { rim: null, top3: null, left: null, right: null };

    startTime = Date.now();
    isRecording = true;

    // UI updates
    const btn = document.getElementById('btn-start');
    btn.textContent = 'STOP';
    btn.classList.remove('btn-primary');
    btn.classList.add('btn-danger');
    document.getElementById('recording-dot').classList.remove('hidden');
    document.getElementById('btn-calibrate').disabled = false;
    document.getElementById('btn-anchor').disabled = false;
    document.getElementById('btn-export').disabled = false;
    document.getElementById('btn-motion-cal').disabled = false;

    // Load calibration if available
    const cal = MotionCalibrator.load();
    if (cal) {
      shotDetector.calibration = cal;
    }

    // Clear shot log
    document.getElementById('shot-log-list').innerHTML = '';
    document.getElementById('stat-shots').textContent = '0';

    // Start timer
    timerInterval = setInterval(updateTimer, 1000);

    // Start sensors
    window.addEventListener('devicemotion', onDeviceMotion);
    startGPS();

    // Start render loop
    requestAnimationFrame(renderLoop);
  }

  function stopRecording() {
    isRecording = false;

    const btn = document.getElementById('btn-start');
    btn.textContent = 'START';
    btn.classList.remove('btn-danger');
    btn.classList.add('btn-primary');
    document.getElementById('recording-dot').classList.add('hidden');
    document.getElementById('btn-calibrate').disabled = true;
    document.getElementById('btn-anchor').disabled = true;
    document.getElementById('btn-motion-cal').disabled = true;

    clearInterval(timerInterval);
    window.removeEventListener('devicemotion', onDeviceMotion);
    stopGPS();
    stopCalibration();
    cancelMotionCal();
  }

  function updateTimer() {
    const elapsed = Date.now() - startTime;
    document.getElementById('session-timer').textContent = formatTime(elapsed);
  }

  // ===== Device Motion =====
  function onDeviceMotion(e) {
    if (!isRecording) return;

    const acc = e.accelerationIncludingGravity;
    if (!acc || acc.x === null) return;

    const now = Date.now();
    const ax = acc.x;
    const ay = acc.y;
    const az = acc.z;
    const aMag = Math.sqrt(ax * ax + ay * ay + az * az);

    const rot = e.rotationRate || {};
    const gx = rot.alpha || 0;
    const gy = rot.beta || 0;
    const gz = rot.gamma || 0;

    // Movement detection
    const moving = movementDetector.processSample(aMag, now);

    const sample = {
      t: now,
      tRel: now - startTime,
      ax, ay, az, aMag,
      gx: gx * (Math.PI / 180), // convert deg/s to rad/s
      gy: gy * (Math.PI / 180),
      gz: gz * (Math.PI / 180),
      moving,
    };

    buffer.push(sample);
    session.addIMU(sample);

    // Route to motion calibration buffer if active
    if (motionCalActive && motionCalStep >= 0 && motionCalStep < CALIB_STEPS.length) {
      const stepKey = CALIB_STEPS[motionCalStep].key;
      if (!motionCalBuffers[stepKey]) motionCalBuffers[stepKey] = [];
      motionCalBuffers[stepKey].push(sample);
    }

    // Track movement transitions
    const prevMoving = buffer.length > 1 ? buffer.get(buffer.length - 2)?.moving : moving;
    if (prevMoving !== moving) {
      session.addEvent({
        type: 'movement_change',
        t: now,
        tRel: now - startTime,
        from: prevMoving ? 'moving' : 'stationary',
        to: moving ? 'moving' : 'stationary',
      });
    }

    // Waveform data (keep ~500 samples for display)
    waveformData.push({ aMag, t: now });
    if (waveformData.length > 500) waveformData.shift();

    // Shot detection
    const shot = shotDetector.processSample(buffer, now);
    if (shot) {
      onShotDetected(shot, now);
    }

    // GPS calibration sampling
    if (calibrating && lastGPS) {
      calibrationSamples.push({ lat: lastGPS.lat, lng: lastGPS.lng });
    }

    // Update movement UI
    updateMovementUI(moving);
  }

  // ===== Shot Detected =====
  function onShotDetected(detection, now) {
    const zone = classifyZone(courtPos.x, courtPos.y);
    const dist = Math.sqrt(courtPos.x * courtPos.x + courtPos.y * courtPos.y);
    const color = zoneColor(zone);

    const shotData = {
      x: courtPos.x,
      y: courtPos.y,
      zone,
      color,
      dist,
      mag: detection.mag,
      idx: detection.idx,
      dipMag: detection.dipMag,
      recoveryMag: detection.recoveryMag,
      range: detection.range,
    };

    session.addShot(shotData);

    session.addEvent({
      type: 'shot',
      t: now,
      tRel: now - startTime,
      courtPos: { x: courtPos.x, y: courtPos.y },
      zone,
      userConfirmed: false,
      magnitude: detection.mag,
      dipMagnitude: detection.dipMag,
      recoveryMagnitude: detection.recoveryMag,
      peakToDipRange: detection.range,
      movementState: movementDetector.isMoving ? 'moving' : 'stationary',
    });

    // Haptic feedback
    if (navigator.vibrate) navigator.vibrate(100);

    // Update UI
    document.getElementById('stat-shots').textContent = session.shots.length;
    addShotLogEntry(shotData, session.shots.length);
    showZoneConfirmation(zone, color, session.shots.length - 1);
    drawCourt();
  }

  function addShotLogEntry(shot, num) {
    const list = document.getElementById('shot-log-list');
    const div = document.createElement('div');
    div.className = 'shot-log-item';
    const elapsed = formatTime(Date.now() - startTime);
    div.innerHTML = `
      <div class="shot-log-num" style="background:${shot.color}">${num}</div>
      <div class="shot-log-zone">${shot.zone}</div>
      <div class="shot-log-mag">pk:${shot.mag.toFixed(1)} dip:${shot.dipMag.toFixed(1)}</div>
      <div class="shot-log-time">${elapsed}</div>
    `;
    list.insertBefore(div, list.firstChild);
  }

  // ===== Zone Confirmation =====
  let zoneConfirmTimer = null;

  function setupZoneConfirm() {
    document.getElementById('zone-confirm-yes').addEventListener('click', () => {
      hideZoneConfirmation(true);
    });
    document.getElementById('zone-confirm-no').addEventListener('click', () => {
      hideZoneConfirmation(false);
    });
  }

  let pendingConfirmShotIdx = -1;

  function showZoneConfirmation(zone, color, shotIdx) {
    pendingConfirmShotIdx = shotIdx;
    const el = document.getElementById('zone-confirm');
    const zoneEl = document.getElementById('zone-confirm-zone');
    zoneEl.textContent = zone;
    zoneEl.style.color = color;

    // Reset timer animation
    const timerEl = document.getElementById('zone-confirm-timer');
    timerEl.style.animation = 'none';
    void timerEl.offsetHeight; // trigger reflow
    timerEl.style.animation = 'timerShrink 3s linear forwards';

    el.classList.remove('hidden');

    clearTimeout(zoneConfirmTimer);
    zoneConfirmTimer = setTimeout(() => {
      hideZoneConfirmation(null); // auto-dismiss = no explicit confirmation
    }, 3000);
  }

  function hideZoneConfirmation(confirmed) {
    clearTimeout(zoneConfirmTimer);
    document.getElementById('zone-confirm').classList.add('hidden');

    if (confirmed !== null && pendingConfirmShotIdx >= 0 && pendingConfirmShotIdx < session.events.length) {
      // Find the corresponding shot event and update
      const shotEvents = session.events.filter(e => e.type === 'shot');
      const lastShotEvent = shotEvents[shotEvents.length - 1];
      if (lastShotEvent) {
        lastShotEvent.userConfirmed = confirmed;
      }
    }
    pendingConfirmShotIdx = -1;
  }

  // ===== Movement UI =====
  function updateMovementUI(moving) {
    const icon = document.getElementById('movement-icon');
    const progress = document.getElementById('movement-progress');
    const label = document.getElementById('movement-label');

    const intensity = movementDetector.intensity;
    progress.style.width = (intensity * 100) + '%';

    if (!moving) {
      icon.textContent = '\u26AB'; // black circle
      label.textContent = 'Still';
      progress.style.background = 'var(--text-dim)';
    } else if (intensity < 0.5) {
      icon.textContent = '\uD83D\uDEB6'; // walking
      label.textContent = 'Walk';
      progress.style.background = 'var(--green)';
    } else {
      icon.textContent = '\uD83C\uDFC3'; // running
      label.textContent = 'Run';
      progress.style.background = 'var(--orange)';
    }
  }

  // ===== GPS =====
  function startGPS() {
    if (!navigator.geolocation) return;
    gpsWatchId = navigator.geolocation.watchPosition(
      (pos) => {
        const now = Date.now();
        lastGPS = {
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          acc: pos.coords.accuracy,
        };

        session.addGPS({
          t: now,
          tRel: now - startTime,
          lat: lastGPS.lat,
          lng: lastGPS.lng,
          acc: lastGPS.acc,
        });

        // Update GPS stat
        document.getElementById('stat-gps').textContent = lastGPS.acc.toFixed(0) + 'm';

        // Update court position if we have calibration
        updateCourtPosition();
      },
      (err) => {
        document.getElementById('stat-gps').textContent = 'N/A';
      },
      { enableHighAccuracy: true, maximumAge: 1000 }
    );
  }

  function stopGPS() {
    if (gpsWatchId !== null) {
      navigator.geolocation.clearWatch(gpsWatchId);
      gpsWatchId = null;
    }
  }

  function updateCourtPosition() {
    if (!lastGPS || !gpsCalibration.rim) return;

    // Simple GPS → court projection using rim calibration
    // We need at least rim + one other point for rotation
    const rimGPS = gpsCalibration.rim;

    // Meters per degree (approximate)
    const latScale = 111320;
    const lngScale = 111320 * Math.cos(rimGPS.lat * Math.PI / 180);

    const dx = (lastGPS.lng - rimGPS.lng) * lngScale;
    const dy = (lastGPS.lat - rimGPS.lat) * latScale;

    // If we have top3, compute rotation
    let angle = 0;
    if (gpsCalibration.top3) {
      const t3 = gpsCalibration.top3;
      const t3dx = (t3.lng - rimGPS.lng) * lngScale;
      const t3dy = (t3.lat - rimGPS.lat) * latScale;
      angle = Math.atan2(t3dx, t3dy); // angle from N to court-Y
    }

    // Rotate
    const cosA = Math.cos(-angle);
    const sinA = Math.sin(-angle);
    courtPos.x = dx * cosA - dy * sinA;
    courtPos.y = dx * sinA + dy * cosA;

    // Update stats
    const dist = Math.sqrt(courtPos.x * courtPos.x + courtPos.y * courtPos.y);
    const zone = classifyZone(courtPos.x, courtPos.y);
    document.getElementById('stat-dist').textContent = dist.toFixed(1) + 'm';
    document.getElementById('stat-zone').textContent = zone;
  }

  // ===== Calibration & Anchors =====
  function setupDropdowns() {
    // Calibrate dropdown
    const calBtn = document.getElementById('btn-calibrate');
    const calMenu = document.getElementById('calibrate-menu');

    calBtn.addEventListener('click', () => {
      calMenu.classList.toggle('open');
      document.getElementById('anchor-menu').classList.remove('open');
    });

    calMenu.querySelectorAll('button').forEach(btn => {
      btn.addEventListener('click', () => {
        startCalibration(btn.dataset.cal);
        calMenu.classList.remove('open');
      });
    });

    // Anchor dropdown
    const ancBtn = document.getElementById('btn-anchor');
    const ancMenu = document.getElementById('anchor-menu');

    ancBtn.addEventListener('click', () => {
      ancMenu.classList.toggle('open');
      document.getElementById('calibrate-menu').classList.remove('open');
    });

    ancMenu.querySelectorAll('button').forEach(btn => {
      btn.addEventListener('click', () => {
        setAnchor(btn.dataset.anchor);
        ancMenu.classList.remove('open');
      });
    });

    // Close dropdowns on outside click
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.dropdown')) {
        calMenu.classList.remove('open');
        ancMenu.classList.remove('open');
      }
    });
  }

  function startCalibration(target) {
    if (!lastGPS) {
      alert('No GPS signal yet. Wait for GPS lock.');
      return;
    }

    calibrating = true;
    calibrationTarget = target;
    calibrationSamples = [];

    // Visual feedback
    const btn = document.getElementById('btn-calibrate');
    btn.textContent = 'Sampling...';
    btn.disabled = true;

    // Collect GPS for 10 seconds
    calibrationTimeout = setTimeout(() => {
      finishCalibration();
    }, 10000);
  }

  function finishCalibration() {
    calibrating = false;
    const btn = document.getElementById('btn-calibrate');
    btn.textContent = 'Calibrate';
    btn.disabled = false;

    if (calibrationSamples.length === 0) {
      alert('No GPS samples collected during calibration.');
      return;
    }

    // Median filter
    const medLat = median(calibrationSamples.map(s => s.lat));
    const medLng = median(calibrationSamples.map(s => s.lng));

    gpsCalibration[calibrationTarget] = { lat: medLat, lng: medLng };
    session.gpsCalibration[calibrationTarget] = { lat: medLat, lng: medLng };

    updateCourtPosition();
    drawCourt();
  }

  function stopCalibration() {
    if (calibrationTimeout) {
      clearTimeout(calibrationTimeout);
      calibrating = false;
      const btn = document.getElementById('btn-calibrate');
      btn.textContent = 'Calibrate';
    }
  }

  function setAnchor(target) {
    const pos = COURT[target];
    if (!pos) return;

    courtPos = { x: pos.x, y: pos.y };

    session.addEvent({
      type: 'anchor',
      t: Date.now(),
      tRel: Date.now() - startTime,
      target,
      courtPos: { ...courtPos },
    });

    const dist = Math.sqrt(courtPos.x * courtPos.x + courtPos.y * courtPos.y);
    const zone = classifyZone(courtPos.x, courtPos.y);
    document.getElementById('stat-dist').textContent = dist.toFixed(1) + 'm';
    document.getElementById('stat-zone').textContent = zone;

    drawCourt();
  }

  // ===== Motion Calibration Flow =====
  function startMotionCal() {
    if (!isRecording || motionCalActive) return;
    motionCalActive = true;
    motionCalStep = -1;
    motionCalBuffers = {};
    advanceMotionCalStep();
  }

  function advanceMotionCalStep() {
    motionCalStep++;
    if (motionCalStep >= CALIB_STEPS.length) {
      finishMotionCal();
      return;
    }

    const step = CALIB_STEPS[motionCalStep];
    motionCalCountdown = step.duration;
    motionCalStartTime = Date.now();
    motionCalBuffers[step.key] = [];

    // Update UI
    const overlay = document.getElementById('cal-overlay');
    overlay.classList.remove('hidden');

    document.getElementById('cal-step-title').textContent = step.label;
    document.getElementById('cal-step-instruction').textContent = step.instruction;
    document.getElementById('cal-countdown').textContent = motionCalCountdown;
    document.getElementById('cal-progress-bar').style.width = '0%';

    // Update step dots
    const dots = overlay.querySelectorAll('.cal-step-dot');
    dots.forEach((dot, idx) => {
      dot.classList.remove('active', 'done');
      if (idx < motionCalStep) dot.classList.add('done');
      else if (idx === motionCalStep) dot.classList.add('active');
    });

    // Haptic feedback for step start
    if (navigator.vibrate) navigator.vibrate([50, 50, 50]);

    // Start countdown timer
    clearInterval(motionCalTimer);
    motionCalTimer = setInterval(updateMotionCalCountdown, 1000);
  }

  function updateMotionCalCountdown() {
    const step = CALIB_STEPS[motionCalStep];
    if (!step) return;

    const elapsed = (Date.now() - motionCalStartTime) / 1000;
    motionCalCountdown = Math.max(0, Math.ceil(step.duration - elapsed));

    document.getElementById('cal-countdown').textContent = motionCalCountdown;
    const progress = Math.min(100, (elapsed / step.duration) * 100);
    document.getElementById('cal-progress-bar').style.width = progress + '%';

    if (motionCalCountdown <= 0) {
      clearInterval(motionCalTimer);
      if (navigator.vibrate) navigator.vibrate(100);
      // Brief pause then advance
      setTimeout(advanceMotionCalStep, 300);
    }
  }

  function skipMotionCalStep() {
    clearInterval(motionCalTimer);
    // Keep whatever data was collected (could be empty)
    advanceMotionCalStep();
  }

  function cancelMotionCal() {
    if (!motionCalActive) return;
    clearInterval(motionCalTimer);
    motionCalActive = false;
    motionCalStep = -1;
    motionCalBuffers = {};
    document.getElementById('cal-overlay').classList.add('hidden');
  }

  function finishMotionCal() {
    clearInterval(motionCalTimer);
    motionCalActive = false;
    document.getElementById('cal-overlay').classList.add('hidden');

    // Run calibration
    const cal = MotionCalibrator.calibrate(
      motionCalBuffers.walking || [],
      motionCalBuffers.running || [],
      motionCalBuffers.dribbling || [],
      motionCalBuffers.shooting || []
    );

    // Set on active detector
    shotDetector.calibration = cal;

    // Haptic: done
    if (navigator.vibrate) navigator.vibrate([100, 50, 100]);

    // Show result modal
    showCalResult(cal);
  }

  function showCalResult(cal) {
    const body = document.getElementById('cal-result-body');
    let html = '';

    for (const step of CALIB_STEPS) {
      const count = cal.patternCounts[step.key] || 0;
      const countClass = count === 0 ? 'zero' : '';
      html += `<div class="cal-result-row">
        <span class="cal-result-label">${step.label}</span>
        <span class="cal-result-count ${countClass}">${count} pattern${count !== 1 ? 's' : ''}</span>
      </div>`;
    }

    const hasShots = (cal.patternCounts.shooting || 0) > 0;
    html += `<div style="text-align:center; margin-top:12px;">
      <span class="cal-status-badge ${hasShots ? 'active' : 'none'}">
        ${hasShots ? 'Calibration Active' : 'No shooting patterns found'}
      </span>
    </div>`;

    body.innerHTML = html;
    document.getElementById('cal-result-modal').classList.remove('hidden');
  }

  function closeCalResult() {
    document.getElementById('cal-result-modal').classList.add('hidden');
  }

  function clearCalResult() {
    MotionCalibrator.clear();
    shotDetector.calibration = null;
    document.getElementById('cal-result-modal').classList.add('hidden');
  }

  // ===== Render Loop =====
  function renderLoop() {
    if (!isRecording) return;
    renderWaveform();
    requestAnimationFrame(renderLoop);
  }

  // ===== Waveform Rendering =====
  function renderWaveform() {
    if (!waveformCtx) return;
    const w = waveformCanvas.clientWidth;
    const h = waveformCanvas.clientHeight;
    const ctx = waveformCtx;

    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#111';
    ctx.fillRect(0, 0, w, h);

    if (waveformData.length < 2) return;

    // Y range: fixed 0-30 for consistency
    const yMin = 0;
    const yMax = 30;
    const yRange = yMax - yMin;

    const toY = (val) => h - ((val - yMin) / yRange) * (h - 10) - 5;

    // Grid lines at key thresholds
    ctx.setLineDash([3, 3]);
    ctx.lineWidth = 1;

    // 14 m/s² line
    ctx.strokeStyle = 'rgba(239, 68, 68, 0.3)';
    ctx.beginPath();
    ctx.moveTo(0, toY(14));
    ctx.lineTo(w, toY(14));
    ctx.stroke();

    // 8 m/s² line
    ctx.strokeStyle = 'rgba(34, 197, 94, 0.3)';
    ctx.beginPath();
    ctx.moveTo(0, toY(8));
    ctx.lineTo(w, toY(8));
    ctx.stroke();

    // ~10 m/s² (gravity baseline)
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
    ctx.beginPath();
    ctx.moveTo(0, toY(9.8));
    ctx.lineTo(w, toY(9.8));
    ctx.stroke();

    ctx.setLineDash([]);

    // Draw signal
    ctx.strokeStyle = '#aaa';
    ctx.lineWidth = 1.5;
    ctx.beginPath();

    const len = waveformData.length;
    for (let i = 0; i < len; i++) {
      const x = (i / len) * w;
      const y = toY(waveformData[i].aMag);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Draw shot markers (vertical lines for shots that occurred in this window)
    if (session) {
      const windowStart = waveformData[0].t;
      const windowEnd = waveformData[len - 1].t;

      for (let i = 0; i < session.shots.length; i++) {
        // Get shot time from events
        const shotEvents = session.events.filter(e => e.type === 'shot');
        const shotEvent = shotEvents[i];
        if (!shotEvent) continue;

        if (shotEvent.t >= windowStart && shotEvent.t <= windowEnd) {
          const ratio = (shotEvent.t - windowStart) / (windowEnd - windowStart);
          const x = ratio * w;
          const color = session.shots[i].color || '#fff';

          ctx.strokeStyle = color;
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(x, 0);
          ctx.lineTo(x, h);
          ctx.stroke();

          // Label
          ctx.fillStyle = color;
          ctx.font = 'bold 10px sans-serif';
          ctx.textAlign = 'center';
          ctx.fillText('#' + (i + 1), x, 12);
        }
      }
    }

    // Y-axis labels
    ctx.fillStyle = '#555';
    ctx.font = '9px sans-serif';
    ctx.textAlign = 'left';
    for (let val = 5; val <= 25; val += 5) {
      ctx.fillText(val + '', 2, toY(val) - 2);
    }
  }

  // ===== Court Drawing =====
  function drawCourt() {
    if (!courtCtx) return;
    const w = courtCanvas.clientWidth;
    const h = courtCanvas.clientHeight;
    const ctx = courtCtx;

    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#1a1a1a';
    ctx.fillRect(0, 0, w, h);

    // Court dimensions in meters
    // Half court: 15.24m long, 14.63m wide
    // We show from baseline to ~3m past 3-point line
    const courtWidth = 15.0;  // meters to show width
    const courtHeight = 12.0; // meters to show depth

    // Scale: fit court into canvas
    const scale = Math.min(w / courtWidth, h / courtHeight) * 0.85;
    const cx = w / 2; // center X
    const by = h - 20; // baseline Y (bottom)

    const toCanvasX = (mx) => cx + mx * scale;
    const toCanvasY = (my) => by - my * scale;

    // Court outline
    ctx.strokeStyle = '#333';
    ctx.lineWidth = 1;

    // Baseline
    ctx.beginPath();
    ctx.moveTo(toCanvasX(-7.3), toCanvasY(0));
    ctx.lineTo(toCanvasX(7.3), toCanvasY(0));
    ctx.stroke();

    // Lane / paint (5.8m wide, 5.8m deep)
    ctx.strokeStyle = '#333';
    ctx.strokeRect(
      toCanvasX(-2.44), toCanvasY(0),
      4.88 * scale, -5.8 * scale
    );

    // Free throw circle (1.83m radius)
    ctx.beginPath();
    ctx.arc(toCanvasX(0), toCanvasY(5.8), 1.83 * scale, 0, Math.PI * 2);
    ctx.stroke();

    // Three-point arc
    ctx.beginPath();
    // Left corner straight
    ctx.moveTo(toCanvasX(-6.7), toCanvasY(0));
    ctx.lineTo(toCanvasX(-6.7), toCanvasY(0.9));
    // Arc
    const arcRadius = 7.24 * scale;
    const startAngle = Math.PI + Math.asin(6.7 / 7.24);
    const endAngle = -Math.asin(6.7 / 7.24);
    ctx.arc(toCanvasX(0), toCanvasY(0), arcRadius, startAngle, endAngle);
    // Right corner straight
    ctx.lineTo(toCanvasX(6.7), toCanvasY(0));
    ctx.stroke();

    // Rim
    ctx.fillStyle = '#ef4444';
    ctx.beginPath();
    ctx.arc(toCanvasX(0), toCanvasY(0), 4, 0, Math.PI * 2);
    ctx.fill();

    // Backboard
    ctx.strokeStyle = '#666';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(toCanvasX(-0.9), toCanvasY(-0.3));
    ctx.lineTo(toCanvasX(0.9), toCanvasY(-0.3));
    ctx.stroke();

    // Reference points
    const refs = [
      { pos: COURT.ft, label: 'FT' },
      { pos: COURT.top3, label: 'T3' },
      { pos: COURT.left3, label: 'L3' },
      { pos: COURT.right3, label: 'R3' },
    ];

    ctx.fillStyle = '#444';
    ctx.font = '9px sans-serif';
    ctx.textAlign = 'center';
    for (const ref of refs) {
      const rx = toCanvasX(ref.pos.x);
      const ry = toCanvasY(ref.pos.y);
      ctx.fillText(ref.label, rx, ry - 6);
      ctx.fillStyle = '#555';
      ctx.beginPath();
      ctx.arc(rx, ry, 2, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#444';
    }

    // Shot dots
    if (session) {
      for (let i = 0; i < session.shots.length; i++) {
        const shot = session.shots[i];
        const sx = toCanvasX(shot.x);
        const sy = toCanvasY(shot.y);

        ctx.fillStyle = shot.color || '#fff';
        ctx.beginPath();
        ctx.arc(sx, sy, 6, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = '#fff';
        ctx.font = 'bold 8px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('' + (i + 1), sx, sy);
      }
    }

    // Player position (current)
    if (isRecording) {
      const px = toCanvasX(courtPos.x);
      const py = toCanvasY(courtPos.y);

      ctx.strokeStyle = '#3b82f6';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(px, py, 8, 0, Math.PI * 2);
      ctx.stroke();

      // Crosshair
      ctx.beginPath();
      ctx.moveTo(px - 4, py);
      ctx.lineTo(px + 4, py);
      ctx.moveTo(px, py - 4);
      ctx.lineTo(px, py + 4);
      ctx.stroke();
    }

    ctx.textBaseline = 'alphabetic';
  }

  // ===== Export =====
  function exportSession() {
    if (!session) return;
    const data = session.toJSON();
    const filename = session.sessionId + '.json';
    downloadJSON(data, filename);
  }

  return { init, onShow };
})();
