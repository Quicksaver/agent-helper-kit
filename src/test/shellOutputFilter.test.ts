import {
  describe,
  expect,
  it,
} from 'vitest';

import {
  getFilteredOutput,
  normalizeShellOutput,
} from '@/shellOutputFilter';

describe('shell output normalization', () => {
  it('returns empty output for blank and whitespace-only input', () => {
    expect(normalizeShellOutput('\n\n   \n')).toBe('');
    expect(normalizeShellOutput('   ')).toBe('');
    expect(normalizeShellOutput('')).toBe('');
  });

  it('removes blank and whitespace-only lines while preserving real output order', () => {
    expect(normalizeShellOutput('first\n\n   \n\t\nsecond\n')).toBe('first\nsecond\n');
  });

  it('drops lines that become empty after shell control sequences are stripped', () => {
    expect(normalizeShellOutput('first\n\u001B[2K\r\nsecond\n')).toBe('first\nsecond\n');
  });

  it('preserves output without forcing a trailing newline', () => {
    expect(normalizeShellOutput('text')).toBe('text');
  });

  it('applies blank-line removal before last_lines filtering', () => {
    expect(getFilteredOutput({ last_lines: 1 }, 'first\n\nsecond\n')).toBe('second\n');
  });

  it('applies blank-line removal before regex filtering', () => {
    expect(getFilteredOutput({ regex: '^second$' }, 'first\n  \nsecond\n')).toBe('second\n');
  });
});
