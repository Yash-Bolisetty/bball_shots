/* ===== core.js — Shared logic: shot detection, movement, buffer, session, zones ===== */

// ===== Court Position Constants =====
const COURT = {
  rim:    { x: 0,    y: 0    },
  ft:     { x: 0,    y: 4.6  },
  top3:   { x: 0,    y: 7.24 },
  left3:  { x: -6.7, y: 0.9  },
  right3: { x: 6.7,  y: 0.9  },
};

// Three-point boundary
const THREE_POINT_DIST = 7.24;   // arc
const CORNER_THREE_DIST = 6.7;   // corner
const CORNER_Y_THRESHOLD = 0.9;  // corners are at y ≈ 0.9

// Zone colors
const ZONE_COLORS = {
  'RIM':        '#ef4444',
  'PAINT':      '#f97316',
  'SHORT':      '#f59e0b',
  'FT-LINE':    '#eab308',
  'L-BASE':     '#84cc16',
  'R-BASE':     '#22c55e',
  'L-WING 3':   '#14b8a6',
  'R-WING 3':   '#06b6d4',
  'L-CORNER 3': '#3b82f6',
  'R-CORNER 3': '#8b5cf6',
  'TOP 3':      '#a855f7',
};

const ALL_ZONES = Object.keys(ZONE_COLORS);

function classifyZone(x, y) {
  const dist = Math.sqrt(x * x + y * y);
  const angle = Math.atan2(x, y) * (180 / Math.PI); // 0=straight, neg=left, pos=right

  if (dist < 1.5) return 'RIM';
  if (dist < 3.0) return 'PAINT';
  if (dist < 4.0) return 'SHORT';
  if (dist < 5.0 && Math.abs(angle) < 30) return 'FT-LINE';

  // Check three-point line
  const isCorner = y < 1.5;
  const threePointDist = isCorner ? CORNER_THREE_DIST : THREE_POINT_DIST;

  if (dist < threePointDist) {
    // Inside the arc — mid-range
    if (angle < -30) return 'L-BASE';
    if (angle > 30)  return 'R-BASE';
    return 'SHORT';
  }

  // Beyond three-point line
  if (isCorner) {
    return x < 0 ? 'L-CORNER 3' : 'R-CORNER 3';
  }
  if (angle < -30) return 'L-WING 3';
  if (angle > 30)  return 'R-WING 3';
  return 'TOP 3';
}

function zoneColor(zone) {
  return ZONE_COLORS[zone] || '#888';
}


// ===== IMU Buffer =====
class IMUBuffer {
  constructor(maxSize = 3000, shiftSize = 1000) {
    this.maxSize = maxSize;
    this.shiftSize = shiftSize;
    this.data = [];
    this.totalPushed = 0; // track total samples ever pushed (for index offset)
    this.offset = 0;      // how many samples have been shifted out
  }

  push(sample) {
    this.data.push(sample);
    this.totalPushed++;
    if (this.data.length > this.maxSize) {
      this.data = this.data.slice(this.shiftSize);
      this.offset += this.shiftSize;
    }
  }

  get length() { return this.data.length; }
  get(i) { return this.data[i]; }

  // Get the absolute index for a buffer-relative index
  absIndex(i) { return i + this.offset; }

  // Last N samples
  tail(n) {
    const start = Math.max(0, this.data.length - n);
    return this.data.slice(start);
  }

  clear() {
    this.data = [];
    this.totalPushed = 0;
    this.offset = 0;
  }
}


// ===== Movement Detector =====
const MOVEMENT_WINDOW = 20;
const MOVEMENT_THRESHOLD = 0.8;
const MOVEMENT_HYSTERESIS_MS = 800;

class MovementDetector {
  constructor() {
    this.window = [];
    this.isMoving = false;
    this.lastTransitionTime = 0;
    this.intensity = 0;
  }

  processSample(aMag, t) {
    this.window.push(aMag);
    if (this.window.length > MOVEMENT_WINDOW) {
      this.window.shift();
    }
    if (this.window.length < MOVEMENT_WINDOW) return this.isMoving;

    const mean = this.window.reduce((a, b) => a + b, 0) / this.window.length;
    const variance = this.window.reduce((a, v) => a + (v - mean) ** 2, 0) / this.window.length;
    const std = Math.sqrt(variance);

    // Intensity: normalized 0-1
    this.intensity = Math.max(0, Math.min(1, (std - 0.3) / 1.5));

    const nowMoving = std > MOVEMENT_THRESHOLD;

    if (nowMoving !== this.isMoving) {
      if (nowMoving) {
        // Transition to moving immediately
        this.isMoving = true;
        this.lastTransitionTime = t;
      } else {
        // Hysteresis: wait before transitioning to stationary
        if (t - this.lastTransitionTime > MOVEMENT_HYSTERESIS_MS) {
          this.isMoving = false;
          this.lastTransitionTime = t;
        }
      }
    } else {
      this.lastTransitionTime = t;
    }

    return this.isMoving;
  }

  reset() {
    this.window = [];
    this.isMoving = false;
    this.lastTransitionTime = 0;
    this.intensity = 0;
  }
}


// ===== Shot Detector =====
const PEAK_SIGMA = 2.5;
const DIP_SIGMA = 1.5;
const RECOVERY_SIGMA = 1.0;
const PEAK_TO_DIP_SIGMA = 5.0;
const MIN_PEAK_ABS = 14;
const MAX_DIP_ABS = 8;
const MIN_RISE_FROM_DIP = 4;
const MIN_PEAK_TO_DIP_ABS = 6;
const BASELINE_WINDOW = 80;
const BASELINE_OFFSET = 20;
const DIP_SEARCH_WINDOW = 35;
const RECOVERY_SEARCH_WINDOW = 30;
const SCAN_START_OFFSET = 90;  // from end
const SCAN_END_OFFSET = 50;    // from end
const MIN_SHOT_INTERVAL_MS = 1200;
const MIN_SHOT_SAMPLES = 60;
const MAX_EFFECTIVE_STD = 1.5; // Cap std for peak/range/recovery thresholds only
                                // Prevents nearby shots from inflating baseline std
                                // Real std still used for dip threshold (stricter when noisy)

class ShotDetector {
  constructor() {
    this.lastShotTime = 0;
    this.lastShotIdx = -Infinity;
  }

  // Compute baseline stats from a slice of aMag values
  _baseline(aMags, endIdx) {
    const start = Math.max(0, endIdx - BASELINE_WINDOW);
    const slice = aMags.slice(start, endIdx);
    if (slice.length < 10) return null;
    const mean = slice.reduce((a, b) => a + b, 0) / slice.length;
    const variance = slice.reduce((a, v) => a + (v - mean) ** 2, 0) / slice.length;
    return { mean, std: Math.sqrt(variance) };
  }

  // Live mode: call after each new sample pushed to buffer
  // Returns shot info or null
  processSample(buffer, currentTime) {
    const len = buffer.length;
    if (len < SCAN_START_OFFSET + BASELINE_WINDOW + BASELINE_OFFSET) return null;

    const scanStart = len - SCAN_START_OFFSET;
    const scanEnd = len - SCAN_END_OFFSET;

    // Extract aMag array for scanning
    const aMags = [];
    for (let i = 0; i < len; i++) aMags.push(buffer.get(i).aMag);

    for (let i = scanStart; i < scanEnd; i++) {
      const result = this._checkCandidate(aMags, i, len, currentTime, buffer);
      if (result) return result;
    }
    return null;
  }

  // Batch mode: detect all shots in a full aMag array
  detectAll(imuData) {
    const aMags = imuData.map(s => s.aMag);
    const shots = [];
    let lastIdx = -Infinity;
    let lastTime = 0;

    for (let i = BASELINE_WINDOW + BASELINE_OFFSET; i < aMags.length - DIP_SEARCH_WINDOW - RECOVERY_SEARCH_WINDOW; i++) {
      // Check if this is a local maximum
      if (aMags[i] <= aMags[i - 1] || aMags[i] < aMags[i + 1]) continue;

      const baseEnd = Math.max(0, i - BASELINE_OFFSET);
      const base = this._baseline(aMags, baseEnd);
      if (!base) continue;

      // Capped std for peak/range/recovery; real std for dip (stays strict when noisy)
      const effStd = Math.min(base.std, MAX_EFFECTIVE_STD);

      const peakThreshold = base.mean + PEAK_SIGMA * effStd;
      if (aMags[i] < peakThreshold || aMags[i] < MIN_PEAK_ABS) continue;

      // Enforce min samples between shots
      if (i - lastIdx < MIN_SHOT_SAMPLES) continue;

      // Enforce min time between shots
      const sampleTime = imuData[i].t || imuData[i].tRel || 0;
      if (sampleTime - lastTime < MIN_SHOT_INTERVAL_MS && lastTime > 0) continue;

      // Find dip
      const dipEnd = Math.min(aMags.length, i + DIP_SEARCH_WINDOW);
      let dipIdx = i + 1;
      for (let j = i + 1; j < dipEnd; j++) {
        if (aMags[j] < aMags[dipIdx]) dipIdx = j;
      }

      const dipThreshold = base.mean - DIP_SIGMA * base.std;
      if (aMags[dipIdx] > dipThreshold || aMags[dipIdx] > MAX_DIP_ABS) continue;

      // Peak-to-dip range
      const peakToDipRange = aMags[i] - aMags[dipIdx];
      const minRange = Math.max(MIN_PEAK_TO_DIP_ABS, effStd * PEAK_TO_DIP_SIGMA);
      if (peakToDipRange < minRange) continue;

      // Find recovery peak
      const recEnd = Math.min(aMags.length, dipIdx + RECOVERY_SEARCH_WINDOW);
      let recIdx = dipIdx + 1;
      if (recIdx >= recEnd) continue;
      for (let j = dipIdx + 1; j < recEnd; j++) {
        if (aMags[j] > aMags[recIdx]) recIdx = j;
      }

      const recThreshold = base.mean + RECOVERY_SIGMA * effStd;
      const riseFromDip = aMags[recIdx] - aMags[dipIdx];
      if (aMags[recIdx] < recThreshold || riseFromDip < MIN_RISE_FROM_DIP) continue;

      // Shot detected!
      shots.push({
        idx: i,
        mag: aMags[i],
        dipMag: aMags[dipIdx],
        recoveryMag: aMags[recIdx],
        range: peakToDipRange,
        t: imuData[i].t,
        tRel: imuData[i].tRel,
      });

      lastIdx = i;
      lastTime = sampleTime;
    }
    return shots;
  }

  // Check a single candidate peak in live mode
  _checkCandidate(aMags, i, len, currentTime, buffer) {
    // Must be local max
    if (aMags[i] <= aMags[i - 1] || aMags[i] < aMags[i + 1]) return null;

    const baseEnd = Math.max(0, i - BASELINE_OFFSET);
    const base = this._baseline(aMags, baseEnd);
    if (!base) return null;

    const effStd = Math.min(base.std, MAX_EFFECTIVE_STD);

    const peakThreshold = base.mean + PEAK_SIGMA * effStd;
    if (aMags[i] < peakThreshold || aMags[i] < MIN_PEAK_ABS) return null;

    // Enforce minimum intervals
    const absIdx = buffer.absIndex(i);
    if (absIdx - this.lastShotIdx < MIN_SHOT_SAMPLES) return null;
    if (currentTime - this.lastShotTime < MIN_SHOT_INTERVAL_MS && this.lastShotTime > 0) return null;

    // Find dip
    const dipEnd = Math.min(len, i + DIP_SEARCH_WINDOW);
    let dipIdx = i + 1;
    if (dipIdx >= dipEnd) return null;
    for (let j = i + 1; j < dipEnd; j++) {
      if (aMags[j] < aMags[dipIdx]) dipIdx = j;
    }

    const dipThreshold = base.mean - DIP_SIGMA * base.std;
    if (aMags[dipIdx] > dipThreshold || aMags[dipIdx] > MAX_DIP_ABS) return null;

    // Peak-to-dip range
    const peakToDipRange = aMags[i] - aMags[dipIdx];
    const minRange = Math.max(MIN_PEAK_TO_DIP_ABS, effStd * PEAK_TO_DIP_SIGMA);
    if (peakToDipRange < minRange) return null;

    // Find recovery
    const recEnd = Math.min(len, dipIdx + RECOVERY_SEARCH_WINDOW);
    let recIdx = dipIdx + 1;
    if (recIdx >= recEnd) return null;
    for (let j = dipIdx + 1; j < recEnd; j++) {
      if (aMags[j] > aMags[recIdx]) recIdx = j;
    }

    const recThreshold = base.mean + RECOVERY_SIGMA * effStd;
    const riseFromDip = aMags[recIdx] - aMags[dipIdx];
    if (aMags[recIdx] < recThreshold || riseFromDip < MIN_RISE_FROM_DIP) return null;

    // Shot detected!
    this.lastShotTime = currentTime;
    this.lastShotIdx = absIdx;

    return {
      idx: absIdx,
      bufferIdx: i,
      mag: aMags[i],
      dipMag: aMags[dipIdx],
      recoveryMag: aMags[recIdx],
      range: peakToDipRange,
      t: currentTime,
    };
  }

  reset() {
    this.lastShotTime = 0;
    this.lastShotIdx = -Infinity;
  }
}


// ===== Session =====
class Session {
  constructor() {
    this.sessionId = 'bball_' + Date.now();
    this.startTime = Date.now();
    this.imu = [];
    this.gps = [];
    this.events = [];
    this.shots = [];
    this.gpsCalibration = { rim: null, top3: null, left: null, right: null };
    this.courtPositions = { ...COURT };
    this.segments = [];    // user-labeled segments
    this.userEdits = null; // delta layer for viewer edits
  }

  get duration() {
    return Date.now() - this.startTime;
  }

  addIMU(sample) {
    this.imu.push(sample);
  }

  addGPS(sample) {
    this.gps.push(sample);
  }

  addEvent(evt) {
    this.events.push(evt);
  }

  addShot(shot) {
    this.shots.push(shot);
  }

  toJSON() {
    const obj = {
      sessionId: this.sessionId,
      exportTime: Date.now(),
      startTime: this.startTime,
      duration: this.duration,
      gpsCalibration: this.gpsCalibration,
      courtPositions: this.courtPositions,
      summary: {
        imuSamples: this.imu.length,
        gpsSamples: this.gps.length,
        events: this.events.length,
        shots: this.shots.length,
      },
      imu: this.imu,
      gps: this.gps,
      events: this.events,
      shots: this.shots,
    };
    if (this.segments.length > 0) obj.segments = this.segments;
    if (this.userEdits) obj.userEdits = this.userEdits;
    return obj;
  }

  static fromJSON(data) {
    const s = new Session();
    s.sessionId = data.sessionId || s.sessionId;
    s.startTime = data.startTime || s.startTime;
    s.imu = data.imu || [];
    s.gps = data.gps || [];
    s.events = data.events || [];
    s.shots = data.shots || [];
    s.gpsCalibration = data.gpsCalibration || s.gpsCalibration;
    s.courtPositions = data.courtPositions || s.courtPositions;
    s.segments = data.segments || [];
    s.userEdits = data.userEdits || null;
    return s;
  }
}


// ===== Utility =====
function formatTime(ms) {
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
}

function formatTimeFromSec(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
}

function downloadJSON(data, filename) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// Median of an array
function median(arr) {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
