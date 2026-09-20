# Sleep stage heuristic (`stage_v1`) and sleep score v1

Left-side-first path for Free Sleep. These are **heuristics**, not medical devices and not Eight Sleep / Garmin ground truth. After the Pod upgrade there is no Eight Sleep stage data to copy — validate the **sleep score** later against Garmin watches on the left (Hsiaolin) side where capacitance calibration is good.

Auto presence calibration is **not** required for staging. Keep auto-cal UI on **Side settings only** (not Features).

## Honest movement vs stages

| Chart | Labels | Source |
|-------|--------|--------|
| Restlessness | Quiet / Stirring / Restless | Mattress movement bins only |
| Sleep stages (heuristic v1) | Deep / Light / REM / Awake | Movement + HR + HRV + breathing + presence |

Movement must **never** be labeled REM / Light / Awake. Quiet stretches can be deep *or* REM; restless can be a toss *or* a wake.

## Bed exits

| Kind | Threshold | Shown as |
|------|-----------|----------|
| Meaningful exit | ≥ **5 minutes** away (or dual-sensor empty for that long) | “Times exited bed” |
| Brief gap | 45s – 5m | “Brief gaps” (optional) |
| Flicker | &lt; 45s | Ignored |

Presence fusion is piezo-primary OR cap soft-assist: empty only when **both** miss, so a long empty gap is already a dual-sensor miss. This replaces the old 45s exit rule that produced “22 exits” nights.

New analyzes write `times_exited_bed` with the 5-minute rule. The UI also **recomputes** exits from `not_present_intervals` so older DB rows display correctly without re-analyze.

## `stage_v1` rules (5-minute epochs)

Signals per epoch (within the sleep night):

1. **Presence** — overlap with a not-present gap ≥ 45s → **Awake**
2. **Movement** — same bins as the restlessness chart (quiet &lt; 200, stirring 200–900, restless ≥ 900 on `total_movement`)
3. **Vitals** — HR / breathing vs **sleep baseline** (quiet-movement epochs); HRV vs night median

### Sleep baseline HR / BR

- Prefer **median HR (and BR) of quiet-movement epochs** (`movementMax` &lt; 200), not the whole-night median (which includes wake and inflates the bar for “elevated”).
- If fewer than **6** quiet epochs with vitals: fall back to the **30th percentile** of all epoch HR (or BR) means.

### Awake rules (priority)

1. Presence gap → Awake (`presence_gap`)
2. **Sleep onset / latency:** from bed entry, epochs stay **Awake** (`sleep_onset`) until **3 consecutive** (~15 min) asleep-like epochs — quiet or mild stirring **and** HR ≤ baseline × **1.03** (or quiet-only if no vitals)
3. Restless movement → Awake (`arousal`), including no-vitals nights
4. Quiet + HR ≥ baseline × **1.10** → Awake (`elevated_hr_quiet`) — restless-mind / quiet-body wake
5. Stirring + HR ≥ baseline × **1.05** → Awake (`elevated_hr_stirring`)
6. Quiet + HR ≤ baseline + breathing ≤ ~baseline + HRV not elevated → **Deep**
7. Quiet/stirring + HR ≥ 105% baseline + HRV ≥ 108% median → **REM**
8. Else → **Light**
9. Without vitals: restless → Awake, else Light (no fake Deep/REM)

**Smoothing:**

- Deep / REM runs shorter than **10 minutes** (2 epochs) demote to Light.
- Isolated **single** elevated-HR Awake epochs sandwiched in sleep demote to Light (`smoothed_isolated_awake`); runs of **≥2** elevated-HR Awake epochs are kept (sustained mid-night wake).

Implementations:

- UI: `app/src/lib/sleepStageV1.ts`, chart `app/src/components/SleepStageChart.tsx`
- Python mirror: `biometrics/sleep_detection/stage_v1.py`

## Sleep score v1 (0–100)

| Component | Max | Idea |
|-----------|-----|------|
| Duration | 35 | Peak 7–9h; taper outside |
| Continuity | 25 | −5 per meaningful exit; small brief-gap penalty |
| Restfulness | 20 | Deep+REM share; awake penalty (or quiet movement fallback) |
| Vitals stability | 20 | Lower HR coefficient of variation; small HRV bonus |

UI: `app/src/lib/sleepScoreV1.ts` + `SleepScoreCard`. Python: `biometrics/sleep_detection/sleep_score_v1.py`.

More awake % lowers restfulness naturally — that is intended when onset latency and quiet elevated-HR wake are real.

### How to verify (left vs Garmin)

1. Open Sleep → select **Left** (Hsiaolin).  
2. Confirm Restlessness says Quiet/Stirring/Restless (not REM/Light/Awake).  
3. Confirm exits are small integers for a normal night; brief gaps listed separately.  
4. Note Free Sleep score + component breakdown for that night.  
5. Compare later to Garmin sleep score for the same night (directionally, not exact).  
6. Re-run Analyze on left after deploy to refresh `times_exited_bed` in SQLite (optional; UI already recomputes).

Right-side check (Jake): long latency before ~11pm local should show Awake; mid-night ~1h elevated-HR stretch should stay Awake (not Light).

## Non-goals / blockers

- Right-side staging can wait until cal is trustworthy.  
- No Pod deploy from this change set unless explicitly requested.  
- Score is not yet calibrated to Garmin — treat as explainable v1 only.
