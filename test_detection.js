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

// Load core.js into current scope
const coreCode = fs.readFileSync(path.join(__dirname, 'js/core.js'), 'utf-8');
const core = new Function(coreCode + '; return { ShotDetector, classifyZone, zoneColor };')();
const { ShotDetector } = core;

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

if (failed > 0) {
  process.exit(1);
}
