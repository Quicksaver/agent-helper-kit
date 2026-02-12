import * as vscode from 'vscode';

import { type FileComments } from '@/types/FileComments';
import { type ReviewComment } from '@/types/ReviewComment';
import { toUri } from '@/uri';

function escapeMarkdownInlineText(value: string): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.replace(/([\\`*_{}[\]()#+\-.!|<>~$])/g, '\\$1');
}

export async function buildComment(
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
  markdown.isTrusted = { enabledCommands: [] };

  // Add line number anchor
  const { fileUri } = comment;
  const uri = fileUri
    ? vscode.Uri.parse(fileUri).with({ fragment: `L${comment.line}` })
    : await toUri(file.target, comment.line);
  markdown.appendMarkdown(`[Line ${comment.line}](${uri.toString()})`);

  if (comment.authorName) {
    markdown.appendMarkdown(` | *${escapeMarkdownInlineText(comment.authorName)}*`);
  }

  if (comment.severity) {
    markdown.appendMarkdown(` | **${comment.severity}**`);
  }

  const body = comment.comment.replace(/<\/?(?:details|summary)>/gi, '');
  markdown.appendMarkdown(`\n${body}`);

  return markdown;
}
