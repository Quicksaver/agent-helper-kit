export type ReviewComment = {
  authorName?: string; // comment author display name
  comment: string; // review comment
  file: string; // file path (relative to workspace)
  fileUri?: string; // original vscode.Uri.toString() — avoids lossy reconstruction in multi-root workspaces
  line: number; // first affected line number (1-based, to-side of diff)
  severity?: string; // critical, major, minor... Not an enum to fit many existing comment formats
};
