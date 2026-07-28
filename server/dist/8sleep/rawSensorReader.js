/**
 * Read recent capSense / piezo-dual samples from the Pod's latest .RAW file.
 * Used by the Sensors live view — only when the UI is actively polling.
 */
import fs from 'fs';
import path from 'path';
import cbor from 'cbor';
import logger from '../logger.js';
const RAW_DIRS = [
    '/persistent',
    process.env.RAW_DATA_FOLDER,
    // Local dev mirrors
    path.join(process.cwd(), 'free-sleep-data'),
    path.join(process.cwd(), '..', 'server', 'free-sleep-data'),
].filter(Boolean);
/** How much of the file tail to scan (enough for several seconds of piezo+cap) */
const TAIL_BYTES = 512 * 1024;
function listRawFiles(dir) {
    try {
        if (!fs.existsSync(dir))
            return [];
        return fs
            .readdirSync(dir)
            .filter((name) => name.endsWith('.RAW') && name !== 'SEQNO.RAW')
            .map((name) => path.join(dir, name));
    }
    catch {
        return [];
    }
}
function findLatestRawFile() {
    const candidates = [];
    for (const dir of RAW_DIRS) {
        for (const file of listRawFiles(dir)) {
            try {
                const stat = fs.statSync(file);
                candidates.push({ file, mtime: stat.mtimeMs });
            }
            catch {
                // skip
            }
        }
    }
    candidates.sort((a, b) => b.mtime - a.mtime);
    return candidates[0]?.file;
}
function formatTs(ts) {
    if (typeof ts === 'number') {
        return new Date(ts * 1000).toISOString();
    }
    if (typeof ts === 'string')
        return ts;
    return new Date().toISOString();
}
function piezoStatsFromBuffer(buf, ts, channel) {
    if (!buf || buf.length < 4)
        return undefined;
    const count = Math.floor(buf.length / 4);
    if (count <= 0)
        return undefined;
    // Ensure alignment for Int32Array
    const aligned = Buffer.from(buf);
    const samples = new Int32Array(aligned.buffer, aligned.byteOffset, count);
    let sum = 0;
    let min = samples[0];
    let max = samples[0];
    for (let i = 0; i < samples.length; i++) {
        const value = samples[i];
        sum += value;
        if (value < min)
            min = value;
        if (value > max)
            max = value;
    }
    const avg = sum / samples.length;
    return {
        ts,
        channel,
        avg: Math.round(avg),
        min,
        max,
        range: max - min,
        sampleCount: samples.length,
    };
}
function extractBytes(value) {
    if (Buffer.isBuffer(value))
        return value;
    if (value instanceof Uint8Array)
        return Buffer.from(value);
    if (value && typeof value === 'object' && 'data' in value) {
        const data = value.data;
        if (Buffer.isBuffer(data))
            return data;
        if (data instanceof Uint8Array)
            return Buffer.from(data);
    }
    return undefined;
}
function parseCapSide(sideData, ts) {
    if (!sideData || typeof sideData !== 'object')
        return undefined;
    const record = sideData;
    const out = Number(record.out);
    const cen = Number(record.cen);
    const inn = Number(record.in);
    if (![out, cen, inn].every((n) => Number.isFinite(n)))
        return undefined;
    return {
        ts,
        out,
        cen,
        in: inn,
        status: typeof record.status === 'string' ? record.status : undefined,
    };
}
/**
 * Decode concatenated CBOR objects from a buffer, skipping a broken prefix
 * (we often start mid-object when reading a file tail).
 */
function decodeCborObjects(buffer) {
    const maxScan = Math.min(buffer.length, 4096);
    for (let offset = 0; offset < maxScan; offset++) {
        try {
            const slice = buffer.subarray(offset);
            const decoded = cbor.decodeAllSync(slice);
            if (Array.isArray(decoded) && decoded.length > 0) {
                return decoded;
            }
        }
        catch {
            // try next offset
        }
    }
    return [];
}
function unwrapRow(obj) {
    if (!obj || typeof obj !== 'object')
        return undefined;
    const row = obj;
    // Outer wrapper: { data: <bytes|object> }
    if (row.data !== undefined) {
        try {
            if (Buffer.isBuffer(row.data) || row.data instanceof Uint8Array) {
                const inner = cbor.decode(Buffer.from(row.data));
                if (inner && typeof inner === 'object')
                    return inner;
            }
            if (typeof row.data === 'object')
                return row.data;
        }
        catch {
            // fall through
        }
    }
    if (typeof row.type === 'string')
        return row;
    return undefined;
}
export function readSideSensorSnapshot(side) {
    const timestamp = new Date().toISOString();
    const sourceFile = findLatestRawFile();
    if (!sourceFile) {
        return {
            side,
            timestamp,
            error: 'No .RAW files found under /persistent (or local free-sleep-data). ' +
                'RAW capture requires the Pod offline/firewall blocking cloud, and biometrics enabled.',
        };
    }
    try {
        const stat = fs.statSync(sourceFile);
        const size = stat.size;
        const start = Math.max(0, size - TAIL_BYTES);
        const length = size - start;
        const fd = fs.openSync(sourceFile, 'r');
        const buffer = Buffer.alloc(length);
        fs.readSync(fd, buffer, 0, length, start);
        fs.closeSync(fd);
        const objects = decodeCborObjects(buffer);
        let latestCap;
        let latestOtherCap;
        let latestPiezo1;
        let latestPiezo2;
        for (const obj of objects) {
            const data = unwrapRow(obj);
            if (!data || typeof data.type !== 'string')
                continue;
            const ts = formatTs(data.ts);
            if (data.type === 'capSense') {
                const mine = parseCapSide(data[side], ts);
                const otherSide = side === 'left' ? 'right' : 'left';
                const other = parseCapSide(data[otherSide], ts);
                if (mine)
                    latestCap = mine;
                if (other)
                    latestOtherCap = other;
            }
            if (data.type === 'piezo-dual') {
                const key1 = `${side}1`;
                const key2 = `${side}2`;
                const buf1 = extractBytes(data[key1]);
                const buf2 = extractBytes(data[key2]);
                if (buf1) {
                    const stats = piezoStatsFromBuffer(buf1, ts, '1');
                    if (stats)
                        latestPiezo1 = stats;
                }
                if (buf2) {
                    const stats = piezoStatsFromBuffer(buf2, ts, '2');
                    if (stats)
                        latestPiezo2 = stats;
                }
            }
        }
        if (!latestCap && !latestPiezo1 && !latestPiezo2) {
            return {
                side,
                timestamp,
                sourceFile: path.basename(sourceFile),
                fileMtime: stat.mtime.toISOString(),
                error: 'Parsed the latest RAW tail but found no capSense/piezo-dual frames. ' +
                    'Is the biometrics stream writing data?',
            };
        }
        return {
            side,
            timestamp,
            sourceFile: path.basename(sourceFile),
            fileMtime: stat.mtime.toISOString(),
            cap: latestCap,
            piezo1: latestPiezo1,
            piezo2: latestPiezo2,
            otherCap: latestOtherCap,
        };
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn(`rawSensorReader failed: ${message}`);
        return {
            side,
            timestamp,
            sourceFile: path.basename(sourceFile),
            error: message,
        };
    }
}
//# sourceMappingURL=rawSensorReader.js.map