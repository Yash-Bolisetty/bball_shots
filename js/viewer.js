/* ===== viewer.js — Data viewer: signal chart, shot editor, segment annotation ===== */

const Viewer = (() => {
  // State
  let session = null;
  let shots = [];        // working copy of shots (editable)
  let segments = [];     // user-labeled segments
  let undoStack = [];
  let selectedShotIdx = -1;
  let mode = 'normal';   // 'normal' | 'addShot' | 'addSegment'
  let segmentStart = null;

  // Chart state
  let viewStart = 0;     // sample index of left edge
  let viewEnd = 0;       // sample index of right edge
  let aMags = [];
  let totalSamples = 0;

  // DOM refs
  let signalCanvas, signalCtx, minimapCanvas, minimapCtx;
  let dpr = 1;

  // Interaction state
  let isDragging = false;
  let dragStartX = 0;
  let dragStartView = 0;
  let pinchStartDist = 0;
  let pinchStartRange = 0;
  // Minimap drag
  let minimapDragging = false;

  // ===== Init =====
  function init() {
    signalCanvas = document.getElementById('signal-canvas');
    minimapCanvas = document.getElementById('minimap-canvas');
    dpr = window.devicePixelRatio || 1;

    setupFileLoader();
    setupToolbar();
    setupPanelTabs();
    setupChartInteraction();
    setupModals();
  }

  function onShow() {
    if (session) {
      resizeCanvases();
      renderAll();
    }
  }

  // ===== File Loading =====
  function setupFileLoader() {
    const dropZone = document.getElementById('drop-zone');
    const fileInput = document.getElementById('file-input');
    const btnPick = document.getElementById('btn-pick-file');

    btnPick.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', (e) => {
      if (e.target.files[0]) loadFile(e.target.files[0]);
    });

    dropZone.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropZone.classList.add('drag-over');
    });
    dropZone.addEventListener('dragleave', () => {
      dropZone.classList.remove('drag-over');
    });
    dropZone.addEventListener('drop', (e) => {
      e.preventDefault();
      dropZone.classList.remove('drag-over');
      if (e.dataTransfer.files[0]) loadFile(e.dataTransfer.files[0]);
    });
  }

  function loadFile(file) {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = JSON.parse(e.target.result);
        loadSession(data, file.name);
      } catch (err) {
        alert('Failed to parse JSON: ' + err.message);
      }
    };
    reader.readAsText(file);
  }

  function loadSession(data, filename) {
    session = Session.fromJSON(data);
    aMags = session.imu.map(s => s.aMag);
    totalSamples = aMags.length;

    // Run shot detection on loaded data
    const detector = new ShotDetector();
    const detected = detector.detectAll(session.imu);

    // Use existing shots if they seem to match, otherwise use detected
    if (session.shots.length > 0 && session.shots[0].idx !== undefined) {
      shots = session.shots.map((s, i) => ({
        ...s,
        num: i + 1,
        confirmed: true,
        deleted: false,
      }));
    } else {
      shots = detected.map((s, i) => ({
        ...s,
        x: 0, y: 0,
        zone: 'RIM',
        color: zoneColor('RIM'),
        dist: 0,
        num: i + 1,
        confirmed: false,
        deleted: false,
      }));
    }

    segments = session.segments ? [...session.segments] : [];
    undoStack = [];
    selectedShotIdx = -1;
    mode = 'normal';

    // Set view to full signal
    viewStart = 0;
    viewEnd = totalSamples;

    // Show content, hide loader
    document.getElementById('viewer-loader').classList.add('hidden');
    document.getElementById('viewer-content').classList.remove('hidden');
    document.getElementById('viewer-filename').textContent = filename || session.sessionId;
    document.getElementById('btn-undo').disabled = true;

    resizeCanvases();
    renderAll();
  }

  // ===== Canvas Setup =====
  function resizeCanvases() {
    if (!signalCanvas) return;
    dpr = window.devicePixelRatio || 1;

    // Signal canvas
    const sw = signalCanvas.clientWidth;
    const sh = signalCanvas.clientHeight;
    signalCanvas.width = sw * dpr;
    signalCanvas.height = sh * dpr;
    signalCtx = signalCanvas.getContext('2d');
    signalCtx.scale(dpr, dpr);

    // Minimap canvas
    const mw = minimapCanvas.clientWidth;
    const mh = minimapCanvas.clientHeight;
    minimapCanvas.width = mw * dpr;
    minimapCanvas.height = mh * dpr;
    minimapCtx = minimapCanvas.getContext('2d');
    minimapCtx.scale(dpr, dpr);
  }

  // ===== Rendering =====
  function renderAll() {
    renderMinimap();
    renderSignal();
    renderShotList();
    renderSegmentList();
  }

  function renderMinimap() {
    if (!minimapCtx || totalSamples === 0) return;
    const w = minimapCanvas.clientWidth;
    const h = minimapCanvas.clientHeight;
    const ctx = minimapCtx;

    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#111';
    ctx.fillRect(0, 0, w, h);

    // Draw full signal
    const step = Math.max(1, Math.floor(totalSamples / w));
    ctx.strokeStyle = '#555';
    ctx.lineWidth = 1;
    ctx.beginPath();

    // Compute min/max for scaling
    let minVal = Infinity, maxVal = -Infinity;
    for (let i = 0; i < totalSamples; i++) {
      if (aMags[i] < minVal) minVal = aMags[i];
      if (aMags[i] > maxVal) maxVal = aMags[i];
    }
    const range = maxVal - minVal || 1;

    for (let px = 0; px < w; px++) {
      const sampleIdx = Math.floor((px / w) * totalSamples);
      const val = aMags[Math.min(sampleIdx, totalSamples - 1)];
      const y = h - ((val - minVal) / range) * (h - 4) - 2;
      if (px === 0) ctx.moveTo(px, y);
      else ctx.lineTo(px, y);
    }
    ctx.stroke();

    // Draw shot markers on minimap
    for (const shot of shots) {
      if (shot.deleted) continue;
      const px = (shot.idx / totalSamples) * w;
      ctx.fillStyle = shot.color || zoneColor(shot.zone);
      ctx.fillRect(px - 1, 0, 2, h);
    }

    // Draw viewport indicator
    const vx1 = (viewStart / totalSamples) * w;
    const vx2 = (viewEnd / totalSamples) * w;
    ctx.fillStyle = 'rgba(59, 130, 246, 0.2)';
    ctx.fillRect(vx1, 0, vx2 - vx1, h);
    ctx.strokeStyle = 'rgba(59, 130, 246, 0.6)';
    ctx.lineWidth = 1;
    ctx.strokeRect(vx1, 0, vx2 - vx1, h);
  }

  function renderSignal() {
    if (!signalCtx || totalSamples === 0) return;
    const w = signalCanvas.clientWidth;
    const h = signalCanvas.clientHeight;
    const ctx = signalCtx;

    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#111';
    ctx.fillRect(0, 0, w, h);

    const vStart = Math.max(0, Math.floor(viewStart));
    const vEnd = Math.min(totalSamples, Math.ceil(viewEnd));
    const viewRange = vEnd - vStart;
    if (viewRange <= 0) return;

    // Compute local min/max for y-scaling
    let minVal = Infinity, maxVal = -Infinity;
    for (let i = vStart; i < vEnd; i++) {
      if (aMags[i] < minVal) minVal = aMags[i];
      if (aMags[i] > maxVal) maxVal = aMags[i];
    }
    // Add some padding
    const padding = (maxVal - minVal) * 0.1 || 1;
    minVal -= padding;
    maxVal += padding;
    const yRange = maxVal - minVal;

    const toX = (idx) => ((idx - vStart) / viewRange) * w;
    const toY = (val) => h - ((val - minVal) / yRange) * (h - 20) - 10;

    // Draw segment annotations as background rectangles
    for (const seg of segments) {
      const x1 = toX(seg.startIdx);
      const x2 = toX(seg.endIdx);
      if (x2 < 0 || x1 > w) continue;
      ctx.fillStyle = segmentColor(seg.label) + '30'; // 30 = ~19% opacity
      ctx.fillRect(Math.max(0, x1), 0, Math.min(w, x2) - Math.max(0, x1), h);
    }

    // Draw threshold lines
    // 14 m/s² (min peak) and 8 m/s² (max dip)
    ctx.setLineDash([4, 4]);
    ctx.lineWidth = 1;

    if (14 >= minVal && 14 <= maxVal) {
      ctx.strokeStyle = 'rgba(239, 68, 68, 0.3)';
      ctx.beginPath();
      ctx.moveTo(0, toY(14));
      ctx.lineTo(w, toY(14));
      ctx.stroke();
    }

    if (8 >= minVal && 8 <= maxVal) {
      ctx.strokeStyle = 'rgba(34, 197, 94, 0.3)';
      ctx.beginPath();
      ctx.moveTo(0, toY(8));
      ctx.lineTo(w, toY(8));
      ctx.stroke();
    }

    ctx.setLineDash([]);

    // Draw signal line
    ctx.strokeStyle = '#aaa';
    ctx.lineWidth = 1.5;
    ctx.beginPath();

    const step = Math.max(1, Math.floor(viewRange / (w * 2)));
    for (let i = vStart; i < vEnd; i += step) {
      const x = toX(i);
      const y = toY(aMags[i]);
      if (i === vStart) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Draw shot markers
    for (let si = 0; si < shots.length; si++) {
      const shot = shots[si];
      if (shot.deleted) continue;
      if (shot.idx < vStart || shot.idx > vEnd) continue;

      const x = toX(shot.idx);
      const color = shot.color || zoneColor(shot.zone);

      // Vertical line
      ctx.strokeStyle = color + '80';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();

      // Dot at the peak value
      const y = toY(aMags[shot.idx] !== undefined ? aMags[shot.idx] : shot.mag);
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(x, y, si === selectedShotIdx ? 6 : 4, 0, Math.PI * 2);
      ctx.fill();

      // Shot number label
      ctx.fillStyle = '#fff';
      ctx.font = '10px ' + getComputedStyle(document.body).getPropertyValue('--mono');
      ctx.textAlign = 'center';
      ctx.fillText('#' + shot.num, x, 14);
    }

    // Y-axis labels
    ctx.fillStyle = '#666';
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'left';
    const ySteps = 5;
    for (let i = 0; i <= ySteps; i++) {
      const val = minVal + (yRange * i / ySteps);
      const y = toY(val);
      ctx.fillText(val.toFixed(1), 4, y - 2);
    }

    // Time axis
    ctx.textAlign = 'center';
    const tStart = session.imu[vStart] ? (session.imu[vStart].tRel || 0) : 0;
    const tEnd = session.imu[Math.min(vEnd, totalSamples) - 1] ? (session.imu[Math.min(vEnd, totalSamples) - 1].tRel || 0) : 0;
    const tRange = (tEnd - tStart) / 1000; // seconds
    const xSteps = Math.min(8, Math.floor(w / 60));
    for (let i = 0; i <= xSteps; i++) {
      const t = tStart / 1000 + (tRange * i / xSteps);
      const x = (i / xSteps) * w;
      ctx.fillText(formatTimeFromSec(t), x, h - 2);
    }

    // Mode indicator
    if (mode === 'addShot') {
      ctx.fillStyle = 'rgba(59, 130, 246, 0.8)';
      ctx.font = 'bold 12px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('TAP TO ADD SHOT', w / 2, 30);
    } else if (mode === 'addSegment') {
      ctx.fillStyle = 'rgba(168, 85, 247, 0.8)';
      ctx.font = 'bold 12px sans-serif';
      ctx.textAlign = 'center';
      if (!segmentStart) {
        ctx.fillText('TAP START OF SEGMENT', w / 2, 30);
      } else {
        ctx.fillText('TAP END OF SEGMENT', w / 2, 30);
        // Draw start marker
        const sx = toX(segmentStart);
        ctx.strokeStyle = '#a855f7';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(sx, 0);
        ctx.lineTo(sx, h);
        ctx.stroke();
      }
    }
  }

  function segmentColor(label) {
    const colors = {
      dribble: '#f59e0b',
      walking: '#22c55e',
      jogging: '#06b6d4',
      shooting: '#ef4444',
      stationary: '#6b7280',
    };
    return colors[label] || '#a855f7';
  }

  // ===== Shot List =====
  function renderShotList() {
    const list = document.getElementById('viewer-shot-list');
    list.innerHTML = '';

    const activeShots = shots.filter(s => !s.deleted);
    if (activeShots.length === 0) {
      list.innerHTML = '<div style="color:var(--text-dim);padding:12px;text-align:center">No shots detected</div>';
      return;
    }

    activeShots.forEach((shot, vi) => {
      // Find the actual index in the shots array
      const si = shots.indexOf(shot);
      const div = document.createElement('div');
      div.className = 'viewer-shot-item' + (si === selectedShotIdx ? ' selected' : '');
      div.innerHTML = `
        <div class="viewer-shot-num" style="background:${shot.color || zoneColor(shot.zone)}">${shot.num}</div>
        <div class="viewer-shot-info">
          <div class="viewer-shot-zone">${shot.zone || 'Unknown'}</div>
          <div class="viewer-shot-detail">
            Peak: ${shot.mag?.toFixed(1)} | Dip: ${shot.dipMag?.toFixed(1)} | Range: ${shot.range?.toFixed(1)}
          </div>
        </div>
        <div class="viewer-shot-actions">
          <button class="btn btn-sm" data-action="edit" data-idx="${si}">Edit</button>
          <button class="btn btn-sm btn-danger" data-action="delete" data-idx="${si}">Del</button>
        </div>
      `;

      // Click to scroll to shot
      div.addEventListener('click', (e) => {
        if (e.target.closest('[data-action]')) return;
        selectedShotIdx = si;
        scrollToShot(shot);
        renderAll();
      });

      list.appendChild(div);
    });

    // Button handlers
    list.querySelectorAll('[data-action="edit"]').forEach(btn => {
      btn.addEventListener('click', () => editShot(parseInt(btn.dataset.idx)));
    });
    list.querySelectorAll('[data-action="delete"]').forEach(btn => {
      btn.addEventListener('click', () => deleteShot(parseInt(btn.dataset.idx)));
    });
  }

  function scrollToShot(shot) {
    const margin = Math.max(200, (viewEnd - viewStart) * 0.1);
    const center = shot.idx;
    const halfView = (viewEnd - viewStart) / 2;
    viewStart = Math.max(0, center - halfView);
    viewEnd = Math.min(totalSamples, center + halfView);
    renderMinimap();
    renderSignal();
  }

  // ===== Segment List =====
  function renderSegmentList() {
    const list = document.getElementById('viewer-segment-list');
    list.innerHTML = '';

    if (segments.length === 0) {
      list.innerHTML = '<div style="color:var(--text-dim);padding:12px;text-align:center">No segments labeled</div>';
      return;
    }

    segments.forEach((seg, i) => {
      const div = document.createElement('div');
      div.className = 'viewer-segment-item';

      const tStart = session.imu[seg.startIdx] ? (session.imu[seg.startIdx].tRel || 0) / 1000 : 0;
      const tEnd = session.imu[seg.endIdx] ? (session.imu[seg.endIdx].tRel || 0) / 1000 : 0;

      div.innerHTML = `
        <div class="segment-color-bar" style="background:${segmentColor(seg.label)}"></div>
        <div class="viewer-segment-info">
          <div class="viewer-segment-label">${seg.label}</div>
          <div class="viewer-segment-range">${formatTimeFromSec(tStart)} - ${formatTimeFromSec(tEnd)}</div>
        </div>
        <button class="btn btn-sm btn-danger" data-seg-del="${i}">Del</button>
      `;

      div.addEventListener('click', (e) => {
        if (e.target.closest('[data-seg-del]')) {
          pushUndo();
          segments.splice(i, 1);
          renderAll();
          return;
        }
        // Scroll to segment
        viewStart = Math.max(0, seg.startIdx - 100);
        viewEnd = Math.min(totalSamples, seg.endIdx + 100);
        renderMinimap();
        renderSignal();
      });

      list.appendChild(div);
    });
  }

  // ===== Shot Editing =====
  function editShot(idx) {
    selectedShotIdx = idx;
    const shot = shots[idx];
    const modal = document.getElementById('zone-edit-modal');
    const options = document.getElementById('zone-edit-options');

    options.innerHTML = '';
    ALL_ZONES.forEach(zone => {
      const btn = document.createElement('button');
      btn.className = 'btn btn-sm' + (zone === shot.zone ? ' selected' : '');
      btn.textContent = zone;
      btn.style.borderLeftColor = zoneColor(zone);
      btn.style.borderLeftWidth = '3px';
      btn.addEventListener('click', () => {
        options.querySelectorAll('.btn').forEach(b => b.classList.remove('selected'));
        btn.classList.add('selected');
      });
      options.appendChild(btn);
    });

    modal.classList.remove('hidden');
  }

  function deleteShot(idx) {
    pushUndo();
    shots[idx].deleted = true;
    renumberShots();
    renderAll();
  }

  function renumberShots() {
    let num = 1;
    for (const shot of shots) {
      if (!shot.deleted) {
        shot.num = num++;
      }
    }
  }

  // ===== Undo =====
  function pushUndo() {
    undoStack.push({
      shots: JSON.parse(JSON.stringify(shots)),
      segments: JSON.parse(JSON.stringify(segments)),
    });
    document.getElementById('btn-undo').disabled = false;
    // Cap undo stack
    if (undoStack.length > 30) undoStack.shift();
  }

  function undo() {
    if (undoStack.length === 0) return;
    const state = undoStack.pop();
    shots = state.shots;
    segments = state.segments;
    document.getElementById('btn-undo').disabled = undoStack.length === 0;
    renderAll();
  }

  // ===== Toolbar =====
  function setupToolbar() {
    document.getElementById('btn-load-new').addEventListener('click', () => {
      session = null;
      shots = [];
      segments = [];
      undoStack = [];
      document.getElementById('viewer-content').classList.add('hidden');
      document.getElementById('viewer-loader').classList.remove('hidden');
      document.getElementById('file-input').value = '';
    });

    document.getElementById('btn-rerun').addEventListener('click', () => {
      if (!session) return;
      pushUndo();
      const detector = new ShotDetector();
      const detected = detector.detectAll(session.imu);
      shots = detected.map((s, i) => ({
        ...s,
        x: 0, y: 0,
        zone: 'RIM',
        color: zoneColor('RIM'),
        dist: 0,
        num: i + 1,
        confirmed: false,
        deleted: false,
      }));
      renderAll();
    });

    document.getElementById('btn-add-shot').addEventListener('click', () => {
      if (mode === 'addShot') {
        mode = 'normal';
        removeModeIndicator();
      } else {
        mode = 'addShot';
        segmentStart = null;
        showModeIndicator('Tap chart to add shot — click button again to cancel');
      }
      renderSignal();
    });

    document.getElementById('btn-add-segment').addEventListener('click', () => {
      if (mode === 'addSegment') {
        mode = 'normal';
        segmentStart = null;
        removeModeIndicator();
      } else {
        mode = 'addSegment';
        segmentStart = null;
        showModeIndicator('Tap chart for segment start — click button again to cancel');
      }
      renderSignal();
    });

    document.getElementById('btn-undo').addEventListener('click', undo);

    document.getElementById('btn-viewer-export').addEventListener('click', exportSession);
  }

  function showModeIndicator(text) {
    removeModeIndicator();
    const div = document.createElement('div');
    div.className = 'mode-indicator';
    div.id = 'mode-indicator';
    div.textContent = text;
    document.body.appendChild(div);
  }

  function removeModeIndicator() {
    const el = document.getElementById('mode-indicator');
    if (el) el.remove();
  }

  // ===== Panel Tabs =====
  function setupPanelTabs() {
    document.querySelectorAll('.panel-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.panel-tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.panel-content').forEach(p => p.classList.remove('active'));
        tab.classList.add('active');
        document.getElementById('panel-' + tab.dataset.panel).classList.add('active');
      });
    });
  }

  // ===== Chart Interaction =====
  function setupChartInteraction() {
    // Signal canvas — mouse
    const sc = document.getElementById('signal-canvas');

    sc.addEventListener('mousedown', (e) => {
      if (mode !== 'normal') {
        handleChartClick(e);
        return;
      }
      isDragging = true;
      dragStartX = e.clientX;
      dragStartView = viewStart;
      sc.style.cursor = 'grabbing';
    });

    window.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      const dx = e.clientX - dragStartX;
      const samplesPerPx = (viewEnd - viewStart) / sc.clientWidth;
      const shift = -dx * samplesPerPx;
      const newStart = dragStartView + shift;
      const range = viewEnd - viewStart;
      viewStart = Math.max(0, Math.min(totalSamples - range, newStart));
      viewEnd = viewStart + range;
      renderMinimap();
      renderSignal();
    });

    window.addEventListener('mouseup', () => {
      isDragging = false;
      sc.style.cursor = 'grab';
    });

    // Mouse wheel zoom
    sc.addEventListener('wheel', (e) => {
      e.preventDefault();
      const zoomFactor = e.deltaY > 0 ? 1.15 : 0.87;
      const rect = sc.getBoundingClientRect();
      const mouseRatio = (e.clientX - rect.left) / rect.width;
      zoom(zoomFactor, mouseRatio);
    }, { passive: false });

    // Touch: pan + pinch zoom
    let lastTouches = [];
    sc.addEventListener('touchstart', (e) => {
      if (mode !== 'normal' && e.touches.length === 1) {
        handleChartTouch(e);
        return;
      }
      lastTouches = Array.from(e.touches);
      if (e.touches.length === 1) {
        isDragging = true;
        dragStartX = e.touches[0].clientX;
        dragStartView = viewStart;
      } else if (e.touches.length === 2) {
        isDragging = false;
        pinchStartDist = Math.abs(e.touches[0].clientX - e.touches[1].clientX);
        pinchStartRange = viewEnd - viewStart;
      }
    }, { passive: true });

    sc.addEventListener('touchmove', (e) => {
      if (e.touches.length === 1 && isDragging) {
        const dx = e.touches[0].clientX - dragStartX;
        const samplesPerPx = (viewEnd - viewStart) / sc.clientWidth;
        const shift = -dx * samplesPerPx;
        const newStart = dragStartView + shift;
        const range = viewEnd - viewStart;
        viewStart = Math.max(0, Math.min(totalSamples - range, newStart));
        viewEnd = viewStart + range;
        renderMinimap();
        renderSignal();
      } else if (e.touches.length === 2) {
        const dist = Math.abs(e.touches[0].clientX - e.touches[1].clientX);
        if (pinchStartDist > 0) {
          const scale = pinchStartDist / dist;
          const newRange = Math.max(50, Math.min(totalSamples, pinchStartRange * scale));
          const center = (viewStart + viewEnd) / 2;
          viewStart = Math.max(0, center - newRange / 2);
          viewEnd = Math.min(totalSamples, center + newRange / 2);
          renderMinimap();
          renderSignal();
        }
      }
      lastTouches = Array.from(e.touches);
    }, { passive: true });

    sc.addEventListener('touchend', () => {
      isDragging = false;
      pinchStartDist = 0;
    });

    // Minimap click/drag to set viewport
    minimapCanvas.addEventListener('mousedown', (e) => {
      minimapDragging = true;
      setViewFromMinimap(e);
    });
    window.addEventListener('mousemove', (e) => {
      if (minimapDragging) setViewFromMinimap(e);
    });
    window.addEventListener('mouseup', () => { minimapDragging = false; });

    minimapCanvas.addEventListener('touchstart', (e) => {
      minimapDragging = true;
      setViewFromMinimapTouch(e);
    }, { passive: true });
    minimapCanvas.addEventListener('touchmove', (e) => {
      if (minimapDragging) setViewFromMinimapTouch(e);
    }, { passive: true });
    minimapCanvas.addEventListener('touchend', () => { minimapDragging = false; });

    // Resize
    window.addEventListener('resize', () => {
      if (session) {
        resizeCanvases();
        renderAll();
      }
    });
  }

  function setViewFromMinimap(e) {
    const rect = minimapCanvas.getBoundingClientRect();
    const ratio = (e.clientX - rect.left) / rect.width;
    const range = viewEnd - viewStart;
    const center = ratio * totalSamples;
    viewStart = Math.max(0, Math.min(totalSamples - range, center - range / 2));
    viewEnd = viewStart + range;
    renderMinimap();
    renderSignal();
  }

  function setViewFromMinimapTouch(e) {
    if (e.touches.length === 0) return;
    const rect = minimapCanvas.getBoundingClientRect();
    const ratio = (e.touches[0].clientX - rect.left) / rect.width;
    const range = viewEnd - viewStart;
    const center = ratio * totalSamples;
    viewStart = Math.max(0, Math.min(totalSamples - range, center - range / 2));
    viewEnd = viewStart + range;
    renderMinimap();
    renderSignal();
  }

  function zoom(factor, anchorRatio) {
    const range = viewEnd - viewStart;
    const newRange = Math.max(50, Math.min(totalSamples, range * factor));
    const anchor = viewStart + range * anchorRatio;
    viewStart = Math.max(0, anchor - newRange * anchorRatio);
    viewEnd = Math.min(totalSamples, viewStart + newRange);
    viewStart = Math.max(0, viewEnd - newRange);
    renderMinimap();
    renderSignal();
  }

  // ===== Chart Click Handlers (for add shot / add segment) =====
  function handleChartClick(e) {
    const rect = signalCanvas.getBoundingClientRect();
    const ratio = (e.clientX - rect.left) / rect.width;
    const sampleIdx = Math.round(viewStart + ratio * (viewEnd - viewStart));
    handleChartTap(sampleIdx);
  }

  function handleChartTouch(e) {
    if (e.touches.length !== 1) return;
    const rect = signalCanvas.getBoundingClientRect();
    const ratio = (e.touches[0].clientX - rect.left) / rect.width;
    const sampleIdx = Math.round(viewStart + ratio * (viewEnd - viewStart));
    handleChartTap(sampleIdx);
  }

  function handleChartTap(sampleIdx) {
    if (sampleIdx < 0 || sampleIdx >= totalSamples) return;

    if (mode === 'addShot') {
      pushUndo();
      // Find local max near tap
      const searchRadius = 20;
      let bestIdx = sampleIdx;
      let bestVal = aMags[sampleIdx];
      for (let i = Math.max(0, sampleIdx - searchRadius); i < Math.min(totalSamples, sampleIdx + searchRadius); i++) {
        if (aMags[i] > bestVal) {
          bestVal = aMags[i];
          bestIdx = i;
        }
      }

      const newShot = {
        idx: bestIdx,
        mag: bestVal,
        dipMag: 0,
        recoveryMag: 0,
        range: 0,
        t: session.imu[bestIdx]?.t || 0,
        tRel: session.imu[bestIdx]?.tRel || 0,
        x: 0, y: 0,
        zone: 'RIM',
        color: zoneColor('RIM'),
        dist: 0,
        num: 0,
        confirmed: false,
        deleted: false,
        userAdded: true,
      };

      shots.push(newShot);
      shots.sort((a, b) => a.idx - b.idx);
      renumberShots();
      mode = 'normal';
      removeModeIndicator();
      renderAll();
    } else if (mode === 'addSegment') {
      if (segmentStart === null) {
        segmentStart = sampleIdx;
        showModeIndicator('Tap chart for segment end — click button again to cancel');
        renderSignal();
      } else {
        const startIdx = Math.min(segmentStart, sampleIdx);
        const endIdx = Math.max(segmentStart, sampleIdx);
        segmentStart = null;
        mode = 'normal';
        removeModeIndicator();
        showSegmentModal(startIdx, endIdx);
      }
    }
  }

  // ===== Modals =====
  function setupModals() {
    // Zone edit modal
    document.getElementById('zone-edit-cancel').addEventListener('click', () => {
      document.getElementById('zone-edit-modal').classList.add('hidden');
    });

    document.getElementById('zone-edit-save').addEventListener('click', () => {
      const selected = document.querySelector('#zone-edit-options .btn.selected');
      if (selected && selectedShotIdx >= 0) {
        pushUndo();
        shots[selectedShotIdx].zone = selected.textContent;
        shots[selectedShotIdx].color = zoneColor(selected.textContent);
      }
      document.getElementById('zone-edit-modal').classList.add('hidden');
      renderAll();
    });

    // Segment modal
    document.getElementById('segment-cancel').addEventListener('click', () => {
      document.getElementById('segment-modal').classList.add('hidden');
    });

    // Segment label button selection
    document.querySelectorAll('[data-seg-label]').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('[data-seg-label]').forEach(b => b.classList.remove('selected'));
        btn.classList.add('selected');
        document.getElementById('segment-custom-label').value = '';
      });
    });
  }

  let pendingSegment = null;

  function showSegmentModal(startIdx, endIdx) {
    pendingSegment = { startIdx, endIdx };
    const modal = document.getElementById('segment-modal');
    document.querySelectorAll('[data-seg-label]').forEach(b => b.classList.remove('selected'));
    document.getElementById('segment-custom-label').value = '';
    modal.classList.remove('hidden');

    // Wire save (once)
    const saveBtn = document.getElementById('segment-save');
    const newSave = saveBtn.cloneNode(true);
    saveBtn.parentNode.replaceChild(newSave, saveBtn);
    newSave.addEventListener('click', () => {
      const selected = document.querySelector('[data-seg-label].selected');
      const custom = document.getElementById('segment-custom-label').value.trim();
      const label = custom || (selected ? selected.dataset.segLabel : null);
      if (!label) return;

      pushUndo();
      segments.push({ startIdx: pendingSegment.startIdx, endIdx: pendingSegment.endIdx, label });
      pendingSegment = null;
      modal.classList.add('hidden');
      renderAll();
    });
  }

  // ===== Export =====
  function exportSession() {
    if (!session) return;

    const exportData = session.toJSON();

    // Apply edits
    const activeShots = shots.filter(s => !s.deleted).map(s => ({
      x: s.x || 0,
      y: s.y || 0,
      zone: s.zone,
      color: s.color || zoneColor(s.zone),
      dist: s.dist || 0,
      mag: s.mag,
      idx: s.idx,
      dipMag: s.dipMag,
      recoveryMag: s.recoveryMag,
      range: s.range,
    }));

    exportData.shots = activeShots;
    exportData.summary.shots = activeShots.length;

    if (segments.length > 0) {
      exportData.segments = segments;
    }

    // Track provenance
    exportData.userEdits = {
      editedAt: Date.now(),
      originalShotCount: session.shots.length,
      editedShotCount: activeShots.length,
      segmentCount: segments.length,
      addedShots: shots.filter(s => s.userAdded && !s.deleted).length,
      deletedShots: shots.filter(s => s.deleted).length,
    };

    const filename = (session.sessionId || 'session') + '_edited.json';
    downloadJSON(exportData, filename);
  }

  return { init, onShow, loadSession };
})();
