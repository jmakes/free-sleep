/**
 * Live sensor snapshot for the Sensors UI.
 *
 * Uses the proven Python CBOR/RAW loader (same stack as sleep analysis) so we
 * don't reimplement the Pod file format in Node. Results are cached briefly to
 * avoid overlapping python processes when the UI polls.
 */
import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import logger from '../logger.js';
const execFileAsync = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
/** Script lives next to other biometrics tools on the Pod tree */
function resolveDumpScript() {
    // dist/8sleep -> ../../../biometrics ; also absolute Pod install path
    const candidates = [
        path.resolve(__dirname, '../../../biometrics/dump_sensor_snapshot.py'),
        path.resolve(__dirname, '../../../../biometrics/dump_sensor_snapshot.py'),
        '/home/dac/free-sleep/biometrics/dump_sensor_snapshot.py',
    ];
    for (const candidate of candidates) {
        if (fs.existsSync(candidate))
            return candidate;
    }
    return candidates[candidates.length - 1];
}
const cache = {};
const CACHE_MS = 600;
async function runPythonSnapshot(side) {
    const script = resolveDumpScript();
    const python = '/home/dac/venv/bin/python';
    try {
        const { stdout, stderr } = await execFileAsync(python, ['-B', script, `--side=${side}`], {
            timeout: 8_000,
            maxBuffer: 2 * 1024 * 1024,
            env: { ...process.env },
        });
        if (stderr?.trim()) {
            logger.debug(`dump_sensor_snapshot stderr: ${stderr.trim().slice(0, 200)}`);
        }
        const parsed = JSON.parse(stdout);
        return parsed;
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // Local dev without python/RAW
        if (message.includes('ENOENT') || message.includes('not found')) {
            return {
                side,
                timestamp: new Date().toISOString(),
                error: 'Sensor dump helper unavailable (python/script missing). ' +
                    'On the Pod, ensure /home/dac/venv and free-sleep biometrics are installed. ' +
                    'RAW files live under /persistent when the Pod is capturing sensor data ' +
                    '(typically with cloud/internet blocked). Bed power and occupancy are not required.',
            };
        }
        logger.warn(`dump_sensor_snapshot failed: ${message}`);
        return {
            side,
            timestamp: new Date().toISOString(),
            error: message,
        };
    }
}
export async function readSideSensorSnapshot(side) {
    const now = Date.now();
    const existing = cache[side];
    if (existing?.inflight) {
        return existing.inflight;
    }
    if (existing && existing.expiresAt > now) {
        return existing.value;
    }
    const inflight = runPythonSnapshot(side).then((value) => {
        cache[side] = { expiresAt: Date.now() + CACHE_MS, value };
        return value;
    });
    cache[side] = {
        expiresAt: now + CACHE_MS,
        value: existing?.value ?? {
            side,
            timestamp: new Date().toISOString(),
            error: 'Loading…',
        },
        inflight,
    };
    return inflight;
}
//# sourceMappingURL=rawSensorReader.js.map