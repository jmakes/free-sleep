"""
Piezo snore spectral features (v0 heuristic).

Band justification
------------------
OEM / literature: snore body-wall vibration energy often sits in the tens–~150 Hz
range. Free Sleep piezo is 500 Hz (Nyquist 250 Hz). We use **20–150 Hz**:
- lower bound excludes ballistocardiogram / breathing / HR harmonics (~<20 Hz)
  that vitals already use (vitals bandpass is ~0.5–20 Hz)
- upper bound matches the commonly cited snore ceiling and stays below Nyquist

This is *not* Eight Sleep's NN — only band energy + peakiness on presence epochs.
"""

from __future__ import annotations

from typing import Dict, List, Optional, Sequence, Tuple

import numpy as np
from scipy.signal import butter, filtfilt, welch

SNORE_BAND_HZ: Tuple[float, float] = (20.0, 150.0)
LOW_BAND_HZ: Tuple[float, float] = (0.5, 20.0)
SAMPLE_RATE = 500.0

# Soft per-packet hint only. Night-adaptive PTP in score_snore_minutes is authoritative
# because left/right ADC ranges differ by an order of magnitude.
DEFAULT_MOVEMENT_PTP = 2_000_000


def _bandpass(x: np.ndarray, low_hz: float, high_hz: float, fs: float = SAMPLE_RATE, order: int = 4) -> np.ndarray:
    nyq = 0.5 * fs
    low = max(low_hz / nyq, 1e-6)
    high = min(high_hz / nyq, 0.999)
    if low >= high:
        raise ValueError(f'Invalid bandpass {low_hz}-{high_hz} Hz at fs={fs}')
    b, a = butter(order, [low, high], btype='band')
    if len(x) < 3 * max(len(a), len(b)):
        return x.astype(np.float64) - np.mean(x)
    return filtfilt(b, a, x.astype(np.float64))


def _band_power(freqs: np.ndarray, psd: np.ndarray, lo: float, hi: float) -> float:
    mask = (freqs >= lo) & (freqs <= hi)
    if not np.any(mask):
        return 0.0
    return float(np.trapezoid(psd[mask], freqs[mask]))


def compute_packet_features(
    samples: np.ndarray,
    fs: float = SAMPLE_RATE,
    snore_band: Tuple[float, float] = SNORE_BAND_HZ,
    low_band: Tuple[float, float] = LOW_BAND_HZ,
    movement_ptp: float = DEFAULT_MOVEMENT_PTP,
) -> Dict[str, float]:
    """
    Spectral + time features for one piezo packet (~1 s @ 500 Hz).

    Returns keys used by minute aggregation / scoring.
    """
    x = np.asarray(samples, dtype=np.float64)
    if x.size < 64:
        return {
            'ok': 0.0,
            'ptp': 0.0,
            'movement': 1.0,
            'band_rms': 0.0,
            'snore_power': 0.0,
            'low_power': 0.0,
            'ratio': 0.0,
            'peakiness': 0.0,
            'flatness': 1.0,
        }

    ptp = float(np.ptp(x))
    # Soft hint only; night-adaptive PTP threshold is applied in score_snore_minutes.
    movement = 1.0 if (movement_ptp > 0 and ptp >= movement_ptp) else 0.0

    x = x - np.mean(x)
    snore_sig = _bandpass(x, snore_band[0], snore_band[1], fs=fs)
    band_rms = float(np.sqrt(np.mean(snore_sig ** 2)))

    nperseg = min(256, len(x))
    freqs, psd = welch(x, fs=fs, nperseg=nperseg, detrend='constant')
    snore_power = _band_power(freqs, psd, snore_band[0], snore_band[1])
    low_power = _band_power(freqs, psd, low_band[0], low_band[1])
    ratio = snore_power / (snore_power + low_power + 1e-12)

    band_mask = (freqs >= snore_band[0]) & (freqs <= snore_band[1])
    band_psd = psd[band_mask]
    if band_psd.size == 0 or np.all(band_psd <= 0):
        peakiness = 0.0
        flatness = 1.0
    else:
        mean_p = float(np.mean(band_psd)) + 1e-12
        peakiness = float(np.max(band_psd) / mean_p)
        pos = np.clip(band_psd, 1e-20, None)
        flatness = float(np.exp(np.mean(np.log(pos))) / (np.mean(pos) + 1e-20))

    return {
        'ok': 1.0,
        'ptp': ptp,
        'movement': movement,
        'band_rms': band_rms,
        'snore_power': snore_power,
        'low_power': low_power,
        'ratio': ratio,
        'peakiness': peakiness,
        'flatness': flatness,
    }


def aggregate_minute_features(packet_rows: Sequence[Dict[str, float]]) -> Optional[Dict[str, float]]:
    """Median-aggregate packet features within one minute. None if empty."""
    if not packet_rows:
        return None
    keys = ('ptp', 'movement', 'band_rms', 'snore_power', 'low_power', 'ratio', 'peakiness', 'flatness')
    out: Dict[str, float] = {'n_packets': float(len(packet_rows))}
    for k in keys:
        vals = [float(r[k]) for r in packet_rows if r.get('ok', 1.0) >= 1.0]
        if not vals:
            out[k] = 0.0
        elif k == 'movement':
            out[k] = float(np.mean(vals))
        else:
            out[k] = float(np.median(vals))
    return out


def _mad(arr: np.ndarray) -> float:
    med = float(np.median(arr))
    return float(np.median(np.abs(arr - med))) + 1e-12


def score_snore_minutes(
    minutes: List[Dict[str, float]],
    *,
    ratio_mad_k: float = 2.0,
    peakiness_mad_k: float = 1.5,
    band_rms_mad_k: float = 2.0,
    ptp_mad_k: float = 3.0,
    min_quiet_minutes: int = 20,
) -> List[Dict[str, float]]:
    """
    Adaptive night-relative snore likelihood / binary label.

    Movement is night-adaptive on packet peak-to-peak (median + ptp_mad_k·MAD),
    not a fixed ADC count — sides/gains differ a lot.

    Baseline = quieter presence minutes. Thresholds are median + k·MAD on ratio,
    peakiness, and band_rms — no person-specific physiology constants.
    """
    present = [m for m in minutes if m.get('present', 1.0) >= 1.0]
    if len(present) < 5:
        for m in minutes:
            m['likelihood'] = 0.0
            m['snore'] = 0.0
            m['threshold_ratio'] = 0.0
            m['threshold_peakiness'] = 0.0
            m['threshold_ptp'] = 0.0
        return minutes

    ptps = np.array([m.get('ptp', 0.0) for m in present], dtype=np.float64)
    all_ratios = np.array([m.get('ratio', 0.0) for m in present], dtype=np.float64)
    ptp_med, ptp_mad = float(np.median(ptps)), _mad(ptps)
    thr_ptp = ptp_med + ptp_mad_k * ptp_mad
    # High PTP alone may be a loud snore. Call it movement only when PTP is
    # elevated AND snore-band share is not elevated above the night's median.
    movement_ratio_ceiling = float(np.median(all_ratios))

    for m in minutes:
        m['threshold_ptp'] = thr_ptp
        m['movement_ratio_ceiling'] = movement_ratio_ceiling
        m['movement'] = 1.0 if (
            m.get('ptp', 0.0) >= thr_ptp
            and m.get('ratio', 0.0) <= movement_ratio_ceiling
        ) else 0.0

    quiet = [m for m in present if m.get('movement', 0.0) < 1.0]
    if len(quiet) < min_quiet_minutes:
        quiet = present

    ratios = np.array([m['ratio'] for m in quiet], dtype=np.float64)
    peaks = np.array([m['peakiness'] for m in quiet], dtype=np.float64)
    rms = np.array([m.get('band_rms', 0.0) for m in quiet], dtype=np.float64)
    r_med, r_mad = float(np.median(ratios)), _mad(ratios)
    p_med, p_mad = float(np.median(peaks)), _mad(peaks)
    rms_med, rms_mad = float(np.median(rms)), _mad(rms)
    thr_r = r_med + ratio_mad_k * r_mad
    thr_p = p_med + peakiness_mad_k * p_mad
    thr_rms = rms_med + band_rms_mad_k * rms_mad

    for m in minutes:
        m['threshold_ratio'] = thr_r
        m['threshold_peakiness'] = thr_p
        m['threshold_band_rms'] = thr_rms
        if m.get('present', 1.0) < 1.0 or m.get('movement', 0.0) >= 1.0:
            m['likelihood'] = 0.0
            m['snore'] = 0.0
            continue
        r_score = max(0.0, (m['ratio'] - r_med) / r_mad) / max(ratio_mad_k, 1e-6)
        p_score = max(0.0, (m['peakiness'] - p_med) / p_mad) / max(peakiness_mad_k, 1e-6)
        b_score = max(0.0, (m.get('band_rms', 0.0) - rms_med) / rms_mad) / max(band_rms_mad_k, 1e-6)
        likelihood = float(np.clip(
            (max(r_score, 1e-6) * max(p_score, 1e-6) * max(b_score, 0.25)) ** (1 / 3),
            0.0,
            2.0,
        ))
        # Binary: elevated ratio+peakiness OR elevated band_rms+peakiness with ratio >= median
        is_snore = (
            (m['ratio'] >= thr_r and m['peakiness'] >= thr_p)
            or (
                m.get('band_rms', 0.0) >= thr_rms
                and m['peakiness'] >= thr_p
                and m['ratio'] >= r_med
            )
        )
        m['likelihood'] = likelihood
        m['snore'] = 1.0 if is_snore else 0.0
    return minutes
