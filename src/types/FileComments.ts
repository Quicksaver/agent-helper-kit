import { ReviewComment } from './ReviewComment';

export type FileComments = {
  comments: ReviewComment[];
  target: string; // target file
};
