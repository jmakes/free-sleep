# Snore detection v0 (piezo spectral heuristic)

Prototype only. **Not** Eight Sleep’s neural net, **not** a medical device, and **not** mic-based.

## Sensor path (OEM-aligned)

Eight Sleep’s chest-level piezo picks up **body-wall vibrations** from snoring (not air acoustic pressure). Free Sleep already stores full piezo waveforms in CBOR `.RAW` files as `piezo-dual` rows:

- Sample rate **500 Hz** (`freq: 500`)
- Channels `left1` / `left2` / `right1` / `right2` as packed **int32** arrays (**500 samples per ~1 s packet**)
- Presence / vitals pipelines often collapse packets to avg / min / max / range, but the **full arrays remain in `.RAW`**

Loader: `biometrics/load_raw_files.py` (`load_piezo_row` → `np.frombuffer(..., dtype=np.int32)`).

## Algorithm sketch

| Step | Detail |
|------|--------|
| Gate | Sleep `present_intervals` (preferred) or piezo packet range |
| Band | **20–150 Hz** Butterworth bandpass + Welch PSD |
| Why that band | Vitals use ~0.5–20 Hz for HR/BR; snore vibration energy is typically tens–~150 Hz; Nyquist is 250 Hz |
| Features / packet | snore-band power, low-band (0.5–20) power, **ratio**, **peakiness** (max/mean PSD in band), band RMS, movement flag (extreme peak-to-peak) |
| Aggregate | Per-**minute** medians over present packets |
| Score | Night-adaptive: quiet-presence baseline = median + k·MAD on ratio, peakiness, and band RMS (no person-specific physiology constants) |
| Reject | Night-adaptive peak-to-peak (median + 3·MAD) **and** snore-band ratio ≤ night median → likelihood 0 (loud snore can raise PTP without looking like a toss) |

Offline runner: `scripts/analyze_snore_v0.py`  
Core features: `biometrics/snore/features.py`

```bash
# On a host that can read Pod RAW + call the metrics API:
python3 scripts/analyze_snore_v0.py \
  --raw-dir "$RAW_DATA_FOLDER" \
  --pod-api "$POD_API" \
  --night-ids <left_id>,<right_id> \
  --out /tmp/snore_v0.json
```

## Persist / Sleep-page path (not shipped yet)

Do **not** add UI until overnight runs look plausible (clustered snore minutes during sleep, not only during tosses).

Proposed attachment (parallel to `vitals` / `movement`):

1. **SQLite** table e.g. `snore_minutes (side, timestamp, likelihood, snore_binary)` at 1-minute resolution, retention similar to movement (~30 d), **or** night-level summary columns / JSON on `sleep_records` (`snore_minutes_total`, optional timeline blob).
2. **Compute** offline first; later optionally from `analyze_sleep` / a post-night job that streams `.RAW` (same CBOR path as vitals — do not alter live stream presence/HR paths).
3. **API** `GET /api/metrics/snore?side=&startTime=&endTime=` mirroring vitals/movement.
4. **UI** Sleep page: total snore minutes on `SleepRecordCard` + optional timeline under stages/restlessness (clearly labeled heuristic).

## Caveats

- Early-bed clusters may include talking / settling, not only snore.
- Cross-side bleed and partner motion can inflate the opposite channel.
- Gross movement shares broadband energy; movement gating is imperfect.
- Absolute thresholds are night-relative — very quiet or very noisy nights shift the bar.
- No apnea event detection in v0.

## Status

v0 = solid offline script + this note. Deploy / DB / UI only after signal review.
