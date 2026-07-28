import logger from '../logger.js';
import { exec } from 'child_process';
import fs from 'fs';
const { promises: fsPromises } = fs;

type ExecutePythonScriptArgs = {
  script: string;
  cwd?: string;
  args?: string[];
};

/**
 * Python's logging StreamHandler writes INFO/WARNING to stderr by default.
 * Do not treat all stderr as a failure — only non-zero exit / exec error is fatal.
 */
function logPythonStream(stream: 'stdout' | 'stderr', text: string) {
  const trimmed = text.trim();
  if (!trimmed) return;

  // Prefer line-by-line so long piezo dumps don't dominate a single log record
  for (const line of trimmed.split('\n')) {
    const row = line.trim();
    if (!row) continue;

    // Mirror Python level tokens when present
    if (/\|\s*ERROR\s*\|/i.test(row) || /\|\s*CRITICAL\s*\|/i.test(row)) {
      logger.error(`Python: ${row}`);
    } else if (/\|\s*WARNING\s*\|/i.test(row) || /FutureWarning|DeprecationWarning/.test(row)) {
      logger.warn(`Python: ${row}`);
    } else if (stream === 'stderr' && /Error|Exception|Traceback/i.test(row)) {
      logger.error(`Python: ${row}`);
    } else {
      logger.info(`Python: ${row}`);
    }
  }
}

export const executePythonScript = async ({ script, args = [] }: ExecutePythonScriptArgs) => {
  const pythonExecutable = '/home/dac/venv/bin/python';

  try {
    await fsPromises.access(pythonExecutable, fs.constants.X_OK);
  } catch {
    logger.debug(`Not executing python script, ${pythonExecutable} does not exist!`);
    return;
  }

  const command = `${pythonExecutable} -B ${script} ${args.join(' ')}`;
  logger.info(`Executing: ${command}`);

  // maxBuffer: analyze_sleep can emit large logs while loading RAW files
  exec(command, { env: { ...process.env }, maxBuffer: 20 * 1024 * 1024 }, (error, stdout, stderr) => {
    if (stdout) logPythonStream('stdout', stdout);
    if (stderr) logPythonStream('stderr', stderr);

    if (error) {
      logger.error(`Python process failed: ${error.message}`);
    }
  });
};
