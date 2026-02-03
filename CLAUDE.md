# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Pocket-based basketball shot tracker web app. Uses phone IMU sensors (accelerometer, gyroscope) to passively detect jump shots while the phone is in the user's left pocket or left hand. The player dribbles/shoots with their right hand. Designed for mid-range right-hand jump shots during walking/jogging (not sprinting).

## Current State

The project originated as a CodePen prototype (vanilla JS, single-file). It is being converted into a proper web app. There is no build system, framework, or package manager yet — structure those as needed.

## Shot Detection Algorithm

The core detection uses a **three-phase IMU signature**: Peak Spike → Low Dip → Recovery Peak.

1. **Peak Spike**: Local maximum in acceleration magnitude, must exceed `baseline_mean + PEAK_SIGMA * baseline_std` (PEAK_SIGMA=2.5) and absolute minimum of 14 m/s².
2. **Low Dip**: Minimum acceleration within 35 samples after peak, must fall below `baseline_mean - DIP_SIGMA * baseline_std` (DIP_SIGMA=1.5) and absolute max of 4 m/s².
3. **Recovery Peak**: Local maximum within 30 samples after dip, must exceed `baseline_mean + RECOVERY_SIGMA * baseline_std` (RECOVERY_SIGMA=1.0) with at least 8 m/s² rise from dip.

Additional constraints:
- Peak-to-dip range must exceed `baseline_std * PEAK_TO_DIP_SIGMA` (5.0) and absolute minimum of 12 m/s².
- Minimum 2000ms between shots (`MIN_SHOT_INTERVAL`).
- Minimum 60 samples between shots (`MIN_SHOT_SAMPLES`).
- Baseline computed from 80-sample window ending 20 samples before candidate peak.
- Baseline std capped at 3.0 for sigma thresholds (`MAX_EFFECTIVE_STD`).
- Scan window: samples `len-90` to `len-50` (looking ~1-2 seconds back).
- **Movement-aware**: when baseline std > 2.0 (active movement), stricter thresholds apply: peak ≥ 25, range ≥ 20, rise ≥ 15. Prevents walking/running from triggering false positives.
- **Retrospective burst filter**: clusters of 3+ shots within 12s of each other are pruned to ~1 per 8s, keeping highest-quality detections. Runs every 60s in live mode and after batch detection.

These thresholds were empirically tuned over real-world testing with walking, shorts, and various shooting scenarios. Adjust carefully.

## Court Position System

Uses a coordinate system centered on the rim at (0, 0) with y-axis extending toward half-court:
- **Rim**: (0, 0)
- **Free throw line**: (0, 4.6)
- **Top of 3-point arc**: (0, 7.24)
- **Left corner 3**: (-6.7, 0.9)
- **Right corner 3**: (6.7, 0.9)

Position is determined by:
1. **GPS calibration**: 10-second sampling at known court positions, median filtering.
2. **Quick anchors**: Instant position set to known court location.
3. **Future**: TLIO (Tight Learned Inertial Odometry) deep learning model for IMU-based position tracking.

Zone classification uses distance from rim + angle to categorize: RIM, PAINT, SHORT, FT-LINE, L/R-BASE, L/R-WING 3, L/R-CORNER 3, TOP 3. The 3-point boundary is at 6.7m (corner) / 7.24m (arc).

## Sensor Data Schema

IMU data collected at device-native rate (~50-100Hz):
```
{t, ax, ay, az, aMag, gx, gy, gz, moving}
```

GPS data (when available):
```
{t, lat, lng, acc}
```

Events (sparse):
```
{type: 'shot'|'anchor'|'gps_calibration'|'movement_change', t, ...metadata}
```

Export format is a single JSON blob with `imu`, `gps`, `events`, `shots` arrays plus session metadata and calibration data.

## Movement Detection

Uses a 20-sample sliding window of acceleration magnitude standard deviation:
- `std > 0.8` → moving
- 800ms hysteresis before transitioning to stationary
- Intensity normalized: `(std - 0.3) / 1.5`, clamped to [0, 1]

## Planned: TLIO Integration

Future deep learning model for court position tracking:
- **Input**: Rolling 2-5 second IMU window + last known position + time since last anchor
- **Output**: Displacement (dx, dy) + confidence + movement classification
- **Training data**: Anchor taps as ground truth, zone confirmations, GPS as noisy constraint
- **Basketball-specific patterns**: Shot motion, dribble rhythm, stationary stance, walking/running

Requires collecting diverse labeled sessions across different courts and GPS conditions.

## Key Design Constraints

- Phone is in **left pocket or left hand** during play
- Player shoots with **right hand** using full jump shot motion
- Movement is **walking or light jogging**, not sprinting
- Target: mid-range shots, though algorithm should generalize
- Must work passively — minimal user interaction during play
- Zone confirmation UI auto-dismisses after 3 seconds if user doesn't respond
- Acceleration buffer caps at 3000 samples, shifts by 1000 when exceeded
