// Mirrors GET /api/water (server/src/8sleep/waterState.ts). The Pod firmware
// only reports a low-water flag; levelPercent is always null.
export type WaterStatus = {
  state: 'ok' | 'low' | 'unknown';
  isLow: boolean;
  isPriming: boolean;
  source: 'firmware_flag';
  levelPercent: null;
  rawValue: string | null;
  lowSince: string | null;
  lastChangedAt: string | null;
  lastCheckedAt: string | null;
  lowForSeconds: number;
  alertAfterSeconds: number;
  alert: boolean;
  stale: boolean;
};

export type WaterBannerModel = { severity: 'warning' | 'info'; text: string } | null;

function hhmm(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function waterBanner(status: WaterStatus | undefined): WaterBannerModel {
  if (!status) return null;
  if (status.isLow) {
    const since = status.lowSince ? ` (low since ${hhmm(status.lowSince)})` : '';
    return { severity: 'warning', text: `Water tank is low or empty. Refill the water tank${since}.` };
  }
  if (status.state === 'unknown' && status.rawValue !== null) {
    return { severity: 'warning', text: `Unexpected water level value from the Pod: '${status.rawValue}'` };
  }
  return null;
}

export function waterLabel(status: WaterStatus | undefined): string {
  if (!status || status.state === 'unknown') return 'Unknown';
  if (status.isLow) return 'Low';
  return 'OK';
}
