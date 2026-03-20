const DEFAULT_COLUMNS = 240;
const DEFAULT_ROWS = 80;

function getPositiveInteger(value, fallback) {
  const parsed = Number.parseInt(value ?? '', 10);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
}

function ensureStreamDimensions(stream, columns, rows) {
  if (!stream || stream.isTTY) {
    return;
  }

  if (typeof stream.columns !== 'number' || stream.columns <= 0) {
    Object.defineProperty(stream, 'columns', {
      configurable: true,
      enumerable: false,
      value: columns,
      writable: true,
    });
  }

  if (typeof stream.rows !== 'number' || stream.rows <= 0) {
    Object.defineProperty(stream, 'rows', {
      configurable: true,
      enumerable: false,
      value: rows,
      writable: true,
    });
  }
}

const columns = getPositiveInteger(process.env.COLUMNS, DEFAULT_COLUMNS);
const rows = getPositiveInteger(process.env.LINES, DEFAULT_ROWS);

ensureStreamDimensions(process.stdout, columns, rows);
ensureStreamDimensions(process.stderr, columns, rows);
