# AI PR Review

Central GitHub Actions implementation for deterministic, multi-model PR review.

The architecture source of truth is `docs/superpowers/specs/2026-09-10-ai-pr-review-design.md`.
The execution plan is `docs/superpowers/plans/2026-09-10-ai-pr-review-implementation.md`.

## Local checks

```bash
npm ci
npm run check
npm run build
```

Do not add consumer-specific review prompts, model overrides, or secrets to this repository.
