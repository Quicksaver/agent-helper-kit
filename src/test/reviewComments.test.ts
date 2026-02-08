import {
  beforeEach, describe, expect, it, vi,
} from 'vitest';

const vscode = vi.hoisted(() => ({
  commands: {
    executeCommand: vi.fn(),
  },
  window: {
    showInformationMessage: vi.fn().mockResolvedValue(undefined),
  },
  workspace: {
    asRelativePath: vi.fn((uri: string | { fsPath: string }) => {
      const p = typeof uri === 'string' ? uri : uri.fsPath;
      return p.replace(/^\/workspace\//, '');
    }),
  },
}));

vi.mock('vscode', () => vscode);

// eslint-disable-next-line import/first -- must follow vi.mock
import { clearQueuedPendingComments, getQueuedPendingComments, reviewCommentToChat } from '../reviewComments.js';

describe('reviewCommentToChat', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearQueuedPendingComments();
  });

  it('should extract comment body and open chat when given a CommentThread', () => {
    const thread = {
      comments: [
        { body: 'First comment' },
        { body: 'Second comment' },
      ],
      label: undefined,
      range: { start: { line: 9 } },
      uri: { fsPath: '/workspace/src/foo.ts' },
    };

    reviewCommentToChat(thread);

    const queued = getQueuedPendingComments();
    expect(queued.length).toBeGreaterThanOrEqual(1);
    const pending = queued[queued.length - 1];
    expect(pending).toBeDefined();
    expect(pending.comment).toEqual({
      comment: 'First comment\nSecond comment',
      file: 'src/foo.ts',
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
      uri: { fsPath: '/workspace/src/bar.ts' },
    };

    reviewCommentToChat(thread);

    const queued = getQueuedPendingComments();
    expect(queued.length).toBeGreaterThanOrEqual(1);
    const pending = queued[queued.length - 1];
    expect(pending).toBeDefined();
    expect(pending.comment).toEqual({
      comment: 'Markdown **body**',
      file: 'src/bar.ts',
      line: 5,
    });
  });

  it('should parse severity from thread label with pipe separator', () => {
    const thread = {
      comments: [ { body: 'A comment' } ],
      label: 'Review | critical',
      range: { start: { line: 0 } },
      uri: { fsPath: '/workspace/src/baz.ts' },
    };

    reviewCommentToChat(thread);

    const queued = getQueuedPendingComments();
    expect(queued.length).toBeGreaterThanOrEqual(1);
    const pending = queued[queued.length - 1];
    expect(pending).toBeDefined();
    expect(pending.comment).toEqual({
      comment: 'A comment',
      file: 'src/baz.ts',
      line: 1,
      severity: 'critical',
    });
  });

  it('should default line to 1 when thread has no range', () => {
    const thread = {
      comments: [ { body: 'No range' } ],
      label: undefined,
      range: undefined,
      uri: { fsPath: '/workspace/src/no-range.ts' },
    };

    reviewCommentToChat(thread);

    const queued = getQueuedPendingComments();
    expect(queued.length).toBeGreaterThanOrEqual(1);
    const pending = queued[queued.length - 1];
    expect(pending).toBeDefined();
    expect(pending.comment).toEqual({
      comment: 'No range',
      file: 'src/no-range.ts',
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

  it('should not include severity when thread label has no pipe', () => {
    const thread = {
      comments: [ { body: 'A comment' } ],
      label: 'Just a label without pipe',
      range: { start: { line: 5 } },
      uri: { fsPath: '/workspace/src/no-pipe.ts' },
    };

    reviewCommentToChat(thread);

    const queued = getQueuedPendingComments();
    expect(queued.length).toBeGreaterThanOrEqual(1);
    const pending = queued[queued.length - 1];
    expect(pending).toBeDefined();
    expect(pending.comment).toEqual({
      comment: 'A comment',
      file: 'src/no-pipe.ts',
      line: 6,
    });
    expect(pending.comment.severity).toBeUndefined();
  });

  it('should not add duplicate comments and show already-queued toast', () => {
    const thread = {
      comments: [ { body: 'Duplicate me' } ],
      label: 'Lint | warning',
      range: { start: { line: 2 } },
      uri: { fsPath: '/workspace/src/dup.ts' },
    };

    reviewCommentToChat(thread);

    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      'Queued for chat: Lint (1 comment)',
      'Bring to Chat',
      'Cancel',
    );

    const countAfterFirst = getQueuedPendingComments().length;

    // Call again with identical comment
    reviewCommentToChat(thread);

    // Toast still shown with same count since duplicate was not added
    expect(vscode.window.showInformationMessage).toHaveBeenCalledTimes(2);
    expect(getQueuedPendingComments().length).toBe(countAfterFirst);
  });

  it('should show queued toast with thread label title portion', () => {
    const thread = {
      comments: [ { body: 'Toast test' } ],
      label: 'Security | high',
      range: { start: { line: 0 } },
      uri: { fsPath: '/workspace/src/toast.ts' },
    };

    reviewCommentToChat(thread);

    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      'Queued for chat: Security (1 comment)',
      'Bring to Chat',
      'Cancel',
    );
  });

  it('should use "Review" as title when thread has no label', () => {
    const thread = {
      comments: [ { body: 'No label toast' } ],
      label: undefined,
      range: { start: { line: 0 } },
      uri: { fsPath: '/workspace/src/no-label.ts' },
    };

    reviewCommentToChat(thread);

    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      'Queued for chat: Review (1 comment)',
      'Bring to Chat',
      'Cancel',
    );
  });

  it('should not add duplicate standalone comments', () => {
    const comment = { body: 'Standalone dup' };

    reviewCommentToChat(comment);

    const countAfterFirst = getQueuedPendingComments().length;

    reviewCommentToChat(comment);

    // Toast still shown with same count since duplicate was not added
    expect(vscode.window.showInformationMessage).toHaveBeenCalledTimes(2);
    expect(getQueuedPendingComments().length).toBe(countAfterFirst);
  });

  it('should extract title from label with multiple pipes', () => {
    const thread = {
      comments: [ { body: 'Multi-pipe test' } ],
      label: 'Title | Sub | high',
      range: { start: { line: 0 } },
      uri: { fsPath: '/workspace/src/multi-pipe.ts' },
    };

    reviewCommentToChat(thread);

    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      'Queued for chat: Title | Sub (1 comment)',
      'Bring to Chat',
      'Cancel',
    );
  });

  it('should fallback to "Review" when title before pipe is empty', () => {
    const thread = {
      comments: [ { body: 'Empty title test' } ],
      label: ' | high',
      range: { start: { line: 0 } },
      uri: { fsPath: '/workspace/src/empty-title.ts' },
    };

    reviewCommentToChat(thread);

    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      'Queued for chat: Review (1 comment)',
      'Bring to Chat',
      'Cancel',
    );
  });

  it('should use full label as title when there is no pipe', () => {
    const thread = {
      comments: [ { body: 'No pipe title test' } ],
      label: 'Custom Title',
      range: { start: { line: 0 } },
      uri: { fsPath: '/workspace/src/no-pipe-title.ts' },
    };

    reviewCommentToChat(thread);

    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      'Queued for chat: Custom Title (1 comment)',
      'Bring to Chat',
      'Cancel',
    );
  });

  it('should use title portion when label has trailing pipe with empty severity', () => {
    const thread = {
      comments: [ { body: 'Trailing pipe test' } ],
      label: 'Foo | ',
      range: { start: { line: 0 } },
      uri: { fsPath: '/workspace/src/trailing-pipe.ts' },
    };

    reviewCommentToChat(thread);

    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      'Queued for chat: Foo (1 comment)',
      'Bring to Chat',
      'Cancel',
    );
  });

  it('should execute chat command when "Bring to Chat" is clicked', async () => {
    vscode.window.showInformationMessage.mockResolvedValueOnce('Bring to Chat');

    const thread = {
      comments: [ { body: 'Bring to chat test' } ],
      label: undefined,
      range: { start: { line: 0 } },
      uri: { fsPath: '/workspace/src/bring.ts' },
    };

    reviewCommentToChat(thread);

    await Promise.resolve();

    expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
      'workbench.action.chat.open',
      { query: '@bringCommentsToChat' },
    );
  });

  it('should clear the queue when "Cancel" is clicked', async () => {
    vscode.window.showInformationMessage.mockResolvedValueOnce('Cancel');

    const thread = {
      comments: [ { body: 'Cancel test' } ],
      label: undefined,
      range: { start: { line: 0 } },
      uri: { fsPath: '/workspace/src/cancel.ts' },
    };

    reviewCommentToChat(thread);

    await Promise.resolve();

    expect(getQueuedPendingComments().length).toBe(0);
  });

  it('should aggregate multiple titles with counts in the toast message', () => {
    const securityThread = {
      comments: [ { body: 'Security issue 1' } ],
      label: 'Security | critical',
      range: { start: { line: 0 } },
      uri: { fsPath: '/workspace/src/a.ts' },
    };

    const lintThread1 = {
      comments: [ { body: 'Lint issue 1' } ],
      label: 'Lint | warning',
      range: { start: { line: 1 } },
      uri: { fsPath: '/workspace/src/b.ts' },
    };

    const lintThread2 = {
      comments: [ { body: 'Lint issue 2' } ],
      label: 'Lint | info',
      range: { start: { line: 5 } },
      uri: { fsPath: '/workspace/src/c.ts' },
    };

    reviewCommentToChat(securityThread);
    reviewCommentToChat(lintThread1);
    reviewCommentToChat(lintThread2);

    expect(getQueuedPendingComments().length).toBe(3);

    // The last toast should aggregate both titles
    expect(vscode.window.showInformationMessage).toHaveBeenLastCalledWith(
      'Queued for chat: Security (1 comment), Lint (2 comments)',
      'Bring to Chat',
      'Cancel',
    );
  });
});
