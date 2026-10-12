// Pick the default sleep record to show: the longest record belonging to the
// most recent night (not simply the last record). Records whose wake time
// falls within the same noon-to-noon window are the same night, so a night
// that was split into fragments still shows its main period.

export type NightRecordLike = {
  left_bed_at: string;
  sleep_period_seconds: number;
};

const NIGHT_SHIFT_MS = 12 * 60 * 60 * 1000;

export function nightKey(leftBedAt: string): string {
  const shifted = new Date(new Date(leftBedAt).getTime() - NIGHT_SHIFT_MS);
  return `${shifted.getFullYear()}-${shifted.getMonth() + 1}-${shifted.getDate()}`;
}

export function pickLongestOfLatestNight<T extends NightRecordLike>(records: readonly T[] | undefined): T | undefined {
  if (!records?.length) return undefined;
  const latest = records.reduce((a, b) =>
    new Date(b.left_bed_at).getTime() > new Date(a.left_bed_at).getTime() ? b : a);
  const key = nightKey(latest.left_bed_at);
  return records
    .filter((r) => nightKey(r.left_bed_at) === key)
    .reduce((a, b) => (b.sleep_period_seconds > a.sleep_period_seconds ? b : a));
}
