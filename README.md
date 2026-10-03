# AI PR Review

Private GitHub App pilot for deterministic, multi-model PR review.

## Use AI PR Review

1. The App owner installs the private **AI PR Review GitHub App** on pilot repositories.
2. Open a pull request.
3. A collaborator with write, maintain or admin access comments `/ai-review`.

The App reviews exact base/head, publishes the **AI PR Review** Check Run,
updates one stable summary and adds inline findings. After a correction, post
a new comment. Pushes alone do not trigger V2. Completed same-head results are
reused; failed execution/publication can be retried without rerolling a verdict.

Consumers need no review workflow, provider key, Linear credential, PAT or
configuration file. Optional configuration and policy are read only from BASE.
Linear is optional. CodeGraph comparison runs are private shadows.

This pilot supports repositories owned by the App's account or organization.
Public installation requires a later access/quota/rate-control decision; no
billing system or unrestricted public rollout is included.

Operator deployment and live App acceptance are still required; see the
[operator checklist](docs/operations.md#v2-operator-checklist). Fixtures do not
claim a production App installation or live model E2E.

Architecture: [V2 amendment](docs/v2-design.md) and retained
[V1 security design](docs/superpowers/specs/2026-09-10-ai-pr-review-design.md).
Migration plan: [GitHub App V2](docs/superpowers/plans/2026-10-02-github-app-v2.md).

## Local checks

```bash
npm ci
npm run check
npm run build
# Optional real static-processor fixture (no model or GitHub credentials):
docker build -t ai-pr-review-codegraph:1.6.1 graph
CODEGRAPH_CONTAINER_TEST=1 npm test -- test/graph/container.test.ts
```

Do not add consumer-specific review prompts, model overrides, or secrets to this repository.

The full adversarial suite needs Linux filesystem semantics and `rg`/`fdfind`;
CI uses Ubuntu 24.04. Windows without symlink privilege cannot run every
confinement test. Those tests remain enforced in Linux CI.

## Legacy V1 / internal integration

`.github/workflows/reusable-ai-pr-review.yml` remains available. Its mandatory
config, consumer secrets, Linear identity and automatic CI trigger are legacy
behavior. See [legacy operations](docs/operations.md#legacy-v1-operations) and
the existing [E2E fixture](fixtures/github-e2e/README.md). Keep V1 installed until
the real App lifecycle is verified. This migration does not change merge rules.
