import {
  describe,
  expect,
  it,
} from 'vitest';

import {
  getFilteredOutput,
  normalizeShellOutput,
  stripShellControlSequences,
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

  it('preserves ANSI color sequences on non-empty lines', () => {
    expect(normalizeShellOutput('\u001B[31mfirst\u001B[0m\nsecond\n')).toBe('\u001B[31mfirst\u001B[0m\nsecond\n');
  });

  it('drops lines that only contain ANSI color sequences and whitespace', () => {
    expect(normalizeShellOutput('\u001B[31m   \u001B[0m\nvalue\n')).toBe('value\n');
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

  it('matches regex against visible text while preserving ANSI color sequences', () => {
    expect(getFilteredOutput({ regex: '^second$' }, '\u001B[31msecond\u001B[0m\nthird\n')).toBe('\u001B[31msecond\u001B[0m\n');
  });

  it('strips OSC and non-SGR control sequences while preserving visible text', () => {
    expect(stripShellControlSequences('prefix\u001B]0;title\u0007mid\u001B[2Ksuffix')).toBe('prefixmidsuffix');
  });

  it('normalizes standalone carriage returns to newlines', () => {
    expect(normalizeShellOutput('first\rsecond\rthird')).toBe('first\nsecond\nthird');
  });

  it('returns empty output when last_lines is zero', () => {
    expect(getFilteredOutput({ last_lines: 0 }, 'first\nsecond\n')).toBe('');
  });

  it('returns empty output when regex does not match any visible line', () => {
    expect(getFilteredOutput({ regex: '^missing$' }, 'first\nsecond\n')).toBe('');
  });

  it('rejects conflicting last_lines and regex filters', () => {
    expect(() => getFilteredOutput({
      last_lines: 1,
      regex: 'first',
    }, 'first\n')).toThrow('last_lines and regex are mutually exclusive');
  });

  it('rejects regex_flags without a regex pattern', () => {
    expect(() => getFilteredOutput({ regex_flags: 'i' }, 'first\n')).toThrow('regex_flags requires regex');
  });

  it('rejects regex patterns above the supported length limit', () => {
    expect(() => getFilteredOutput({ regex: 'a'.repeat(2049) }, 'first\n')).toThrow(
      'regex exceeds maximum supported length (2048 characters)',
    );
  });

  it('rejects regex flags above the supported length limit', () => {
    expect(() => getFilteredOutput({
      regex: 'first',
      regex_flags: 'i'.repeat(17),
    }, 'first\n')).toThrow('regex_flags exceeds maximum supported length (16 characters)');
  });

  it('rejects unsupported, duplicate, and stateful regex flags', () => {
    expect(() => getFilteredOutput({ regex: 'first', regex_flags: 'z' }, 'first\n')).toThrow(
      'regex_flags contains unsupported flags',
    );
    expect(() => getFilteredOutput({ regex: 'first', regex_flags: 'ii' }, 'first\n')).toThrow(
      'regex_flags contains duplicate flags',
    );
    expect(() => getFilteredOutput({ regex: 'first', regex_flags: 'g' }, 'first\n')).toThrow(
      'regex_flags cannot include g or y',
    );
    expect(() => getFilteredOutput({ regex: 'first', regex_flags: 'y' }, 'first\n')).toThrow(
      'regex_flags cannot include g or y',
    );
  });

  it('rejects invalid regex syntax', () => {
    expect(() => getFilteredOutput({ regex: '[' }, 'first\n')).toThrow('Invalid regex pattern or flags');
  });
});
