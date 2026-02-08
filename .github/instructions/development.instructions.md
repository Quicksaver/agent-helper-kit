---
applyTo: '**'
---

**TypeScript Standards**

- Use `Id<"tableName">` for document IDs
- Use `Doc<"tableName">` for document types
- Use `as const` for literal types
- Use type annotation when calling functions in same file (circularity workaround)

**Acceptance Criteria**

- All code must be linted and formatted, see "Linting Workflow" below.
- All tests must pass, see "Testing Workflow" below.

**Package Manager**

Use `yarn` (yarn.lock present)

**Linting Workflow**

1. (VSCode command) ESLint: Fix all auto-fixable problems
2. (VSCode command) Format Document
3. Manual fixes
4. Troubleshooting:

- **`import/no-extraneous-dependencies` after install** → Restart ESLint Server

**Testing Workflow**

1. `yarn test`
