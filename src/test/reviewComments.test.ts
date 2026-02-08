import {
  describe, expect, it, vi,
} from 'vitest';

const vscode = vi.hoisted(() => ({
  commands: {
    executeCommand: vi.fn(),
  },
  window: {
    showInformationMessage: vi.fn(),
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
import { getQueuedPendingComments, reviewCommentToChat } from '../reviewComments.js';

describe('reviewCommentToChat', () => {
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

    expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
      'workbench.action.chat.open',
      { isPartialQuery: true, query: '@bringCommentsToChat' },
    );

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

    expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
      'workbench.action.chat.open',
      { isPartialQuery: true, query: '@bringCommentsToChat' },
    );

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

    expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
      'workbench.action.chat.open',
      { isPartialQuery: true, query: '@bringCommentsToChat' },
    );

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

    expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
      'workbench.action.chat.open',
      { isPartialQuery: true, query: '@bringCommentsToChat' },
    );

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

    expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
      'workbench.action.chat.open',
      { isPartialQuery: true, query: '@bringCommentsToChat' },
    );

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

    expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
      'workbench.action.chat.open',
      { isPartialQuery: true, query: '@bringCommentsToChat' },
    );

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
      'Lint comment has been queued to chat',
    );

    const countAfterFirst = getQueuedPendingComments().length;

    // Call again with identical comment
    reviewCommentToChat(thread);

    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      'Lint comment already queued for chat',
    );

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
      'Security comment has been queued to chat',
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
      'Review comment has been queued to chat',
    );
  });

  it('should not add duplicate standalone comments', () => {
    const comment = { body: 'Standalone dup' };

    reviewCommentToChat(comment);

    const countAfterFirst = getQueuedPendingComments().length;

    reviewCommentToChat(comment);

    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      'Review comment already queued for chat',
    );

    expect(getQueuedPendingComments().length).toBe(countAfterFirst);
  });
});
