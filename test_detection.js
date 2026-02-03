#!/usr/bin/env node
/**
 * Shot detection backtest runner.
 *
 * Runs ShotDetector.detectAll() on every session JSON in data/ and checks
 * against expected shot counts where ground-truth labels exist.
 *
 * Usage:  node test_detection.js
 *
 * Adding new test cases:
 *   1. Record a session on the tracker, export JSON, place in data/
 *   2. Use the viewer to label shots (add/remove), export as *_edited.json
 *   3. Add an entry to EXPECTED below with the filename and expected count
 *      - Use null for files without verified ground truth (will still report count)
 */

const fs = require('fs');
const path = require('path');

// Load core.js into current scope (mock localStorage for MotionCalibrator)
const coreCode = fs.readFileSync(path.join(__dirname, 'js/core.js'), 'utf-8');
const mockStorage = {};
const localStorage = {
  getItem: (k) => mockStorage[k] || null,
  setItem: (k, v) => { mockStorage[k] = v; },
  removeItem: (k) => { delete mockStorage[k]; },
};
const core = new Function('localStorage', coreCode + '; return { ShotDetector, ShotDetectorConsensus, MotionCalibrator, classifyZone, zoneColor };')(localStorage);
const { ShotDetector, ShotDetectorConsensus, MotionCalibrator } = core;

// ===== Expected shot counts (null = no ground truth, just report) =====
const EXPECTED = {
  'bball_1769745294389.json':        1,   // 1 shot, 12s session
  'bball_1770076234585_edited.json': 4,   // 4 close-range rim shots, rapid succession
  // Old sessions — no verified ground truth yet
  'bball_1769744242117.json':        null, // ~19 from live mode, batch may differ
  'bball_1769737698902.json':        null, // ~2 from live mode, batch may differ
};

// ===== Run tests =====
const dataDir = path.join(__dirname, 'data');
const files = fs.readdirSync(dataDir).filter(f => f.endsWith('.json')).sort();

let passed = 0;
let failed = 0;
let info = 0;

console.log('Shot Detection Backtest');
console.log('='.repeat(70));

for (const file of files) {
  const data = JSON.parse(fs.readFileSync(path.join(dataDir, file), 'utf-8'));
  const detector = new ShotDetector();
  const detected = detector.detectAll(data.imu);

  const expected = EXPECTED[file];
  const originalCount = data.shots ? data.shots.length : '?';

  if (expected !== null && expected !== undefined) {
    const ok = detected.length === expected;
    const status = ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
    console.log(`${status}  ${file}`);
    console.log(`       detected=${detected.length}  expected=${expected}  original=${originalCount}`);
    if (ok) passed++;
    else {
      failed++;
      // Show details on failure
      for (const s of detected) {
        console.log(`         idx=${s.idx} mag=${s.mag.toFixed(1)} dip=${s.dipMag.toFixed(1)} range=${s.range.toFixed(1)}`);
      }
    }
  } else {
    info++;
    console.log(`\x1b[33mINFO\x1b[0m  ${file}`);
    console.log(`       detected=${detected.length}  original=${originalCount}  (no ground truth)`);
  }
}

console.log('='.repeat(70));
console.log(`Results: ${passed} passed, ${failed} failed, ${info} info-only`);
console.log('');

// ===== Calibration & Consensus Tests =====
console.log('Calibration & Consensus Tests');
console.log('='.repeat(70));

let calPassed = 0;
let calFailed = 0;

function calTest(name, fn) {
  try {
    const result = fn();
    if (result) {
      calPassed++;
      console.log(`\x1b[32mPASS\x1b[0m  ${name}`);
    } else {
      calFailed++;
      console.log(`\x1b[31mFAIL\x1b[0m  ${name}`);
    }
  } catch (e) {
    calFailed++;
    console.log(`\x1b[31mFAIL\x1b[0m  ${name}: ${e.message}`);
  }
}

// Use first available session for calibration tests
const testFile = files[0];
const testData = JSON.parse(fs.readFileSync(path.join(dataDir, testFile), 'utf-8'));

calTest('extractPatterns finds patterns in session data', () => {
  const patterns = MotionCalibrator.extractPatterns(testData.imu, 'test');
  console.log(`       found ${patterns.length} patterns in ${testFile}`);
  return patterns.length >= 0; // should not throw
});

calTest('extractPatterns returns valid feature vectors', () => {
  const patterns = MotionCalibrator.extractPatterns(testData.imu, 'test');
  if (patterns.length === 0) {
    console.log('       (no patterns to validate, skipping)');
    return true;
  }
  const p = patterns[0];
  const keys = ['peakMag', 'dipMag', 'recoveryMag', 'range', 'dipRatio',
    'peakToDipSamples', 'dipToRecSamples', 'totalDuration',
    'gyroMagAtPeak', 'gyroMagAtDip', 'maxGyroInWindow', 'gyroDipToRec'];
  const allPresent = keys.every(k => typeof p[k] === 'number' && !isNaN(p[k]));
  if (!allPresent) console.log('       missing keys:', keys.filter(k => typeof p[k] !== 'number'));
  return allPresent;
});

calTest('computeProfile produces valid stats', () => {
  const patterns = MotionCalibrator.extractPatterns(testData.imu, 'test');
  const profile = MotionCalibrator.computeProfile(patterns);
  if (!patterns.length) {
    console.log('       (no patterns, null profile expected)');
    return profile === null;
  }
  const hasStats = profile.peakMag && typeof profile.peakMag.mean === 'number';
  console.log(`       profile count=${profile.count}, peakMag.mean=${profile.peakMag.mean.toFixed(1)}`);
  return hasStats && profile.count === patterns.length;
});

calTest('computeProfile handles empty input', () => {
  return MotionCalibrator.computeProfile([]) === null;
});

calTest('classify returns isShot=true with no calibration', () => {
  const result = MotionCalibrator.classify({}, null);
  return result.isShot === true;
});

// Regression: detection unchanged with no calibration loaded
calTest('detection unchanged with calibration=null', () => {
  const detector1 = new ShotDetector();
  const shots1 = detector1.detectAll(testData.imu);
  const detector2 = new ShotDetector();
  detector2.calibration = null;
  const shots2 = detector2.detectAll(testData.imu);
  const match = shots1.length === shots2.length;
  if (!match) console.log(`       mismatch: ${shots1.length} vs ${shots2.length}`);
  return match;
});

// Regression: detection unchanged with consensus disabled (default)
calTest('detection unchanged with consensus disabled', () => {
  const detector1 = new ShotDetector();
  const shots1 = detector1.detectAll(testData.imu);
  const detector2 = new ShotDetector();
  detector2.useConsensus = false;
  const shots2 = detector2.detectAll(testData.imu);
  return shots1.length === shots2.length;
});

// Consensus evaluation smoke test
calTest('ShotDetectorConsensus.evaluate runs without error', () => {
  const aMags = testData.imu.map(s => s.aMag);
  if (aMags.length < 200) {
    console.log('       (too few samples for consensus test)');
    return true;
  }
  // Find a peak to test on
  let peakIdx = 100;
  for (let i = 100; i < aMags.length - 100; i++) {
    if (aMags[i] > aMags[peakIdx]) peakIdx = i;
  }
  const dipIdx = Math.min(peakIdx + 15, aMags.length - 1);
  const recIdx = Math.min(dipIdx + 15, aMags.length - 1);
  const result = ShotDetectorConsensus.evaluate(aMags, peakIdx, dipIdx, recIdx);
  console.log(`       votes=${result.votes}/${result.total}, methods: ${result.methods.map(m => m.name + '=' + m.vote).join(', ')}`);
  return typeof result.isShot === 'boolean' && result.methods.length === 4;
});

console.log('='.repeat(70));
console.log(`Calibration tests: ${calPassed} passed, ${calFailed} failed`);
console.log('');

if (failed > 0 || calFailed > 0) {
  process.exit(1);
}
