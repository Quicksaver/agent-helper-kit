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

**Terminal commands vs. VS Code's tools:**

| Action               | Use This                                        | Instead of                        |
| -------------------- | ----------------------------------------------- | --------------------------------- |
| Run tests            | `runTests` tool                                 | `yarn test`, `vitest run`         |
| Lint and typecheck   | `problems` tool                                 | `yarn lint:check`, `tsc --noEmit` |
| Fix lint/format code | `runCommand` with `workbench.action.files.save` | `yarn lint:fix`, `tsc --noEmit`   |

**Linting Workflow**

1. Tool `problems`
2. Tool `runCommand` with `ESLint: Fix all auto-fixable problems`
3. Tool `runCommand` with `Format Document`
4. Manual fixes
5. Troubleshooting:

- **`import/no-extraneous-dependencies` after install** → Restart ESLint Server

**Testing Workflow**

1. Tool `runTests`
2. Fix as necessary
