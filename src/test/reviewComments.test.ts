import {
  beforeEach, describe, expect, it, vi,
} from 'vitest';

const vscode = vi.hoisted(() => {
  const _cancelHandlers: (() => void)[] = [];

  return {
    _cancelHandlers,
    commands: {
      executeCommand: vi.fn(),
    },
    ProgressLocation: {
      Notification: 15,
    },
    window: {
      withProgress: vi.fn().mockImplementation(
        (
          _options: unknown,
          task: (
            progress: { report: ReturnType<typeof vi.fn> },
            token: {
              isCancellationRequested: boolean;
              onCancellationRequested: ReturnType<typeof vi.fn>;
            },
          ) => Promise<void>,
        ) => {
          const progress = { report: vi.fn() };
          const token = {
            isCancellationRequested: false,
            onCancellationRequested: vi.fn((listener: () => void) => {
              _cancelHandlers.push(listener);
              return { dispose: vi.fn() };
            }),
          };
          void task(progress, token);
          return Promise.resolve();
        },
      ),
    },
    workspace: {
      asRelativePath: vi.fn((uri: string | { fsPath: string }) => {
        const p = typeof uri === 'string' ? uri : uri.fsPath;
        return p.replace(/^\/workspace\//, '');
      }),
    },
  };
});

vi.mock('vscode', () => vscode);

const mockUri = (fsPath: string) => ({
  fsPath,
  toString: () => `file://${fsPath}`,
});

// eslint-disable-next-line import/first -- must follow vi.mock
import {
  clearQueuedPendingComments,
  dismissQueueToast,
  formatQueueParts,
  getQueuedPendingComments,
  reviewCommentToChat,
} from '@/reviewComments';

describe('reviewCommentToChat', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearQueuedPendingComments();
    vscode._cancelHandlers.splice(0);
  });

  it('should extract comment body and open chat when given a CommentThread', () => {
    const thread = {
      comments: [
        { body: 'First comment' },
        { body: 'Second comment' },
      ],
      label: undefined,
      range: { start: { line: 9 } },
      uri: mockUri('/workspace/src/foo.ts'),
    };

    reviewCommentToChat(thread);

    const queued = getQueuedPendingComments();
    expect(queued.length).toBeGreaterThanOrEqual(1);
    const pending = queued[queued.length - 1];
    expect(pending).toBeDefined();
    expect(pending.comment).toEqual({
      comment: 'First comment\nSecond comment',
      file: 'src/foo.ts',
      fileUri: 'file:///workspace/src/foo.ts',
      line: 10,
    });
    expect(pending.file).toEqual({
      comments: [ pending.comment ],
      target: 'src/foo.ts',
    });
  });

  it('should handle MarkdownString comment bodies', () => {
    const thread = {
      comments: [
        { body: { value: 'Markdown **body**' } },
      ],
      label: undefined,
      range: { start: { line: 4 } },
      uri: mockUri('/workspace/src/bar.ts'),
    };

    reviewCommentToChat(thread);

    const queued = getQueuedPendingComments();
    expect(queued.length).toBeGreaterThanOrEqual(1);
    const pending = queued[queued.length - 1];
    expect(pending).toBeDefined();
    expect(pending.comment).toEqual({
      comment: 'Markdown **body**',
      file: 'src/bar.ts',
      fileUri: 'file:///workspace/src/bar.ts',
      line: 5,
    });
  });

  it('should include authorName when a thread comment has author.name', () => {
    const thread = {
      comments: [
        {
          author: { name: 'CodeRabbit' },
          body: 'Author body',
        },
      ],
      label: undefined,
      range: { start: { line: 7 } },
      uri: mockUri('/workspace/src/author.ts'),
    };

    reviewCommentToChat(thread);

    const queued = getQueuedPendingComments();
    expect(queued.length).toBeGreaterThanOrEqual(1);
    const pending = queued[queued.length - 1];
    expect(pending).toBeDefined();
    expect(pending.comment).toEqual({
      authorName: 'CodeRabbit',
      comment: 'Author body',
      file: 'src/author.ts',
      fileUri: 'file:///workspace/src/author.ts',
      line: 8,
    });
  });

  it('should use first available authorName when earlier comments have no author', () => {
    const thread = {
      comments: [
        { body: 'No author on first' },
        {
          author: { name: 'Later Author' },
          body: 'Second has author',
        },
      ],
      label: undefined,
      range: { start: { line: 11 } },
      uri: mockUri('/workspace/src/later-author.ts'),
    };

    reviewCommentToChat(thread);

    const queued = getQueuedPendingComments();
    expect(queued.length).toBeGreaterThanOrEqual(1);
    const pending = queued[queued.length - 1];
    expect(pending).toBeDefined();
    expect(pending.comment.authorName).toBe('Later Author');
  });

  it('should treat whitespace-only author names as absent', () => {
    const thread = {
      comments: [
        {
          author: { name: '   ' },
          body: 'Whitespace author',
        },
      ],
      label: undefined,
      range: { start: { line: 3 } },
      uri: mockUri('/workspace/src/whitespace-author.ts'),
    };

    reviewCommentToChat(thread);

    const queued = getQueuedPendingComments();
    expect(queued.length).toBeGreaterThanOrEqual(1);
    const pending = queued[queued.length - 1];
    expect(pending).toBeDefined();
    expect(pending.comment.authorName).toBeUndefined();
  });

  it('should parse severity from thread label with pipe separator', () => {
    const thread = {
      comments: [ { body: 'A comment' } ],
      label: 'Review | critical',
      range: { start: { line: 0 } },
      uri: mockUri('/workspace/src/baz.ts'),
    };

    reviewCommentToChat(thread);

    const queued = getQueuedPendingComments();
    expect(queued.length).toBeGreaterThanOrEqual(1);
    const pending = queued[queued.length - 1];
    expect(pending).toBeDefined();
    expect(pending.comment).toEqual({
      comment: 'A comment',
      file: 'src/baz.ts',
      fileUri: 'file:///workspace/src/baz.ts',
      line: 1,
      severity: 'critical',
    });
  });

  it('should default line to 1 when thread has no range', () => {
    const thread = {
      comments: [ { body: 'No range' } ],
      label: undefined,
      range: undefined,
      uri: mockUri('/workspace/src/no-range.ts'),
    };

    reviewCommentToChat(thread);

    const queued = getQueuedPendingComments();
    expect(queued.length).toBeGreaterThanOrEqual(1);
    const pending = queued[queued.length - 1];
    expect(pending).toBeDefined();
    expect(pending.comment).toEqual({
      comment: 'No range',
      file: 'src/no-range.ts',
      fileUri: 'file:///workspace/src/no-range.ts',
      line: 1,
    });
  });

  it('should handle a single Comment fallback (non-thread arg)', () => {
    const comment = {
      body: 'A standalone comment',
    };

    reviewCommentToChat(comment);

    const queued = getQueuedPendingComments();
    expect(queued.length).toBeGreaterThanOrEqual(1);
    const pending = queued[queued.length - 1];
    expect(pending).toBeDefined();
    expect(pending.comment).toEqual({
      comment: 'A standalone comment',
      file: 'unknown',
      line: 1,
    });
  });

  it('should include authorName for standalone Comment fallback when available', () => {
    const comment = {
      author: { name: 'Copilot Code Review' },
      body: 'A standalone authored comment',
    };

    reviewCommentToChat(comment);

    const queued = getQueuedPendingComments();
    expect(queued.length).toBeGreaterThanOrEqual(1);
    const pending = queued[queued.length - 1];
    expect(pending).toBeDefined();
    expect(pending.comment).toEqual({
      authorName: 'Copilot Code Review',
      comment: 'A standalone authored comment',
      file: 'unknown',
      line: 1,
    });
  });

  it('should not include severity when thread label has no pipe', () => {
    const thread = {
      comments: [ { body: 'A comment' } ],
      label: 'Just a label without pipe',
      range: { start: { line: 5 } },
      uri: mockUri('/workspace/src/no-pipe.ts'),
    };

    reviewCommentToChat(thread);

    const queued = getQueuedPendingComments();
    expect(queued.length).toBeGreaterThanOrEqual(1);
    const pending = queued[queued.length - 1];
    expect(pending).toBeDefined();
    expect(pending.comment).toEqual({
      comment: 'A comment',
      file: 'src/no-pipe.ts',
      fileUri: 'file:///workspace/src/no-pipe.ts',
      line: 6,
    });
    expect(pending.comment.severity).toBeUndefined();
  });

  it('should not add duplicate comments and show already-queued toast', () => {
    const thread = {
      comments: [ { body: 'Duplicate me' } ],
      label: 'Lint | warning',
      range: { start: { line: 2 } },
      uri: mockUri('/workspace/src/dup.ts'),
    };

    reviewCommentToChat(thread);

    expect(vscode.window.withProgress).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Queued for chat: Lint' }),
      expect.any(Function),
    );

    const countAfterFirst = getQueuedPendingComments().length;

    // Call again with identical comment
    reviewCommentToChat(thread);

    // Toast still shown with same count since duplicate was not added
    expect(vscode.window.withProgress).toHaveBeenCalledTimes(2);
    expect(getQueuedPendingComments().length).toBe(countAfterFirst);
  });

  it('should show queued toast with thread label title portion', () => {
    const thread = {
      comments: [ { body: 'Toast test' } ],
      label: 'Security | high',
      range: { start: { line: 0 } },
      uri: mockUri('/workspace/src/toast.ts'),
    };

    reviewCommentToChat(thread);

    expect(vscode.window.withProgress).toHaveBeenCalledWith(
      expect.objectContaining({
        cancellable: true,
        location: vscode.ProgressLocation.Notification,
        title: 'Queued for chat: Security',
      }),
      expect.any(Function),
    );
  });

  it('should use "Review" as title when thread has no label', () => {
    const thread = {
      comments: [ { body: 'No label toast' } ],
      label: undefined,
      range: { start: { line: 0 } },
      uri: mockUri('/workspace/src/no-label.ts'),
    };

    reviewCommentToChat(thread);

    expect(vscode.window.withProgress).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Queued for chat: Review' }),
      expect.any(Function),
    );
  });

  it('should not add duplicate standalone comments', () => {
    const comment = { body: 'Standalone dup' };

    reviewCommentToChat(comment);

    const countAfterFirst = getQueuedPendingComments().length;

    reviewCommentToChat(comment);

    // Toast still shown with same count since duplicate was not added
    expect(vscode.window.withProgress).toHaveBeenCalledTimes(2);
    expect(getQueuedPendingComments().length).toBe(countAfterFirst);
  });

  it('should extract title from label with multiple pipes', () => {
    const thread = {
      comments: [ { body: 'Multi-pipe test' } ],
      label: 'Title | Sub | high',
      range: { start: { line: 0 } },
      uri: mockUri('/workspace/src/multi-pipe.ts'),
    };

    reviewCommentToChat(thread);

    expect(vscode.window.withProgress).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Queued for chat: Title | Sub' }),
      expect.any(Function),
    );
  });

  it('should fallback to "Review" when title before pipe is empty', () => {
    const thread = {
      comments: [ { body: 'Empty title test' } ],
      label: ' | high',
      range: { start: { line: 0 } },
      uri: mockUri('/workspace/src/empty-title.ts'),
    };

    reviewCommentToChat(thread);

    expect(vscode.window.withProgress).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Queued for chat: Review' }),
      expect.any(Function),
    );
  });

  it('should use full label as title when there is no pipe', () => {
    const thread = {
      comments: [ { body: 'No pipe title test' } ],
      label: 'Custom Title',
      range: { start: { line: 0 } },
      uri: mockUri('/workspace/src/no-pipe-title.ts'),
    };

    reviewCommentToChat(thread);

    expect(vscode.window.withProgress).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Queued for chat: Custom Title' }),
      expect.any(Function),
    );
  });

  it('should use title portion when label has trailing pipe with empty severity', () => {
    const thread = {
      comments: [ { body: 'Trailing pipe test' } ],
      label: 'Foo | ',
      range: { start: { line: 0 } },
      uri: mockUri('/workspace/src/trailing-pipe.ts'),
    };

    reviewCommentToChat(thread);

    expect(vscode.window.withProgress).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Queued for chat: Foo' }),
      expect.any(Function),
    );
  });

  it('should dismiss previous toast when showing a new one', () => {
    const thread1 = {
      comments: [ { body: 'First' } ],
      label: undefined,
      range: { start: { line: 0 } },
      uri: mockUri('/workspace/src/a.ts'),
    };
    const thread2 = {
      comments: [ { body: 'Second' } ],
      label: undefined,
      range: { start: { line: 1 } },
      uri: mockUri('/workspace/src/b.ts'),
    };

    reviewCommentToChat(thread1);
    reviewCommentToChat(thread2);

    // Two withProgress calls, second replaces the first
    expect(vscode.window.withProgress).toHaveBeenCalledTimes(2);
    expect(vscode.window.withProgress).toHaveBeenLastCalledWith(
      expect.objectContaining({ title: 'Queued for chat: Review (x2)' }),
      expect.any(Function),
    );
  });

  it('should allow external dismissal via dismissQueueToast', () => {
    const thread = {
      comments: [ { body: 'Dismissable' } ],
      label: undefined,
      range: { start: { line: 0 } },
      uri: mockUri('/workspace/src/dismiss.ts'),
    };

    reviewCommentToChat(thread);
    expect(vscode.window.withProgress).toHaveBeenCalledTimes(1);

    // External dismiss should not throw
    dismissQueueToast();

    // Queue remains intact — dismissQueueToast only dismisses the notification
    expect(getQueuedPendingComments().length).toBe(1);
  });

  it('should clear the queue when notification is cancelled', () => {
    const thread = {
      comments: [ { body: 'Cancel test' } ],
      label: undefined,
      range: { start: { line: 0 } },
      uri: mockUri('/workspace/src/cancel.ts'),
    };

    reviewCommentToChat(thread);
    expect(getQueuedPendingComments().length).toBe(1);

    // Simulate the user clicking Cancel on the withProgress notification
    const lastHandler = vscode._cancelHandlers[vscode._cancelHandlers.length - 1];
    lastHandler();

    expect(getQueuedPendingComments().length).toBe(0);
  });

  it('should aggregate multiple titles with counts in the toast message', () => {
    const securityThread = {
      comments: [ { body: 'Security issue 1' } ],
      label: 'Security | critical',
      range: { start: { line: 0 } },
      uri: mockUri('/workspace/src/a.ts'),
    };

    const lintThread1 = {
      comments: [ { body: 'Lint issue 1' } ],
      label: 'Lint | warning',
      range: { start: { line: 1 } },
      uri: mockUri('/workspace/src/b.ts'),
    };

    const lintThread2 = {
      comments: [ { body: 'Lint issue 2' } ],
      label: 'Lint | info',
      range: { start: { line: 5 } },
      uri: mockUri('/workspace/src/c.ts'),
    };

    reviewCommentToChat(securityThread);
    reviewCommentToChat(lintThread1);
    reviewCommentToChat(lintThread2);

    expect(getQueuedPendingComments().length).toBe(3);

    // The last toast should aggregate both titles
    expect(vscode.window.withProgress).toHaveBeenLastCalledWith(
      expect.objectContaining({
        title: 'Queued for chat: Security, Lint (x2)',
      }),
      expect.any(Function),
    );
  });

  it('should simplify "Comment x of y" titles when all comments are present', () => {
    for (let i = 1; i <= 4; i++) {
      const thread = {
        comments: [ { body: `Comment body ${i}` } ],
        label: `Comment ${i} of 4`,
        range: { start: { line: i } },
        uri: mockUri(`/workspace/src/file${i}.ts`),
      };

      reviewCommentToChat(thread);
    }

    expect(vscode.window.withProgress).toHaveBeenLastCalledWith(
      expect.objectContaining({
        title: 'Queued for chat: All 4 comments',
      }),
      expect.any(Function),
    );
  });

  it('should simplify "Comment x of y" titles when some comments are present', () => {
    for (const i of [ 1, 2, 4 ]) {
      const thread = {
        comments: [ { body: `Comment body ${i}` } ],
        label: `Comment ${i} of 4`,
        range: { start: { line: i } },
        uri: mockUri(`/workspace/src/file${i}.ts`),
      };

      reviewCommentToChat(thread);
    }

    expect(vscode.window.withProgress).toHaveBeenLastCalledWith(
      expect.objectContaining({
        title: 'Queued for chat: Comments 1, 2, and 4, of 4',
      }),
      expect.any(Function),
    );
  });

  it('should keep single "Comment x of y" title as-is', () => {
    const thread = {
      comments: [ { body: 'Only one' } ],
      label: 'Comment 2 of 4',
      range: { start: { line: 0 } },
      uri: mockUri('/workspace/src/single.ts'),
    };

    reviewCommentToChat(thread);

    expect(vscode.window.withProgress).toHaveBeenLastCalledWith(
      expect.objectContaining({
        title: 'Queued for chat: Comment 2 of 4',
      }),
      expect.any(Function),
    );
  });
});

describe('formatQueueParts', () => {
  it('should return regular titles with count suffix', () => {
    const map = new Map([ [ 'Lint', 3 ], [ 'Security', 1 ] ]);
    expect(formatQueueParts(map)).toEqual([ 'Lint (x3)', 'Security' ]);
  });

  it('should return single "Comment x of y" as-is', () => {
    const map = new Map([ [ 'Comment 2 of 4', 1 ] ]);
    expect(formatQueueParts(map)).toEqual([ 'Comment 2 of 4' ]);
  });

  it('should collapse all comments into "All y comments"', () => {
    const map = new Map([
      [ 'Comment 1 of 3', 1 ],
      [ 'Comment 2 of 3', 1 ],
      [ 'Comment 3 of 3', 1 ],
    ]);
    expect(formatQueueParts(map)).toEqual([ 'All 3 comments' ]);
  });

  it('should list partial comments as "Comments x, y, and z, of total"', () => {
    const map = new Map([
      [ 'Comment 1 of 4', 1 ],
      [ 'Comment 2 of 4', 1 ],
      [ 'Comment 4 of 4', 1 ],
    ]);
    expect(formatQueueParts(map)).toEqual([ 'Comments 1, 2, and 4, of 4' ]);
  });

  it('should handle two partial comments without Oxford comma', () => {
    const map = new Map([
      [ 'Comment 1 of 5', 1 ],
      [ 'Comment 3 of 5', 1 ],
    ]);
    expect(formatQueueParts(map)).toEqual([ 'Comments 1 and 3, of 5' ]);
  });

  it('should mix "Comment x of y" and regular titles', () => {
    const map = new Map([
      [ 'Comment 1 of 3', 1 ],
      [ 'Comment 3 of 3', 1 ],
      [ 'Lint', 2 ],
    ]);
    const result = formatQueueParts(map);
    expect(result).toContain('Lint (x2)');
    expect(result).toContain('Comments 1 and 3, of 3');
  });

  it('should handle duplicate "Comment x of y" with count > 1', () => {
    const map = new Map([ [ 'Comment 1 of 4', 2 ] ]);
    expect(formatQueueParts(map)).toEqual([ 'Comment 1 of 4 (x2)' ]);
  });

  it('should ignore dupe counts in partial groupings and list unique numbers only', () => {
    const map = new Map([
      [ 'Comment 1 of 4', 2 ],
      [ 'Comment 3 of 4', 1 ],
    ]);
    expect(formatQueueParts(map)).toEqual([ 'Comments 1 and 3, of 4' ]);
  });
});
