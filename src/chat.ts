import * as vscode from 'vscode';

import { type FileComments } from '@/types/FileComments';
import { ReviewComment } from '@/types/ReviewComment';
import { toUri } from '@/uri';

export async function buildComment(
  stream: vscode.ChatResponseStream,
  file: FileComments,
  comment: ReviewComment,
) {
  // some things learned about the markdown parsing:
  // - pushing multiple items to the stream with different isTrusted values will add newlines between them
  // - using theme icons can break other markdown (links) following it (also can cause display issues if main
  //   comment contains $(var) type text)
  // - using quotes (>) helps isolate unclosed markdown elements from the following unquoted text

  // Build the entire comment as a single markdown string
  const markdown = new vscode.MarkdownString();

  // Add line number anchor
  const uri = await toUri(file.target, comment.line);
  stream.anchor(uri);

  markdown.appendText(`Line ${comment.line}`);

  if (comment.severity) {
    markdown.appendMarkdown(` | **${comment.severity}**`);
  }

  const body = comment.comment.replace(/<\/?(?:details|summary)>/gi, '');
  markdown.appendMarkdown(`\n${body}`);

  stream.markdown(markdown);
}
