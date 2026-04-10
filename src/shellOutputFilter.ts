export interface ShellOutputFilterInput {
  last_lines?: number;
  regex?: string;
  regex_flags?: string;
}

/**
 * Strip shell control sequences from output, optionally preserving ANSI SGR
 * color/style escapes while removing other non-display sequences such as OSC
 * payloads and cursor-control codes.
 */
function stripShellSequences(output: string, preserveSgr: boolean): string {
  let sanitized = '';

  for (let index = 0; index < output.length; index += 1) {
    const codePoint = output.charCodeAt(index);

    if (codePoint !== 0x1B && codePoint !== 0x9B) {
      sanitized += output[index];
      continue;
    }

    if (codePoint === 0x1B && output[index + 1] === ']') {
      index += 2;

      while (index < output.length) {
        const oscCodePoint = output.charCodeAt(index);

        if (oscCodePoint === 0x07) {
          break;
        }

        if (oscCodePoint === 0x1B && output[index + 1] === '\\') {
          index += 1;
          break;
        }

        index += 1;
      }

      continue;
    }

    const sequenceStart = index;
    let sequenceIndex = index + 1;

    if (codePoint === 0x1B && output[sequenceIndex] === '[') {
      sequenceIndex += 1;
    }

    while (sequenceIndex < output.length) {
      const sequenceCodePoint = output.charCodeAt(sequenceIndex);

      if (sequenceCodePoint >= 0x40 && sequenceCodePoint <= 0x7E) {
        break;
      }

      sequenceIndex += 1;
    }

    const finalByte = output[sequenceIndex];

    if (preserveSgr && finalByte === 'm') {
      sanitized += output.slice(sequenceStart, sequenceIndex + 1);
    }

    index = sequenceIndex;
  }

  return sanitized
    // Normalize standalone carriage returns (used by some shells to redraw a line)
    // into newlines, while preserving CRLF pairs by excluding '\r' followed by '\n'.
    .replace(/\r(?!\n)/g, '\n');
}

export function stripShellControlSequences(output: string): string {
  return stripShellSequences(output, false);
}

function stripNonDisplayShellSequences(output: string): string {
  return stripShellSequences(output, true);
}

/**
 * Normalize shell output for downstream consumers by removing non-display
 * control sequences, dropping visually empty lines, and preserving a trailing
 * newline only when the original display output ended with one.
 */
export function normalizeShellOutput(output: string): string {
  const displayOutput = stripNonDisplayShellSequences(output);
  const normalizedLines = displayOutput
    .split('\n')
    .filter(line => stripShellControlSequences(line).trim().length > 0);

  if (normalizedLines.length === 0) {
    return '';
  }

  return displayOutput.endsWith('\n')
    ? `${normalizedLines.join('\n')}\n`
    : normalizedLines.join('\n');
}

/**
 * Apply the LM tool output selectors after normalization. Regex matching runs
 * against control-sequence-stripped display text so ANSI styling does not
 * affect line selection.
 */
export function getFilteredOutput(input: ShellOutputFilterInput, output: string): string {
  const hasLastLines = typeof input.last_lines === 'number';
  const hasRegex = typeof input.regex === 'string';
  const hasRegexFlags = typeof input.regex_flags === 'string';
  const normalizedOutput = normalizeShellOutput(output);

  if (hasLastLines && hasRegex) {
    throw new Error('last_lines and regex are mutually exclusive');
  }

  if (hasRegexFlags && !hasRegex) {
    throw new Error('regex_flags requires regex');
  }

  if (!hasLastLines && !hasRegex) {
    return normalizedOutput;
  }

  const lines = normalizedOutput.endsWith('\n')
    ? normalizedOutput.slice(0, -1).split('\n')
    : normalizedOutput.split('\n');

  if (hasLastLines) {
    const count = Math.max(Math.floor(input.last_lines ?? 0), 0);

    if (count === 0) {
      return '';
    }

    return `${lines.slice(-count).join('\n')}\n`;
  }

  const regexPattern = input.regex ?? '';
  const regexFlags = input.regex_flags ?? '';

  if (regexPattern.length > 2048) {
    throw new Error('regex exceeds maximum supported length (2048 characters)');
  }

  if (regexFlags.length > 16) {
    throw new Error('regex_flags exceeds maximum supported length (16 characters)');
  }

  if (/[^dgimsuvy]/u.test(regexFlags)) {
    throw new Error('regex_flags contains unsupported flags');
  }

  if (new Set(regexFlags).size !== regexFlags.length) {
    throw new Error('regex_flags contains duplicate flags');
  }

  if (regexFlags.includes('g') || regexFlags.includes('y')) {
    throw new Error('regex_flags cannot include g or y');
  }

  let expression: RegExp;

  try {
    expression = new RegExp(regexPattern, regexFlags);
  }
  catch {
    throw new Error('Invalid regex pattern or flags');
  }

  const matched = lines
    .filter(line => expression.test(stripShellControlSequences(line)))
    .join('\n');

  if (!matched) {
    return '';
  }

  return `${matched}\n`;
}
