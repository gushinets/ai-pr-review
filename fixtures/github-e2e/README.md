# GitHub E2E fixture

This directory is the versioned definition for the private `gushinets/ai-pr-review-fixture` repository.

ENGINE_CANDIDATE_SHA: 660525298b8785158fc8339add65f0e5cd87e749

Promotion run: 34761353229

Promotion URL: https://github.com/gushinets/ai-pr-review/actions/runs/34761353229

## File mapping

| Central fixture      | External fixture repository          |
| -------------------- | ------------------------------------ |
| `ai-review.yml`      | `.github/ai-review.yml`              |
| `primary-ci.yml`     | `.github/workflows/primary-ci.yml`   |
| `caller.yml`         | `.github/workflows/ai-pr-review.yml` |
| `AGENTS.md`          | `AGENTS.md`                          |
| `base/calculator.ts` | `main: calculator.ts`                |
| `bad/calculator.ts`  | bad PR head: `calculator.ts`         |
| `good/calculator.ts` | good PR head: `calculator.ts`        |

## Operator inputs

Set `E2E_LINEAR_ISSUE=ANY-N` to the dedicated private Linear fixture issue. Do not commit secret values or OAuth client values.

Expected lifecycle: `base -> bad -> good`.
