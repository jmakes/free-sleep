/**
 * Multi-pose sensor calibration bridge.
 * Runs biometrics/sleep_detection/calibrate_pose.py and returns its JSON.
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
function resolvePoseScript() {
    const candidates = [
        path.resolve(__dirname, '../../../biometrics/sleep_detection/calibrate_pose.py'),
        path.resolve(__dirname, '../../../../biometrics/sleep_detection/calibrate_pose.py'),
        '/home/dac/free-sleep/biometrics/sleep_detection/calibrate_pose.py',
    ];
    for (const candidate of candidates) {
        if (fs.existsSync(candidate))
            return candidate;
    }
    return candidates[candidates.length - 1];
}
function resolveBiometricsCwd(script) {
    // Script imports from biometrics root (get_logger, load_raw_files, …)
    const sleepDetectionDir = path.dirname(script);
    const biometricsDir = path.dirname(sleepDetectionDir);
    if (fs.existsSync(path.join(biometricsDir, 'get_logger.py'))) {
        return biometricsDir;
    }
    return '/home/dac/free-sleep/biometrics';
}
export async function runPoseCalibration(args) {
    const script = resolvePoseScript();
    const python = '/home/dac/venv/bin/python';
    const cwd = resolveBiometricsCwd(script);
    if (!fs.existsSync(script)) {
        return {
            ok: false,
            action: args.action,
            error: `calibrate_pose.py not found (looked for ${script})`,
        };
    }
    const argv = [
        '-B',
        script,
        `--side=${args.side}`,
        `--action=${args.action}`,
    ];
    if (args.action === 'capture') {
        if (!args.pose) {
            return { ok: false, action: 'capture', error: 'pose is required for capture' };
        }
        argv.push(`--pose=${args.pose}`);
        argv.push(`--seconds=${args.seconds ?? 15}`);
        argv.push(`--settle=${args.settle ?? 1}`);
    }
    // Capture: settle + hold-window sleep + RAW tail parse (can exceed 20s)
    const timeoutMs = args.action === 'capture' ? 90_000 : 20_000;
    try {
        const { stdout, stderr } = await execFileAsync(python, argv, {
            timeout: timeoutMs,
            maxBuffer: 4 * 1024 * 1024,
            cwd,
            env: { ...process.env },
        });
        if (stderr?.trim()) {
            logger.debug(`calibrate_pose stderr: ${stderr.trim().slice(0, 400)}`);
        }
        return parsePoseJson(stdout, args.action);
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn(`calibrate_pose failed: ${message}`);
        // execFile puts stdout on the error object sometimes
        const anyErr = error;
        if (anyErr.stdout) {
            try {
                return parsePoseJson(String(anyErr.stdout), args.action);
            }
            catch {
                // fall through
            }
        }
        return {
            ok: false,
            action: args.action,
            error: message,
        };
    }
}
/**
 * Python may print banner lines before the JSON object (e.g. Sentry init).
 * Take the first top-level `{...}` rather than lastIndexOf('{') which breaks
 * on nested objects.
 */
function parsePoseJson(stdout, action) {
    const trimmed = stdout.trim();
    const jsonStart = trimmed.indexOf('{');
    if (jsonStart < 0) {
        return {
            ok: false,
            action,
            error: `No JSON in calibrate_pose output: ${trimmed.slice(0, 200)}`,
        };
    }
    // Walk braces to find the matching end of the first object
    let depth = 0;
    let inString = false;
    let escape = false;
    let jsonEnd = -1;
    for (let i = jsonStart; i < trimmed.length; i++) {
        const ch = trimmed[i];
        if (inString) {
            if (escape) {
                escape = false;
            }
            else if (ch === '\\') {
                escape = true;
            }
            else if (ch === '"') {
                inString = false;
            }
            continue;
        }
        if (ch === '"') {
            inString = true;
            continue;
        }
        if (ch === '{')
            depth += 1;
        else if (ch === '}') {
            depth -= 1;
            if (depth === 0) {
                jsonEnd = i;
                break;
            }
        }
    }
    if (jsonEnd < 0) {
        return {
            ok: false,
            action,
            error: `Unterminated JSON in calibrate_pose output: ${trimmed.slice(jsonStart, jsonStart + 200)}`,
        };
    }
    return JSON.parse(trimmed.slice(jsonStart, jsonEnd + 1));
}
//# sourceMappingURL=poseCalibration.js.map