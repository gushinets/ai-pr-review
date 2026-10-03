# AI PR Review V2 architecture amendment

This amendment supersedes the V1 product-boundary decisions in the September
2026 design. Reusable workflows, no GitHub App, mandatory consumer workflows,
consumer secrets and mandatory Linear context are historical V1 decisions.
The mature review engine and V1 integration remain supported during migration.

## Product boundary

Pilot: the App owner installs the private GitHub App on its own repositories,
selects repositories and comments `/ai-review` on an open PR. Public installation
is deferred until separate admission, quotas/rate controls and funding policy exist.
Only collaborators with write, maintain or admin permission may spend model
budget. Pushes do not trigger V2 reviews. No consumer workflow, PAT, provider
key, Linear credential or config file is required.

The gateway verifies HMAC-SHA256 over raw webhook bytes, accepts created PR
conversation comments only, resolves installation and PR through GitHub APIs,
authorizes the commenter, captures exact base/head and the authenticated private
execution repository's default-branch engine SHA, then dispatches the central
workflow. A durable SQLite command ledger handles delivery replay and command
identity. Canonical Actions concurrency serializes reviews of each target PR
using `queue: max`; shadows use independent run-scoped concurrency domains;
canonical completed PASS/BLOCK state prevents rerolls for the same engine across
commands/restarts. A new trusted engine SHA permits a new command on unchanged
target code. Completion signatures bind the engine and original delivery.
Signed comment IDs remain consumed independently of unsigned delivery headers.
A purpose-separated HMAC completion callback retains completed claims or releases
only the original claim after terminal execution/publication failure. A new comment
can then retry; old webhook/callback replay cannot release a later claim.
Ambiguous dispatch failures remain claimed until reconciled by an operator.
The local recovery CLI distinguishes active/executed/absent/ambiguous evidence.
Under an operator maintenance freeze, it releases only matching cancelled runs
with zero jobs across all attempts, after two fresh inspections. Missing runs or
elapsed time never prove non-dispatch; completed claims and tombstones remain.
Legacy completed four-field claims can be bound to an independently verified
historical engine through an operator-only transaction; active or ambiguous
legacy claims remain held.

## Central execution

Transport-independent requests identify repository, PR, exact base/head,
engine SHA, trigger, optional Linear provider and graph mode. Adapters convert
requests to the existing preflight/prepare/execute/publish pipeline. Central
execution revalidates authorization and installation access; request text is
never interpolated into shell source. Config and policy are loaded only from
BASE. Missing V2 config selects empty policy and a central CI label; invalid
present config fails closed. No policy discovery or HEAD instructions.

Requirements providers are `none` and `linear`. Absence is explicit evidence,
not an error. Linear remains private normative evidence, never instructions.
Nullable Linear identity is an additive persisted-schema migration: existing
V1 artifacts remain readable; transport/config behavior remains V1 by default.

V2 runs only in a private execution/state repository containing the trusted
engine and workflow; this public source repository is not an execution target.
Authenticated GitHub metadata must report private visibility before gateway
dispatch, preparation and artifact upload. All workflow jobs reject public
execution, including internal experiments. Authorized execution-repository
readers can see all pilot findings and shadows, so their access must match that
data. Source-derived sanitized evidence still requires private storage.

Canonical state lives in the execution repository. Artifact names include a
target-repository digest and PR; trusted workflow provenance is checked against
the central default branch and run engine SHA. Target identity and state
repository are separate. Comments are presentation only. Compatible historical
blockers, same-head reuse and both stale-head barriers remain mandatory.

## Credentials and runtime

Gateway: separate target and central-dispatch App keys, webhook secret, scoped target read and central dispatch
tokens. Preparation: scoped target read token, central state read token and
optional Linear credentials. Model worker: isolated read-only review root and
provider key; no App key, write token or Linear secret. Publisher: canonical
sanitized state and scoped target publishing token only. Credentials are minted
in separate jobs/processes and are never included in transfer artifacts.
Target source is always inert; it is never installed, built or executed.

App permissions: metadata read (implicit), contents read, pull requests write
(includes read/comment publication), issues read (issue-comment subscription),
checks write, commit statuses read and Actions read for CI evidence. Both Apps
are private. A separate dispatcher App has metadata/contents read and Actions
write, resolving the trusted engine SHA before claims. It
is installed only on the execution repository. Its credentials never enter
central review jobs. Operator recovery uses metadata/Actions read only. Every token is narrowed to one
repository and an explicit phase-specific permission subset. No user IDs or
installation IDs are embedded in code. Manifest endpoints are operator supplied.

## Graph evidence and experiments

Pin `@colbymchenry/codegraph` to 1.6.1. Run its static preprocessing over only
the exact HEAD `target/**` snapshot in a credential-free, network-disabled,
bounded Linux container. Ignore target CodeGraph config/index files by building
in a fresh workspace. Telemetry/update checks are disabled. Enforce wall time,
memory, process and output limits; validate paths and reconstruct bounded JSON
and Markdown instead of trusting generated prose. Preserve ordinary review on
graph failure and record a fixed failure code.

Graph evidence includes changed symbols, callers/callees, transitive impact,
affected files/tests and unresolved boundaries where available. It is structural
evidence, not an oracle; it cannot mechanically cause BLOCK. No reviewer MCP.
Experiments run both arms at the same exact request identity, persist sanitized
telemetry separately, and preserve the production verdict: both comparison arms
are fresh private shadows, even when completed production state exists. Ordinary
canonical requests select one production variant. Graph status,
model panel, finding/blocker counts, tokens (null when unavailable) and latency
are recorded. More findings alone do not establish usefulness; evaluate against
human findings and material regressions.

## Rollout evidence

Deterministic fake-GitHub E2E demonstrates command, central review, BLOCK,
publication, correction, blocker closure and PASS. Production registration,
installation, DNS/HTTPS, deployment and secret provisioning require the account
owner. V1 stays in place until a real installed-App lifecycle is verified.
