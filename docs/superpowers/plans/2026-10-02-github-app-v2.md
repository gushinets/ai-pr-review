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

- [ ] 1. Amend V1 architecture before implementation; commit this spec/plan.
- [ ] 2. Add validated `ReviewRequest`, optional BASE config and none/Linear
      providers. Adapt pipeline and nullable persisted identity; test zero-config,
      invalid config, trusted BASE, no requirements and historical V1 parsing.
- [ ] 3. Add App JWT/scoped tokens, signed webhook, durable command claims and
      central dispatcher. Test auth, permission, malformed/unrelated events,
      replay, duplicates, installation errors and new HEAD.
- [ ] 4. Separate central artifact repository/provenance and App publisher
      ownership. Test cross-repo state, rerolls, history and stale/closed PRs.
- [ ] 5. Add bounded graph runner and sanitized evidence/experiment telemetry.
      Test static graph fixtures, paths, symlinks, output limits and failures.
- [ ] 6. Wire central workflow/CLI, isolated phases, manifest/container setup.
      Test workflow credential boundaries and fake lifecycle through real engine
      orchestration and publisher; retain old fixture and adversarial tests.
- [ ] 7. Update primary README/operations/checklist. Run complete deterministic
      checks/build; fresh independent diff review, fix findings, rerun/review.
- [ ] 8. Commit all implementation, push/open PR if authorized access permits;
      do not merge. Report genuine owner setup requirements and verification.

## Execution ledger

- Branch: `codex/github-app-v2`; clean starting checkout on main.
- Decisions: use the supplied autonomous spec; execute inline without routine
  approval pauses. Reuse existing schema with explicit nullable Linear field.
