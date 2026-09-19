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
| Flicker | < 45s | Ignored |

Presence fusion is piezo-primary OR cap soft-assist: empty only when **both** miss, so a long empty gap is already a dual-sensor miss. This replaces the old 45s exit rule that produced “22 exits” nights.

New analyzes write `times_exited_bed` with the 5-minute rule. The UI also **recomputes** exits from `not_present_intervals` so older DB rows display correctly without re-analyze.

## `stage_v1` rules (5-minute epochs)

Signals per epoch (within the sleep night):

1. **Presence** — overlap with a not-present gap ≥ 45s → **Awake**
2. **Movement** — same bins as the restlessness chart (quiet < 200, stirring 200–900, restless ≥ 900 on `total_movement`)
3. **Vitals** — HR / HRV / breathing vs **night median**

Classification priority:

1. Presence gap → Awake  
2. Restless + elevated HR (or no HR) → Awake (arousal)  
3. Quiet + HR ≤ night median + breathing ≤ ~median + HRV not elevated → **Deep**  
4. Quiet/stirring + HR ≥ 105% median + HRV ≥ 108% median → **REM**  
5. Else → **Light**  
6. Without vitals: restless → Awake, else Light (no fake Deep/REM)

**Smoothing:** Deep / REM runs shorter than **10 minutes** (2 epochs) demote to Light.

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

### How to verify (left vs Garmin)

1. Open Sleep → select **Left** (Hsiaolin).  
2. Confirm Restlessness says Quiet/Stirring/Restless (not REM/Light/Awake).  
3. Confirm exits are small integers for a normal night; brief gaps listed separately.  
4. Note Free Sleep score + component breakdown for that night.  
5. Compare later to Garmin sleep score for the same night (directionally, not exact).  
6. Re-run Analyze on left after deploy to refresh `times_exited_bed` in SQLite (optional; UI already recomputes).

## Non-goals / blockers

- Right-side staging can wait until cal is trustworthy.  
- No Pod deploy from this change set unless explicitly requested.  
- Score is not yet calibrated to Garmin — treat as explainable v1 only.
