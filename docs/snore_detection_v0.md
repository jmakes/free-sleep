# Snore detection v0 (piezo spectral heuristic)

Prototype. **Not** Eight Sleep’s neural net, **not** a medical device, and **not** mic-based.

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

Core: `biometrics/snore/features.py`, `biometrics/snore/analyze.py`  
Offline runner: `scripts/analyze_snore_v0.py`  
Post-night: `analyze_sleep.py` calls `snore.persist.detect_snore` after presence/movement (additive; failures are non-fatal).

```bash
# Against Pod RAW + sleep API:
python3 scripts/analyze_snore_v0.py \
  --raw-dir "$RAW_DATA_FOLDER" \
  --pod-api "$POD_API" \
  --night-ids <left_id>,<right_id> \
  --out /tmp/snore_v0.json

# Persist heuristic timeline into SQLite (snore table + sleep_records.snore_minutes):
python3 scripts/analyze_snore_v0.py \
  --raw-dir "$RAW_DATA_FOLDER" \
  --side right --start <UTC_ISO> --end <UTC_ISO> \
  --persist
```

## Persist / API (chunk 1)

Mirrors movement:

1. **SQLite** `snore (side, timestamp, snore, likelihood)` at 1-minute resolution during presence; retention ~30 d (`FREE_SLEEP_SNORE_RETENTION_DAYS`).
2. **Night total** `sleep_records.snore_minutes` (nullable Int) — heuristic count of snore-labeled minutes.
3. **Compute** from `analyze_sleep` after presence/movement, streaming `.RAW` (does not alter live vitals/presence).
4. **API** `GET /api/metrics/snore?side=&startTime=&endTime=` — each row includes `heuristic: true`. Sleep records expose optional `snore_minutes`.

## Sleep-page UI (chunk 2)

Sleep page: total snore minutes on `SleepRecordCard` (labeled heuristic) + minute timeline `SnoreChart` under restlessness, wired to `GET /api/metrics/snore` and `sleep_records.snore_minutes`.

## Caveats

- Early-bed clusters may include talking / settling, not only snore.
- Cross-side bleed and partner motion can inflate the opposite channel.
- Gross movement shares broadband energy; movement gating is imperfect.
- Absolute thresholds are night-relative — very quiet or very noisy nights shift the bar.
- No apnea event detection in v0.

## Status

- **Chunk 1 (this):** schema + analyze-sleep wiring + offline `--persist` + metrics API fields labeled heuristic.
- **Chunk 2 (this):** Sleep-page UI (`SleepRecordCard` total + `SnoreChart` timeline).
- **Chunk 3:** bump / Pod deploy when Jake asks.
