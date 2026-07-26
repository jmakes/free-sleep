import logger from '../logger.js';
import { pruneMetrics } from '../db/metricsRetention.js';

const FIRST_RUN_DELAY_MS = Number(process.env.FREE_SLEEP_PRUNE_FIRST_DELAY_MS ?? 3 * 60 * 1000);
const INTERVAL_MS = Number(process.env.FREE_SLEEP_PRUNE_INTERVAL_MS ?? 6 * 60 * 60 * 1000);

let started = false;
let running = false;

async function runPrune(reason: string) {
  if (running) {
    logger.debug(`Skipping metrics prune (${reason}); previous run still in progress`);
    return;
  }
  running = true;
  try {
    await pruneMetrics({ reason });
  } catch (error) {
    logger.error(`Metrics prune failed (${reason}): ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    running = false;
  }
}

/**
 * Background retention loop independent of node-schedule job reloads.
 * First run a few minutes after boot, then every few hours.
 */
export function startMetricsRetentionJob() {
  if (started) return;
  started = true;

  logger.info(
    `Scheduling metrics retention: first run in ${Math.round(FIRST_RUN_DELAY_MS / 1000)}s, then every ${Math.round(INTERVAL_MS / 3600000)}h`
  );

  setTimeout(() => {
    void runPrune('startup');
    setInterval(() => {
      void runPrune('interval');
    }, INTERVAL_MS);
  }, FIRST_RUN_DELAY_MS);
}
