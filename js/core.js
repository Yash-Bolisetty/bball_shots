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
const MAX_DIP_ABS = 6;       // was 8 — tighter: real shots dip well below 6
const MIN_RISE_FROM_DIP = 5;  // was 4 — tighter: real shots recover strongly
const MIN_PEAK_TO_DIP_ABS = 8; // was 6 — tighter: real shots have large swings
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
    this.calibration = null;  // Set from MotionCalibrator.load() to enable post-filter
    this.useConsensus = false; // Enable multi-detector consensus
    this.consensusOpts = {};   // Options for consensus detectors
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

      // Three-phase passed — apply post-filters

      // Multi-detector consensus
      let consensus = null;
      if (this.useConsensus) {
        consensus = ShotDetectorConsensus.evaluate(aMags, i, dipIdx, recIdx, this.consensusOpts);
        if (!consensus.isShot) continue;
      }

      // Calibration post-filter
      let calibResult = null;
      if (this.calibration) {
        const features = MotionCalibrator._extractFeatures(imuData, i, dipIdx, recIdx, base.mean);
        if (features) {
          calibResult = MotionCalibrator.classify(features, this.calibration);
          if (!calibResult.isShot) continue;
        }
      }

      // Shot detected!
      shots.push({
        idx: i,
        mag: aMags[i],
        dipMag: aMags[dipIdx],
        recoveryMag: aMags[recIdx],
        range: peakToDipRange,
        t: imuData[i].t,
        tRel: imuData[i].tRel,
        consensus,
        calibResult,
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

    // Three-phase passed — apply post-filters

    // Multi-detector consensus
    let consensus = null;
    if (this.useConsensus) {
      consensus = ShotDetectorConsensus.evaluate(aMags, i, dipIdx, recIdx, this.consensusOpts);
      if (!consensus.isShot) return null;
    }

    // Calibration post-filter
    let calibResult = null;
    if (this.calibration) {
      const features = MotionCalibrator._extractFeatures(buffer.data, i, dipIdx, recIdx, base.mean);
      if (features) {
        calibResult = MotionCalibrator.classify(features, this.calibration);
        if (!calibResult.isShot) return null;
      }
    }

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
      consensus,
      calibResult,
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


// ===== Motion Calibrator =====
const CALIB_STORAGE_KEY = 'bball_motion_calibration';

class MotionCalibrator {
  // --- Pattern extraction with relaxed thresholds ---
  static extractPatterns(imuData, label) {
    const aMags = imuData.map(s => s.aMag);
    if (aMags.length < 60) return [];

    // Global stats for relaxed thresholds
    const globalMean = aMags.reduce((a, b) => a + b, 0) / aMags.length;
    const globalVar = aMags.reduce((a, v) => a + (v - globalMean) ** 2, 0) / aMags.length;
    const globalStd = Math.sqrt(globalVar);

    const peakThresh = Math.max(globalMean + 1.0 * globalStd, 11.0);
    const minDrop = 3.0;
    const minRise = 2.0;
    const minSpacing = 20;

    const patterns = [];
    let lastPeakIdx = -Infinity;

    for (let i = 2; i < aMags.length - DIP_SEARCH_WINDOW - RECOVERY_SEARCH_WINDOW; i++) {
      // Local max check
      if (aMags[i] <= aMags[i - 1] || aMags[i] < aMags[i + 1]) continue;
      if (aMags[i] < peakThresh) continue;
      if (i - lastPeakIdx < minSpacing) continue;

      // Baseline for this peak
      const baseEnd = Math.max(0, i - BASELINE_OFFSET);
      const baseStart = Math.max(0, baseEnd - BASELINE_WINDOW);
      const baseSlice = aMags.slice(baseStart, baseEnd);
      if (baseSlice.length < 10) continue;
      const baseMean = baseSlice.reduce((a, b) => a + b, 0) / baseSlice.length;

      // Find dip
      const dipEnd = Math.min(aMags.length, i + DIP_SEARCH_WINDOW);
      let dipIdx = i + 1;
      if (dipIdx >= dipEnd) continue;
      for (let j = i + 1; j < dipEnd; j++) {
        if (aMags[j] < aMags[dipIdx]) dipIdx = j;
      }

      const drop = aMags[i] - aMags[dipIdx];
      if (drop < minDrop) continue;

      // Find recovery
      const recEnd = Math.min(aMags.length, dipIdx + RECOVERY_SEARCH_WINDOW);
      let recIdx = dipIdx + 1;
      if (recIdx >= recEnd) continue;
      for (let j = dipIdx + 1; j < recEnd; j++) {
        if (aMags[j] > aMags[recIdx]) recIdx = j;
      }

      const rise = aMags[recIdx] - aMags[dipIdx];
      if (rise < minRise) continue;

      // Extract 12-dimension feature vector
      const features = MotionCalibrator._extractFeatures(imuData, i, dipIdx, recIdx, baseMean);
      if (features) {
        features.label = label;
        features.idx = i;
        patterns.push(features);
        lastPeakIdx = i;
      }
    }

    return patterns;
  }

  // --- Extract 12-dim feature vector from IMU data around a detected pattern ---
  static _extractFeatures(imuData, peakIdx, dipIdx, recIdx, baselineMean) {
    if (peakIdx < 0 || dipIdx >= imuData.length || recIdx >= imuData.length) return null;

    const peakSample = imuData[peakIdx];
    const dipSample = imuData[dipIdx];
    const recSample = imuData[recIdx];

    if (!peakSample || !dipSample || !recSample) return null;

    const peakMag = peakSample.aMag;
    const dipMag = dipSample.aMag;
    const recoveryMag = recSample.aMag;
    const range = peakMag - dipMag;
    const dipRatio = baselineMean > 0 ? dipMag / baselineMean : 1.0;

    // Timing
    const peakToDipSamples = dipIdx - peakIdx;
    const dipToRecSamples = recIdx - dipIdx;
    const totalDuration = recIdx - peakIdx;

    // Gyroscope features
    const gyroMag = (s) => {
      const gx = s.gx || 0, gy = s.gy || 0, gz = s.gz || 0;
      return Math.sqrt(gx * gx + gy * gy + gz * gz);
    };

    const gyroMagAtPeak = gyroMag(peakSample);
    const gyroMagAtDip = gyroMag(dipSample);

    // Max gyro in window [peak-5 .. recovery+5]
    let maxGyroInWindow = 0;
    const winStart = Math.max(0, peakIdx - 5);
    const winEnd = Math.min(imuData.length - 1, recIdx + 5);
    for (let j = winStart; j <= winEnd; j++) {
      const g = gyroMag(imuData[j]);
      if (g > maxGyroInWindow) maxGyroInWindow = g;
    }

    // Mean gyro from dip to recovery
    let gyroSum = 0;
    let gyroCount = 0;
    for (let j = dipIdx; j <= recIdx; j++) {
      gyroSum += gyroMag(imuData[j]);
      gyroCount++;
    }
    const gyroDipToRec = gyroCount > 0 ? gyroSum / gyroCount : 0;

    return {
      peakMag,
      dipMag,
      recoveryMag,
      range,
      dipRatio,
      peakToDipSamples,
      dipToRecSamples,
      totalDuration,
      gyroMagAtPeak,
      gyroMagAtDip,
      maxGyroInWindow,
      gyroDipToRec,
    };
  }

  // --- Compute per-feature stats from a set of patterns ---
  static computeProfile(patterns) {
    if (!patterns || patterns.length === 0) return null;

    const featureKeys = [
      'peakMag', 'dipMag', 'recoveryMag', 'range', 'dipRatio',
      'peakToDipSamples', 'dipToRecSamples', 'totalDuration',
      'gyroMagAtPeak', 'gyroMagAtDip', 'maxGyroInWindow', 'gyroDipToRec',
    ];

    const profile = { count: patterns.length };

    for (const key of featureKeys) {
      const vals = patterns.map(p => p[key]).filter(v => v != null && !isNaN(v));
      if (vals.length === 0) {
        profile[key] = { mean: 0, std: 0, min: 0, max: 0 };
        continue;
      }
      const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
      const variance = vals.reduce((a, v) => a + (v - mean) ** 2, 0) / vals.length;
      const std = Math.sqrt(variance);
      profile[key] = {
        mean,
        std,
        min: Math.min(...vals),
        max: Math.max(...vals),
      };
    }

    return profile;
  }

  // --- Run full calibration from 4 activity recordings ---
  static calibrate(walkingIMU, runningIMU, dribblingIMU, shootingIMU) {
    const walkPatterns = MotionCalibrator.extractPatterns(walkingIMU, 'walking');
    const runPatterns = MotionCalibrator.extractPatterns(runningIMU, 'running');
    const dribblePatterns = MotionCalibrator.extractPatterns(dribblingIMU, 'dribbling');
    const shootPatterns = MotionCalibrator.extractPatterns(shootingIMU, 'shooting');

    const cal = {
      timestamp: Date.now(),
      profiles: {
        walking: MotionCalibrator.computeProfile(walkPatterns),
        running: MotionCalibrator.computeProfile(runPatterns),
        dribbling: MotionCalibrator.computeProfile(dribblePatterns),
        shooting: MotionCalibrator.computeProfile(shootPatterns),
      },
      patternCounts: {
        walking: walkPatterns.length,
        running: runPatterns.length,
        dribbling: dribblePatterns.length,
        shooting: shootPatterns.length,
      },
    };

    MotionCalibrator.save(cal);
    return cal;
  }

  // --- Classify a candidate using calibration profiles ---
  static classify(features, calibration) {
    if (!calibration || !calibration.profiles) {
      return { isShot: true, confidence: 0, reason: 'no calibration' };
    }

    const shootProf = calibration.profiles.shooting;
    if (!shootProf) {
      return { isShot: true, confidence: 0, reason: 'no shooting profile' };
    }

    // Stage 1: Hard reject — dip too shallow for a real shot
    if (shootProf.dipRatio && shootProf.dipRatio.std > 0) {
      const maxShotDipRatio = shootProf.dipRatio.mean + 2 * shootProf.dipRatio.std;
      const noiseProfiles = ['walking', 'running', 'dribbling'];
      for (const label of noiseProfiles) {
        const prof = calibration.profiles[label];
        if (!prof || !prof.dipRatio) continue;
        const inNoiseRange = features.dipRatio >= prof.dipRatio.mean - prof.dipRatio.std &&
                             features.dipRatio <= prof.dipRatio.mean + prof.dipRatio.std;
        if (features.dipRatio > maxShotDipRatio && inNoiseRange) {
          return { isShot: false, confidence: 0.9, reason: `dipRatio ${features.dipRatio.toFixed(2)} matches ${label}, exceeds shot range` };
        }
      }
    }

    // Stage 2: Weighted distance scoring
    const weights = {
      peakMag: 1.0,
      dipMag: 3.0,
      dipRatio: 3.0,
      recoveryMag: 1.0,
      range: 2.0,
      peakToDipSamples: 0.5,
      dipToRecSamples: 0.5,
      totalDuration: 0.5,
      gyroMagAtPeak: 1.0,
      gyroMagAtDip: 1.0,
      maxGyroInWindow: 1.5,
      gyroDipToRec: 2.5,
    };

    const distTo = (profile) => {
      if (!profile) return Infinity;
      let sumWeightedZ = 0;
      let totalWeight = 0;
      for (const key of Object.keys(weights)) {
        const stat = profile[key];
        if (!stat || stat.std === 0) continue;
        const z = Math.abs(features[key] - stat.mean) / stat.std;
        sumWeightedZ += z * weights[key];
        totalWeight += weights[key];
      }
      return totalWeight > 0 ? sumWeightedZ / totalWeight : Infinity;
    };

    const shootDist = distTo(shootProf);
    const walkDist = distTo(calibration.profiles.walking);
    const runDist = distTo(calibration.profiles.running);
    const dribbleDist = distTo(calibration.profiles.dribbling);
    const minNoiseDist = Math.min(walkDist, runDist, dribbleDist);

    const margin = 0.5;
    if (shootDist > minNoiseDist + margin) {
      const closestNoise = walkDist <= runDist && walkDist <= dribbleDist ? 'walking'
        : runDist <= dribbleDist ? 'running' : 'dribbling';
      return {
        isShot: false,
        confidence: Math.min(1, (shootDist - minNoiseDist) / 3),
        reason: `closer to ${closestNoise} (shot:${shootDist.toFixed(1)} vs ${closestNoise}:${minNoiseDist.toFixed(1)})`,
      };
    }

    return {
      isShot: true,
      confidence: Math.min(1, (minNoiseDist - shootDist + margin) / 3),
      reason: `shot dist=${shootDist.toFixed(1)}, nearest noise=${minNoiseDist.toFixed(1)}`,
    };
  }

  // --- localStorage persistence ---
  static save(cal) {
    try {
      localStorage.setItem(CALIB_STORAGE_KEY, JSON.stringify(cal));
    } catch (e) { /* quota exceeded, silently fail */ }
  }

  static load() {
    try {
      const raw = localStorage.getItem(CALIB_STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }

  static clear() {
    localStorage.removeItem(CALIB_STORAGE_KEY);
  }

  static hasCalibration() {
    return MotionCalibrator.load() !== null;
  }
}


// ===== Multi-Detector Consensus System =====

class ShotDetectorConsensus {
  // Multiple detection methods that each vote on whether a candidate is a shot.
  // Each returns { vote: true/false, confidence: 0-1, name, detail }

  // Method 1: Window σ — large rolling window std deviation spike
  // Looks for the std of a 200-sample window to exceed threshold
  static windowSigma(aMags, peakIdx, opts = {}) {
    const windowSize = opts.windowSize || 200;
    const sigma = opts.sigma || 4.0;

    const halfW = Math.floor(windowSize / 2);
    const start = Math.max(0, peakIdx - halfW);
    const end = Math.min(aMags.length, peakIdx + halfW);
    const slice = aMags.slice(start, end);
    if (slice.length < 40) return { vote: false, confidence: 0, name: 'Window-σ', detail: 'too few samples' };

    const mean = slice.reduce((a, b) => a + b, 0) / slice.length;
    const variance = slice.reduce((a, v) => a + (v - mean) ** 2, 0) / slice.length;
    const std = Math.sqrt(variance);

    // The peak itself should stand out
    const zScore = (aMags[peakIdx] - mean) / (std || 1);
    const pass = zScore > sigma;

    return {
      vote: pass,
      confidence: Math.min(1, zScore / (sigma + 2)),
      name: `Window-${windowSize}σ`,
      detail: `z=${zScore.toFixed(1)} (thresh=${sigma.toFixed(1)})`,
    };
  }

  // Method 2: Envelope ratio — compare short window around peak to longer baseline
  // peak_env (50 samples) vs baseline_env (200 samples) ratio
  static envelopeRatio(aMags, peakIdx, opts = {}) {
    const shortW = opts.shortWindow || 50;
    const longW = opts.longWindow || 200;
    const sigma = opts.sigma || 4.0;

    // Short window centered on peak
    const sStart = Math.max(0, peakIdx - Math.floor(shortW / 2));
    const sEnd = Math.min(aMags.length, sStart + shortW);
    const shortSlice = aMags.slice(sStart, sEnd);
    if (shortSlice.length < 10) return { vote: false, confidence: 0, name: 'Envelope', detail: 'too few short' };

    // Long window before peak (baseline)
    const lEnd = Math.max(0, peakIdx - Math.floor(shortW / 2));
    const lStart = Math.max(0, lEnd - longW);
    const longSlice = aMags.slice(lStart, lEnd);
    if (longSlice.length < 20) return { vote: false, confidence: 0, name: 'Envelope', detail: 'too few long' };

    const shortMax = Math.max(...shortSlice);
    const shortMin = Math.min(...shortSlice);
    const shortRange = shortMax - shortMin;

    const longMean = longSlice.reduce((a, b) => a + b, 0) / longSlice.length;
    const longVar = longSlice.reduce((a, v) => a + (v - longMean) ** 2, 0) / longSlice.length;
    const longStd = Math.sqrt(longVar);

    const ratio = longStd > 0 ? shortRange / longStd : shortRange;
    const pass = ratio > sigma;

    return {
      vote: pass,
      confidence: Math.min(1, ratio / (sigma + 3)),
      name: `Envelope-${shortW}v${longW}`,
      detail: `ratio=${ratio.toFixed(1)} (thresh=${sigma.toFixed(1)})`,
    };
  }

  // Method 3: Dip depth — how close to freefall (0g) does the dip get
  // Shots should approach 0-3 m/s², walking/running stays above 5
  static dipDepth(aMags, peakIdx, dipIdx, opts = {}) {
    const maxDipForShot = opts.maxDip || 5.0;
    const dipVal = aMags[dipIdx];
    const pass = dipVal < maxDipForShot;

    return {
      vote: pass,
      confidence: pass ? Math.min(1, (maxDipForShot - dipVal) / maxDipForShot) : 0,
      name: 'DipDepth',
      detail: `dip=${dipVal.toFixed(1)} (thresh<${maxDipForShot})`,
    };
  }

  // Method 4: Peak prominence — peak must stand out from local neighborhood
  static peakProminence(aMags, peakIdx, opts = {}) {
    const neighborhoodSize = opts.neighborhood || 100;
    const minProminence = opts.minProminence || 5.0;

    const start = Math.max(0, peakIdx - neighborhoodSize);
    const end = Math.min(aMags.length, peakIdx + neighborhoodSize);

    // Find lowest valley on each side
    let leftMin = aMags[peakIdx];
    for (let j = peakIdx - 1; j >= start; j--) {
      if (aMags[j] < leftMin) leftMin = aMags[j];
    }

    let rightMin = aMags[peakIdx];
    for (let j = peakIdx + 1; j < end; j++) {
      if (aMags[j] < rightMin) rightMin = aMags[j];
    }

    const prominence = aMags[peakIdx] - Math.max(leftMin, rightMin);
    const pass = prominence > minProminence;

    return {
      vote: pass,
      confidence: Math.min(1, prominence / (minProminence * 2)),
      name: 'Prominence',
      detail: `prom=${prominence.toFixed(1)} (thresh>${minProminence})`,
    };
  }

  // --- Run all detectors and produce consensus ---
  static evaluate(aMags, peakIdx, dipIdx, recIdx, opts = {}) {
    const methods = [
      ShotDetectorConsensus.windowSigma(aMags, peakIdx, opts.windowSigma),
      ShotDetectorConsensus.envelopeRatio(aMags, peakIdx, opts.envelopeRatio),
      ShotDetectorConsensus.dipDepth(aMags, peakIdx, dipIdx, opts.dipDepth),
      ShotDetectorConsensus.peakProminence(aMags, peakIdx, opts.peakProminence),
    ];

    const votes = methods.filter(m => m.vote).length;
    const total = methods.length;
    const minVotes = opts.minVotes || 3; // default: need 3 of 4 to agree

    return {
      isShot: votes >= minVotes,
      votes,
      total,
      confidence: votes / total,
      methods,
    };
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
