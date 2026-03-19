import {
  describe, expect, it, vi,
} from 'vitest';

vi.mock('@/uri', () => ({
  toUri: vi.fn(async (file: string, lineNo?: number) => ({
    toString: () => `file:///workspace/${file}#L${lineNo ?? 1}`,
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

  it('should escape markdown special characters in authorName', async () => {
    const markdown = await buildComment(
      {
        comments: [],
        target: 'src/foo.ts',
      },
      {
        authorName: 'A*[b](c)`d',
        comment: 'Body',
        file: 'src/foo.ts',
        fileUri: 'file:///workspace/src/foo.ts',
        line: 2,
      },
    );

    expect(markdown.value).toContain('[Line 2](file:///workspace/src/foo.ts#L2) | *A\\*\\[b\\]\\(c\\)\\`d*');
  });

  it('should escape dollar and angle brackets in authorName', async () => {
    const markdown = await buildComment(
      {
        comments: [],
        target: 'src/foo.ts',
      },
      {
        authorName: 'A<$cash>$',
        comment: 'Body',
        file: 'src/foo.ts',
        fileUri: 'file:///workspace/src/foo.ts',
        line: 3,
      },
    );

    expect(markdown.value).toContain('[Line 3](file:///workspace/src/foo.ts#L3) | *A\\<\\$cash\\>\\$*');
  });

  it('should normalize whitespace in authorName before rendering', async () => {
    const markdown = await buildComment(
      {
        comments: [],
        target: 'src/foo.ts',
      },
      {
        authorName: '  A\n\tB  ',
        comment: 'Body',
        file: 'src/foo.ts',
        fileUri: 'file:///workspace/src/foo.ts',
        line: 4,
      },
    );

    expect(markdown.value).toContain('[Line 4](file:///workspace/src/foo.ts#L4) | *A B*');
  });

  it('should render severity and strip details-like html wrappers from the comment body', async () => {
    const markdown = await buildComment(
      {
        comments: [],
        target: 'src/foo.ts',
      },
      {
        comment: '<details><summary>ignored</summary>Keep body</details>',
        file: 'src/foo.ts',
        fileUri: 'file:///workspace/src/foo.ts',
        line: 5,
        severity: 'major',
      },
    );

    expect(markdown.value).toContain('[Line 5](file:///workspace/src/foo.ts#L5) | **major**');
    expect(markdown.value).toContain('\nignoredKeep body');
    expect(markdown.value).not.toContain('<details>');
    expect(markdown.value).not.toContain('<summary>');
  });

  it('should fall back to workspace-relative uri generation when fileUri is missing', async () => {
    const markdown = await buildComment(
      {
        comments: [],
        target: 'src/bar.ts',
      },
      {
        comment: 'Uses generated uri',
        file: 'src/bar.ts',
        line: 9,
      },
    );

    expect(markdown.value).toContain('[Line 9](file:///workspace/src/bar.ts#L9)');
  });
});
