---
name: vitest
description: Create new and update existing Vitest unit and integration tests.
---

# Vitest Tests

## Organization

- **Unit tests co-located with test code**: Unit tests should be placed in the same directory as the code they test, with filenames ending in `.test.ts` or `.test.tsx`. E.g. when testing a component at `components/Button/Button.tsx`, the tests should be in `components/Button/Button.test.tsx`.
- **Integration tests in `test/integration` directory**: End-to-end tests should be placed in the `test/integration` directory, organized by package. E.g. tests for the login flow could be in `next-app/test/integration/login.test.ts`.
- **Fixtures and mocks in `test/fixtures` and `test/mocks`**: Any test fixtures, mock data, or helper functions that are shared across multiple tests should be placed in the corresponding directory.

## Guidelines

- **Use Vitest's `describe` and `it` blocks**: Structure tests with `describe` blocks for grouping related tests and `it` blocks for individual test cases. This improves readability and test organization.
- **Mock external dependencies**: Use Vitest's mocking capabilities to isolate the code under test and avoid making real network requests or relying on external services in unit tests.
- **Mock unrelated modules**: When testing a specific module, mock unrelated modules to ensure tests are focused and not affected by changes in other parts of the codebase.
- **Test coverage**: Aim for high test coverage, but prioritize meaningful tests that cover critical paths and edge cases. Use coverage reports to identify untested code and add tests as needed.

## Focus

- **Unit tests**: Always test the actual code implementations by importing the necessary methods, without replicating it within the test.
- **Integration tests**: Test user flows and interactions by simulating real user behavior, such as clicking buttons, filling out forms, and navigating pages, rather than testing implementation details.
