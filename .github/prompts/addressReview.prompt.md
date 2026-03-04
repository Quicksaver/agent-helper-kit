---
agent: agent
argument-hint: Paste the PR review content, including any file/line references in context.
description: Address a review of an ongoing task
---

You received the given code review for the most recent changes. First and foremost, consider if it has already been addressed by an earlier code review solution, and verify its validity.

- No review comment is "optional", it is either valid and thus actionable, or invalid and not actionable.
- "low impact" is still more than "no impact" and thus actionable.
- "optimization", as long as beneficial, is still more than "no optimization" and thus actionable.
- If actionable, perform the necessary code changes to address it, implement immediately without asking for confirmation.
- Provide a clear explanation of the comment, how it was addressed if valid, or of why it is not valid and any alternate recommendations for it if applicable. If multiple review comments are made, present in the form of a summarized table checklist or outline.
- Succinctly assess the quality of the reviewer, in terms of issue severity found, quality and relevance of feedback, all factored against validity (ratio of valid/non-valid). Discriminate for separate reviewers if applicable. Treat duplicates from the same reviewer as being the same comment, as long as each refers to a similar issue within a different block of code.
