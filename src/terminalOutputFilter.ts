export interface TerminalOutputFilterInput {
  last_lines?: number;
  regex?: string;
}

export function getFilteredOutput(input: TerminalOutputFilterInput, output: string): string {
  const hasLastLines = typeof input.last_lines === 'number';
  const hasRegex = typeof input.regex === 'string';

  if (hasLastLines && hasRegex) {
    throw new Error('last_lines and regex are mutually exclusive');
  }

  if (!hasLastLines && !hasRegex) {
    return output;
  }

  const lines = output.endsWith('\n')
    ? output.slice(0, -1).split('\n')
    : output.split('\n');

  if (hasLastLines) {
    const count = Math.max(Math.floor(input.last_lines ?? 0), 0);

    if (count === 0) {
      return '';
    }

    return `${lines.slice(-count).join('\n')}\n`;
  }

  const expression = new RegExp(input.regex ?? '');
  return lines.filter(line => expression.test(line)).join('\n');
}
