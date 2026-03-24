import * as vscode from 'vscode';

import { buildComment } from '@/chat';
import {
  EXTENSION_CONFIG_SECTION,
  QUEUE_BEFORE_SEND_SETTING,
} from '@/reviewCommentConfig';
import { type FileComments } from '@/types/FileComments';
import { type ReviewComment } from '@/types/ReviewComment';
import { toUri } from '@/uri';

/** Sentinel values used when a standalone comment has no associated file or line. */
const STANDALONE_FILE = 'unknown';
const STANDALONE_LINE = 1;

const queuedPendingComments: {
  comment: ReviewComment;
  file: FileComments;
  title: string;
}[] = [];

let immediateSendInFlight = false;

const AUTHOR_NAME_REWRITES: Record<string, string> = {
  'Code Review': 'Copilot Code Review',
};

/** Returns a shallow copy of the current queued pending comments. Exposed for testing. */
export function getQueuedPendingComments(): {
  comment: ReviewComment;
  file: FileComments;
  title: string;
}[] {
  return queuedPendingComments.slice();
}

let dismissCurrentToast: (() => void) | undefined;

/** Dismisses the currently-displayed queue toast, if any. Also exported for testing. */
export function dismissQueueToast(): void {
  if (dismissCurrentToast) {
    dismissCurrentToast();
    dismissCurrentToast = undefined;
  }
}

/** Clears all queued pending comments and dismisses the active toast. Exposed for testing. */
export function clearQueuedPendingComments(): void {
  queuedPendingComments.splice(0);
  immediateSendInFlight = false;
  dismissQueueToast();
}

function shouldQueueBeforeSend(): boolean {
  const configuration = vscode.workspace.getConfiguration(EXTENSION_CONFIG_SECTION);
  return configuration.get(QUEUE_BEFORE_SEND_SETTING, false);
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
 * Extracts an author name from a comment-like object, if available.
 *
 * Some review providers include an `author.name` field on their comment shape.
 * This helper safely inspects unknown input and treats whitespace-only names as absent.
 */
function extractAuthorName(comment: unknown): string | undefined {
  if (!comment || typeof comment !== 'object') {
    return undefined;
  }

  const maybeAuthor = (comment as { author?: unknown }).author;

  if (!maybeAuthor || typeof maybeAuthor !== 'object') {
    return undefined;
  }

  const maybeName = (maybeAuthor as { name?: unknown }).name;

  if (typeof maybeName !== 'string') {
    return undefined;
  }

  const trimmed = maybeName.trim();
  if (trimmed.length === 0) {
    return undefined;
  }

  return AUTHOR_NAME_REWRITES[trimmed] ?? trimmed;
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

/** Regex matching thread titles of the form "Comment x of y". */
const COMMENT_N_OF_TOTAL = /^Comment (\d+) of (\d+)$/;

/**
 * Formats a list of numbers using Oxford-comma style.
 *
 * - `[1]` → `'1'`
 * - `[1, 3]` → `'1 and 3'`
 * - `[1, 2, 4]` → `'1, 2, and 4'`
 */
function formatNumberList(nums: number[]): string {
  if (nums.length <= 2) {
    return nums.join(' and ');
  }

  return `${nums.slice(0, -1).join(', ')}, and ${nums[nums.length - 1]}`;
}

/**
 * Builds the human-readable parts array for the queue toast.
 *
 * Titles matching `Comment x of y` are grouped by their total:
 * - **Single comment** → kept as-is (e.g. `Comment 2 of 4`).
 * - **All comments present** → `All y comments`.
 * - **Some comments present** → `Comments 1, 2, and 4, of y`.
 *
 * All other titles use the default `Title (xN)` format.
 */
export function formatQueueParts(countByTitle: Map<string, number>): string[] {
  const parts: string[] = [];
  const commentGroups = new Map<number, number[]>();

  for (const [ title, count ] of countByTitle.entries()) {
    const match = COMMENT_N_OF_TOTAL.exec(title);

    if (match) {
      const num = Number(match[1]);
      const total = Number(match[2]);
      const group = commentGroups.get(total) ?? [];

      if (group.length === 0) {
        commentGroups.set(total, group);
      }

      // Push `num` once per occurrence so that the single-unique branch
      // can surface the duplicate count (e.g. "Comment 1 of 4 (x2)").
      // Multi-unique branches intentionally discard duplicates via Set
      // since "Comments 1, 2, and 4, of 4" is clearer without per-number counts.
      for (let i = 0; i < count; i++) {
        group.push(num);
      }
    }
    else {
      parts.push(`${title}${count > 1 ? ` (x${count})` : ''}`);
    }
  }

  for (const [ total, nums ] of commentGroups.entries()) {
    const unique = [ ...new Set(nums) ].sort((a, b) => a - b);

    if (unique.length === 1) {
      const display = `Comment ${unique[0]} of ${total}`;
      const dupeCount = nums.length;
      parts.push(dupeCount > 1 ? `${display} (x${dupeCount})` : display);
    }
    else if (unique.length === total) {
      parts.push(`All ${total} comments`);
    }
    else {
      parts.push(`Comments ${formatNumberList(unique)}, of ${total}`);
    }
  }

  return parts;
}

/**
 * Shows a persistent notification listing all queued comment titles.
 *
 * Uses {@link vscode.window.withProgress} with {@link vscode.ProgressLocation.Notification}
 * so the toast stays visible until explicitly dismissed and never stacks — each call
 * replaces the previous notification. Clicking **Cancel** clears the queue.
 */
function showQueueToast(): void {
  dismissQueueToast();

  if (queuedPendingComments.length === 0) {
    return;
  }

  const countByTitle = new Map<string, number>();

  for (const entry of queuedPendingComments) {
    countByTitle.set(entry.title, (countByTitle.get(entry.title) ?? 0) + 1);
  }

  const parts = formatQueueParts(countByTitle);
  const message = `Queued for chat: ${parts.join(', ')}`;

  void vscode.window.withProgress(
    {
      cancellable: true,
      location: vscode.ProgressLocation.Notification,
      title: message,
    },
    (_progress, token) => new Promise<void>(resolve => {
      let cancellationDisposable: undefined | vscode.Disposable;

      const resolveAndCleanup = (): void => {
        cancellationDisposable?.dispose();
        cancellationDisposable = undefined;
        dismissCurrentToast = undefined;
        resolve();
      };

      dismissCurrentToast = resolveAndCleanup;

      cancellationDisposable = token.onCancellationRequested(() => {
        queuedPendingComments.splice(0);
        resolveAndCleanup();
      });
    }),
  );

  void vscode.commands.executeCommand('workbench.action.chat.open', {
    isPartialQuery: true,
    query: '@bringCommentsToChat',
  });
}

function sendQueuedCommentsToChat(): void {
  if (queuedPendingComments.length === 0 || immediateSendInFlight) {
    return;
  }

  immediateSendInFlight = true;
  void vscode.commands.executeCommand('workbench.action.chat.open', {
    query: '@bringCommentsToChat',
  });
}

function handleDuplicateQueuedComment(): void {
  if (shouldQueueBeforeSend()) {
    showQueueToast();
  }
}

function handleQueuedCommentsUpdated(): void {
  if (shouldQueueBeforeSend()) {
    showQueueToast();
    return;
  }

  dismissQueueToast();
  sendQueuedCommentsToChat();
}

/**
 * Attempts to resolve a {@link vscode.CommentThread} from the command argument.
 *
 * Menu contributions on `comments/commentThread/title` pass a `CommentThread` directly,
 * while `comments/comment/title` passes a `Comment` which has no reliable parent reference.
 */
function resolveCommentThread(arg: unknown): undefined | vscode.CommentThread {
  if (!arg || typeof arg !== 'object') {
    return undefined;
  }

  const obj = arg as Record<string, unknown>;

  if (Array.isArray(obj.comments) && 'uri' in obj) {
    return obj as unknown as vscode.CommentThread;
  }

  return undefined;
}

/**
 * Command handler for `agent-helper-kit.reviewCommentToChat`.
 *
 * Extracts the comment data from the provided {@link vscode.CommentThread} or {@link vscode.Comment},
 * stores it as a pending review comment, then either sends it to chat immediately or,
 * when the legacy queue mode is enabled, opens chat with the participant prefilled so
 * the user can send all queued comments together.
 */
export function reviewCommentToChat(arg: unknown): void {
  const thread = resolveCommentThread(arg);

  if (thread) {
    let firstAuthorName: string | undefined;
    const distinctAuthors = new Set<string>();

    for (const c of thread.comments) {
      const name = extractAuthorName(c);
      if (name) {
        distinctAuthors.add(name);
        firstAuthorName ??= name;
      }
    }
    const body = thread.comments.map(c => extractCommentBody(c)).join('\n');
    const relativePath = vscode.workspace.asRelativePath(thread.uri);
    const line = thread.range ? thread.range.start.line + 1 : 1;

    const severity = parseSeverity(thread);

    const reviewComment: ReviewComment = {
      comment: body,
      file: relativePath,
      fileUri: thread.uri.toString(),
      line,
      // Omit author attribution when multiple distinct authors are present
      // to avoid implying all aggregated content was authored by one person.
      ...(distinctAuthors.size <= 1 && firstAuthorName && { authorName: firstAuthorName }),
      ...(severity && { severity }),
    };

    const title = parseTitle(thread);

    if (isAlreadyQueued(body, relativePath, line)) {
      handleDuplicateQueuedComment();
      return;
    }

    queuedPendingComments.push({
      comment: reviewComment,
      file: { comments: [ reviewComment ], target: relativePath },
      title,
    });

    handleQueuedCommentsUpdated();
    return;
  }

  // Fallback: treat arg as a single Comment (from comments/comment/title)
  const comment = arg as undefined | vscode.Comment;

  if (comment) {
    const body = extractCommentBody(comment);
    const authorName = extractAuthorName(comment);
    const reviewComment: ReviewComment = {
      comment: body,
      file: STANDALONE_FILE,
      line: STANDALONE_LINE,
      ...(authorName && { authorName }),
    };

    if (isAlreadyQueued(body, STANDALONE_FILE, STANDALONE_LINE)) {
      handleDuplicateQueuedComment();
      return;
    }

    queuedPendingComments.push({
      comment: reviewComment,
      file: { comments: [ reviewComment ], target: STANDALONE_FILE },
      title: 'Review',
    });

    handleQueuedCommentsUpdated();
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
    immediateSendInFlight = false;
    stream.markdown('No review comment pending.');
    return;
  }

  dismissQueueToast();

  const comments = queuedPendingComments.splice(0);
  const byFile = new Map<string, FileComments>();

  try {
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

      const firstComment = fileComments.comments[0];
      const { fileUri } = firstComment;
      // eslint-disable-next-line no-await-in-loop
      const uri = fileUri ? vscode.Uri.parse(fileUri) : await toUri(target);
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
  finally {
    immediateSendInFlight = false;

    if (!shouldQueueBeforeSend()) {
      sendQueuedCommentsToChat();
    }
  }
}

/** Registers the `@review` chat participant. */
export function registerReviewParticipant(): vscode.Disposable {
  const participant = vscode.chat.createChatParticipant(
    'agent-helper-kit.bringCommentsToChat',
    handleCopyCommentToChatRequest,
  );
  participant.iconPath = new vscode.ThemeIcon('comment-discussion');
  return participant;
}
