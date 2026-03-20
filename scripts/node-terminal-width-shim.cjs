const DEFAULT_COLUMNS = 240;
const DEFAULT_ROWS = 80;

function getPositiveInteger(value, fallback) {
  const parsed = Number.parseInt(value ?? '', 10);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
}

function tryDefineStreamDimension(stream, key, value) {
  try {
    Object.defineProperty(stream, key, {
      configurable: true,
      enumerable: false,
      value,
      writable: true,
    });

    return true;
  }
  catch {
    return false;
  }
}

function ensureStreamDimensions(stream, columns, rows) {
  if (!stream || stream.isTTY) {
    return;
  }

  if (typeof stream.columns !== 'number' || stream.columns <= 0) {
    tryDefineStreamDimension(stream, 'columns', columns);
  }

  if (typeof stream.rows !== 'number' || stream.rows <= 0) {
    tryDefineStreamDimension(stream, 'rows', rows);
  }
}

const columns = getPositiveInteger(process.env.COLUMNS, DEFAULT_COLUMNS);
const rows = getPositiveInteger(process.env.LINES, DEFAULT_ROWS);

ensureStreamDimensions(process.stdout, columns, rows);
ensureStreamDimensions(process.stderr, columns, rows);
