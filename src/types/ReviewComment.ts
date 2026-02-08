export type ReviewComment = {
  comment: string; // review comment
  file: string; // file path
  line: number; // first affected line number (1-based, to-side of diff)
  severity?: string; // critical, major, minor... Not an enum to fit many existing comment formats
};
