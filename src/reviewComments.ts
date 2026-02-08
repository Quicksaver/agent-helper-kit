import * as vscode from 'vscode';

import { buildComment } from '@/chat.js';
import { type FileComments } from '@/types/FileComments.js';
import { type ReviewComment } from '@/types/ReviewComment.js';

const queuedPendingComments: { comment: ReviewComment; file: FileComments }[] = [];

/** Returns a shallow copy of the current queued pending comments. Exposed for testing. */
export function getQueuedPendingComments(): { comment: ReviewComment; file: FileComments }[] {
  return queuedPendingComments.slice();
}

/** Extracts the plain text body from a {@link vscode.Comment}, handling both string and MarkdownString values. */
function extractCommentBody(comment: vscode.Comment): string {
  return typeof comment.body === 'string' ? comment.body : comment.body.value;
}

/**
 * Parses severity from a comment thread label.
 *
 * Many review extensions use a `{title} | {severity}` format in the thread label.
 * Returns the trimmed severity string, or `undefined` if no pipe separator is found.
 */
function parseSeverity(thread: vscode.CommentThread): string | undefined {
  if (!thread.label) {
    return undefined;
  }

  const pipeIndex = thread.label.lastIndexOf('|');

  if (pipeIndex === -1) {
    return undefined;
  }

  const severity = thread.label.slice(pipeIndex + 1).trim();
  return severity || undefined;
}

/**
 * Attempts to resolve a {@link vscode.CommentThread} from the command argument.
 *
 * Menu contributions on `comments/commentThread/title` pass a `CommentThread` directly,
 * while `comments/comment/title` passes a `Comment` which has no reliable parent reference.
 */
function resolveCommentThread(arg: unknown): undefined | vscode.CommentThread {
  const obj = arg as Record<string, unknown>;

  if (Array.isArray(obj.comments) && 'uri' in obj) {
    return obj as unknown as vscode.CommentThread;
  }

  return undefined;
}

/**
 * Command handler for `custom-vscode.reviewCommentToChat`.
 *
 * Extracts the comment data from the provided {@link vscode.CommentThread} or {@link vscode.Comment},
 * stores it as a pending review comment, and opens the chat panel with the `@copyCommentToChat` participant
 * so the user can review and send.
 */
export function reviewCommentToChat(arg: unknown): void {
  const thread = resolveCommentThread(arg);

  if (thread) {
    const body = thread.comments.map(c => extractCommentBody(c)).join('\n');
    const relativePath = vscode.workspace.asRelativePath(thread.uri);
    const line = thread.range ? thread.range.start.line + 1 : 1;

    const severity = parseSeverity(thread);

    const reviewComment: ReviewComment = {
      comment: body,
      file: relativePath,
      line,
      ...(severity && { severity }),
    };

    queuedPendingComments.push({
      comment: reviewComment,
      file: { comments: [ reviewComment ], target: relativePath },
    });

    void vscode.commands.executeCommand('workbench.action.chat.open', {
      isPartialQuery: true,
      query: '@copyCommentToChat',
    });
    return;
  }

  // Fallback: treat arg as a single Comment (from comments/comment/title)
  const comment = arg as undefined | vscode.Comment;

  if (comment) {
    const body = extractCommentBody(comment);
    const reviewComment: ReviewComment = {
      comment: body,
      file: 'unknown',
      line: 1,
    };

    queuedPendingComments.push({
      comment: reviewComment,
      file: { comments: [ reviewComment ], target: 'unknown' },
    });

    void vscode.commands.executeCommand('workbench.action.chat.open', {
      isPartialQuery: true,
      query: '@copyCommentToChat',
    });
  }
}

/**
 * Chat participant request handler for `@copyCommentToChat`.
 *
 * Reads the pending review comment, formats it via {@link buildComment},
 * and streams the result to the chat response.
 */
async function handleCopyCommentToChatRequest(
  _request: vscode.ChatRequest,
  _context: vscode.ChatContext,
  stream: vscode.ChatResponseStream,
): Promise<void> {
  if (queuedPendingComments.length === 0) {
    stream.markdown('No review comment pending.');
    return;
  }

  const comments = queuedPendingComments.splice(0);

  for (const entry of comments) {
    // eslint-disable-next-line no-await-in-loop -- sequential writes to stream to preserve ordering
    await buildComment(stream, entry.file, entry.comment);
  }
}

/** Registers the `@review` chat participant and adds it to the extension context subscriptions. */
export function registerReviewParticipant(context: vscode.ExtensionContext): void {
  const participant = vscode.chat.createChatParticipant(
    'custom-vscode.copyCommentToChat',
    handleCopyCommentToChatRequest,
  );
  participant.iconPath = new vscode.ThemeIcon('comment-discussion');
  context.subscriptions.push(participant);
}
