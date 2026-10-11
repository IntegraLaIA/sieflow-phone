// Minimal structured logger: one JSON object per line, no dependencies.
// Never pass tokens, passwords or full SDPs as fields.

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
let threshold = LEVELS.info;

export function setLogLevel(level) {
  threshold = LEVELS[level] ?? LEVELS.info;
}

function emit(level, msg, fields) {
  if (LEVELS[level] < threshold) return;
  const line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...fields });
  const stream = level === 'warn' || level === 'error' ? process.stderr : process.stdout;
  stream.write(line + '\n');
}

export const log = {
  debug: (msg, fields) => emit('debug', msg, fields),
  info: (msg, fields) => emit('info', msg, fields),
  warn: (msg, fields) => emit('warn', msg, fields),
  error: (msg, fields) => emit('error', msg, fields),
};
