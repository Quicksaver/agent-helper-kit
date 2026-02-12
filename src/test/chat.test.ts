import {
  describe, expect, it, vi,
} from 'vitest';

vi.mock('@/uri', () => ({
  toUri: vi.fn(async (_file: string, lineNo?: number) => ({
    toString: () => `file:///workspace/mock.ts#L${lineNo ?? 1}`,
  })),
}));

const vscode = vi.hoisted(() => {
  class MarkdownString {
    public isTrusted: unknown;

    public value = '';

    public appendMarkdown(text: string): void {
      this.value += text;
    }
  }

  return {
    MarkdownString,
    Uri: {
      parse: (value: string) => ({
        toString: () => value,
        with: ({ fragment }: { fragment: string }) => ({
          toString: () => `${value}#${fragment}`,
        }),
      }),
    },
  };
});

vi.mock('vscode', () => vscode);

// eslint-disable-next-line import/first -- must follow vi.mock
import { buildComment } from '@/chat';

describe('buildComment', () => {
  it('should render line number without author when authorName does not exist', async () => {
    const markdown = await buildComment(
      {
        comments: [],
        target: 'src/foo.ts',
      },
      {
        comment: 'No author',
        file: 'src/foo.ts',
        fileUri: 'file:///workspace/src/foo.ts',
        line: 12,
      },
    );

    expect(markdown.value).toContain('[Line 12](file:///workspace/src/foo.ts#L12)');
    expect(markdown.value).not.toContain(' | *');
  });

  it('should render authorName in italics after line number when author exists', async () => {
    const markdown = await buildComment(
      {
        comments: [],
        target: 'src/foo.ts',
      },
      {
        authorName: 'Abc',
        comment: 'With author',
        file: 'src/foo.ts',
        fileUri: 'file:///workspace/src/foo.ts',
        line: 34,
      },
    );

    expect(markdown.value).toContain('[Line 34](file:///workspace/src/foo.ts#L34) | *Abc*');
  });
});
