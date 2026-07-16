# Cleanup program baselines: 2026-07-16

Recorded at the start of the cleanup program, on branch `chore/cleanup-program`
based at commit `8c83f73` (current HEAD of `feat/leads-mqls-multi-channel`,
including the campaign multi-tag + multi-touch work). Isolated in a git worktree
so the active Events changes in the main working tree are untouched.

## Verification baselines (before any cleanup)

| Check | Command | Result |
|---|---|---|
| ESLint | `npx eslint .` | **43 errors, 10 warnings** (53 problems) |
| Typecheck | `tsc -b --pretty false --noEmit` | clean (exit 0) |
| Build | `npm run build` (`tsc -b && vite build`) | passes |
| Tests | none | no test script yet (0 tests) |

## ESLint baseline by rule

| Count | Rule | Severity |
|---|---|---|
| 28 | `react-hooks/set-state-in-effect` | error |
| 9 | `react-hooks/exhaustive-deps` | warning |
| 5 | `react-refresh/only-export-components` | error |
| 5 | `react-hooks/purity` | error |
| 4 | `react-hooks/refs` | error |
| 1 | `react-hooks/immutability` | error |
| 1 | (parse) | warning |

These are the counts the lint-gating rule (Section 4.6) references. No PR may
increase either the error or warning count until Step 11 converges lint to zero.

## Isolation

- Main working tree (`sourced-app/`): branch `feat/leads-mqls-multi-channel`,
  holds the uncommitted Events changes. NOT touched by this program.
- Cleanup worktree (`sourced-cleanup/`): branch `chore/cleanup-program` from
  `8c83f73`. All cleanup work happens here.
