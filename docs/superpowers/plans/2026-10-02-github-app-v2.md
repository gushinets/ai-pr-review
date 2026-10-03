# GitHub App V2 implementation plan

> For agentic workers: execute inline with superpowers:executing-plans. Each
> task has regression tests, a verification run and a scoped commit.

**Goal:** Consumer-zero-secret `/ai-review` through a GitHub App and central engine.
**Architecture:** Preserve preparation, confined Rejudge worker and publisher;
add request, requirements, App and central-state adapters.
**Tech Stack:** Existing TypeScript/Octokit/Vitest, Node crypto/http/sqlite,
GitHub Actions and pinned CodeGraph in a bounded Linux container.
**Spec:** `docs/v2-design.md`; full user request retained in task attachment.

## Global constraints

- Keep V1 working; never execute target code or trust HEAD config.
- Preserve sanitized state, blocker closure, same-head no-reroll and stale barriers.
- Separate App/Linear, provider and publisher credentials by phase.
- No automatic V2 push review; write-level commenter authorization is mandatory.

## Review focus

- Replay after dispatch ambiguity must not cause additional budget consumption.
- Central state must reject target artifacts and wrong workflow provenance.
- Moving base/head must stop persistence and every publication phase.
- Graph configs, symlinks, malicious paths/output must not escape the snapshot.
- Shadow arms must not be discoverable as canonical state or publish a verdict.

## Tasks

- [x] 1. Amend V1 architecture before implementation; commit this spec/plan.
- [x] 2. Add validated `ReviewRequest`, optional BASE config and none/Linear
      providers. Adapt pipeline and nullable persisted identity; test zero-config,
      invalid config, trusted BASE, no requirements and historical V1 parsing.
- [x] 3. Add App JWT/scoped tokens, signed webhook, durable command claims and
      central dispatcher. Test auth, permission, malformed/unrelated events,
      replay, duplicates, installation errors and new HEAD.
- [x] 4. Separate central artifact repository/provenance and App publisher
      ownership. Test cross-repo state, rerolls, history and stale/closed PRs.
- [x] 5. Add bounded graph runner and sanitized evidence/experiment telemetry.
      Test static graph fixtures, paths, symlinks, output limits and failures.
- [x] 6. Wire central workflow/CLI, isolated phases, manifest/container setup.
      Test workflow credential boundaries and fake lifecycle through real engine
      orchestration and publisher; retain old fixture and adversarial tests.
- [x] 7. Update primary README/operations/checklist. Run complete deterministic
      checks/build; fresh independent diff review, fix findings, rerun/review.
- [x] 8. Commit all implementation, push/open PR if authorized access permits;
      do not merge. Report genuine owner setup requirements and verification.

## Execution ledger

- Branch: `codex/github-app-v2`; clean starting checkout on main.
- Decisions: use the supplied autonomous spec; execute inline without routine
  approval pauses. Reuse existing schema with explicit nullable Linear field.
- Domain implementation/review agents handled App and graph independently; the
  central adapters stayed inline. Each domain received a separate read-only review.
- App review fixed signed-body replay via changed delivery headers, terminal-failure
  retry claims and ineffective Octokit deadlines. Graph review fixed multibyte
  fallback output overflow and the SDK's hidden dynamic-boundary scan cap. Domain
  re-reviews report no remaining findings.
- Completion happens after publication in a fresh job. Its HMAC secret is absent
  from model/graph/publisher phases. Failed publication releases only the original
  command claim; persisted PASS/BLOCK is still reused.
- Both comparison arms are fresh private shadows; neither publishes. Normal
  canonical requests select one production graph mode.
- Linux Node 22.19.0 verification after final fixes: `npm run check`, 1,126 deterministic
  tests and build passed. All existing adversarial filesystem tests were retained.
  The separate real CodeGraph container fixture passed, as did the gateway image
  build and `/healthz` smoke check using fake credentials.
- Complete-diff independent review found three request-boundary issues: valid
  dot-prefixed repository names, gateway/central delivery validation mismatch and
  internal token/callback routing. Regression tests reproduced each failure; all
  were fixed. A focused re-review reports no remaining material findings.
- PR: https://github.com/gushinets/ai-pr-review/pull/7. The initial GitHub CI passed;
  final-head CI is tracked on the PR. The PR is not merged. Production
  App registration/installation, HTTPS deployment, persistent storage and secrets
  require operator setup; `docs/operations.md` contains the checklist and live
  acceptance sequence. No real installed-App/model E2E is claimed.

## PR #7 final fix pass

- [x] Isolate canonical and shadow concurrency, enable GitHub's bounded pending
      queue, and add operator reconciliation for accepted dispatches that never
      start. Absence or elapsed time never proves safety; release requires a
      maintenance freeze and two observations of cancelled runs with no jobs
      across any attempt. Completed commands remain immutable.
- [x] Ship a private pilot. Use a separate private dispatcher App installed only
      on the central repository. The target App requests Actions read; explicit
      repository, App ownership, token expiration and effective scope checks
      remain enforced.
- [x] Resolve validated graph telemetry before models. Missing, invalid or
      unreadable graph manifests become ARTIFACT_IO; graph-off needs no manifest.
      Decode raw stdout/stderr buffers once after close while preserving byte caps.
- [x] Verify fresh Linux `npm ci`, `npm run check` and `npm run build`: 1,180 tests
      passed; the gated real CodeGraph fixture passed separately. Rebuilt the
      gateway image and checked `/healthz` with separate fake App identities.
      All security/adversarial tests remain enabled.
- [x] Complete a fresh independent review of the entire merge-base diff: no
      material findings. Its separate targeted run passed 267 tests across 14
      files; the live installed-App acceptance gap remains operational.
- [x] Record the three scoped code fixes and private two-App operations guide.
      PR #7 tracks the pushed head, evidence replies/thread resolutions and
      GitHub CI; its description records final validation. Do not merge.
- Operational acceptance still requires private App registration and installation,
  gateway HTTPS deployment, persistent storage, separate App keys, central
  variables/secrets and a real installed-App zero-config E2E. Public admission,
  quotas and billing remain future work.
