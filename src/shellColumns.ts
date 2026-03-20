export const DEFAULT_SHELL_COLUMNS = 240;
export const MAX_SHELL_COLUMNS = 1000;

export function normalizeShellColumns(columns?: number): number | undefined {
  if (typeof columns !== 'number' || !Number.isFinite(columns) || columns <= 0) {
    return undefined;
  }

  return Math.min(MAX_SHELL_COLUMNS, Math.floor(columns));
}
