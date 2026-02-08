import * as vscode from 'vscode';

import { buildComment } from '@/chat.js';
import { type FileComments } from '@/types/FileComments.js';
import { type ReviewComment } from '@/types/ReviewComment.js';
import { toUri } from '@/uri';

/** Sentinel values used when a standalone comment has no associated file or line. */
const STANDALONE_FILE = 'unknown';
const STANDALONE_LINE = 1;

const queuedPendingComments: {
  comment: ReviewComment;
  file: FileComments;
  title: string;
}[] = [];

/** Returns a shallow copy of the current queued pending comments. Exposed for testing. */
export function getQueuedPendingComments(): {
  comment: ReviewComment;
  file: FileComments;
  title: string;
}[] {
  return queuedPendingComments.slice();
}

/** Clears all queued pending comments. Exposed for testing. */
export function clearQueuedPendingComments(): void {
  queuedPendingComments.splice(0);
}

/** Checks whether a comment with the same body, file, and line is already queued. */
function isAlreadyQueued(commentBody: string, file: string, line: number): boolean {
  return queuedPendingComments.some(
    entry => entry.comment.comment === commentBody && entry.comment.file === file && entry.comment.line === line,
  );
}

/**
 * Extracts the title portion from a comment thread label.
 *
 * If the label uses the `{title} | {severity}` format, returns the title before the pipe.
 * Otherwise returns the full label, or `'Review'` if no label is present.
 */
function parseTitle(thread: { label?: string }): string {
  if (!thread.label) {
    return 'Review';
  }

  const pipeIndex = thread.label.lastIndexOf('|');
  const title = pipeIndex === -1 ? thread.label : thread.label.slice(0, pipeIndex).trim();
  return title || 'Review';
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

const BRING_TO_CHAT = 'Bring to Chat';
const CANCEL = 'Cancel';

/** Shows a persistent toast listing all queued comment titles with action buttons. */
function showQueueToast(): void {
  const countByTitle = new Map<string, number>();

  for (const entry of queuedPendingComments) {
    countByTitle.set(entry.title, (countByTitle.get(entry.title) ?? 0) + 1);
  }

  const parts = [ ...countByTitle.entries() ].map(
    ([ title, count ]) => `${title} (${count} comment${count === 1 ? '' : 's'})`,
  );
  const message = `Queued for chat: ${parts.join(', ')}`;

  void vscode.window.showInformationMessage(message, BRING_TO_CHAT, CANCEL).then(choice => {
    if (choice === BRING_TO_CHAT) {
      void vscode.commands.executeCommand('workbench.action.chat.open', {
        query: '@bringCommentsToChat',
      });
    }

    if (choice === CANCEL) {
      queuedPendingComments.splice(0);
    }
  });
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
 * stores it as a pending review comment, and opens the chat panel with the `@bringCommentsToChat` participant
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

    const title = parseTitle(thread);

    if (isAlreadyQueued(body, relativePath, line)) {
      showQueueToast();
      return;
    }

    queuedPendingComments.push({
      comment: reviewComment,
      file: { comments: [ reviewComment ], target: relativePath },
      title,
    });

    showQueueToast();
    return;
  }

  // Fallback: treat arg as a single Comment (from comments/comment/title)
  const comment = arg as undefined | vscode.Comment;

  if (comment) {
    const body = extractCommentBody(comment);
    const reviewComment: ReviewComment = {
      comment: body,
      file: STANDALONE_FILE,
      line: STANDALONE_LINE,
    };

    if (isAlreadyQueued(body, STANDALONE_FILE, STANDALONE_LINE)) {
      showQueueToast();
      return;
    }

    queuedPendingComments.push({
      comment: reviewComment,
      file: { comments: [ reviewComment ], target: STANDALONE_FILE },
      title: 'Review',
    });

    showQueueToast();
  }
}

/**
 * Chat participant request handler for `@bringCommentsToChat`.
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
  const byFile = new Map<string, FileComments>();

  for (const entry of comments) {
    const { file } = entry;

    if (!byFile.has(file.target)) {
      byFile.set(file.target, {
        ...file,
        comments: [],
      });
    }

    byFile.get(file.target)?.comments.push(entry.comment);
  }

  for (const entry of byFile.entries()) {
    const [ target, fileComments ] = entry;

    // eslint-disable-next-line no-await-in-loop
    const uri = await toUri(target);
    stream.anchor(uri);
    stream.markdown('\n\n');

    for (const comment of fileComments.comments) {
      // eslint-disable-next-line no-await-in-loop -- sequential writes to stream to preserve ordering
      stream.markdown(await buildComment(fileComments, comment));
      stream.markdown('\n\n');
    }

    stream.markdown('\n --- \n');
  }
}

/** Registers the `@review` chat participant and adds it to the extension context subscriptions. */
export function registerReviewParticipant(context: vscode.ExtensionContext): void {
  const participant = vscode.chat.createChatParticipant(
    'custom-vscode.bringCommentsToChat',
    handleCopyCommentToChatRequest,
  );
  participant.iconPath = new vscode.ThemeIcon('comment-discussion');
  context.subscriptions.push(participant);
}
