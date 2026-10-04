import { sign } from "node:crypto";
import { Octokit } from "@octokit/rest";
import type { AppGitHubGateway } from "./gateway.js";
import { requirePrivateExecutionRepository } from "./execution-repository.js";
export interface AppCredentials {
  appId: string;
  privateKey: string;
}
export interface CentralDispatchConfig {
  repository: string;
  workflow: string;
  ref: string;
  credentials: AppCredentials;
}
export interface AppClientOptions {
  fetch?: typeof globalThis.fetch;
  now?: () => number;
}
export async function getAppIdentity(
  credentials: AppCredentials,
  options: AppClientOptions = {},
): Promise<{ id: number; slug: string; botLogin: string }> {
  try {
    const { data } = await client(
      createAppJwt(credentials, (options.now ?? Date.now)()),
      options,
    ).rest.apps.getAuthenticated();
    if (
      !data ||
      data.id !== Number(credentials.appId) ||
      !data.slug ||
      !/^[A-Za-z0-9_-]+$/.test(data.slug)
    )
      throw new Error();
    return { id: data.id, slug: data.slug, botLogin: `${data.slug}[bot]` };
  } catch {
    throw new Error("APP_IDENTITY_REJECTED");
  }
}
type Phase = "read" | "publish" | "dispatch" | "inspect";
type Permissions = Record<string, "read" | "write">;
const phasePermissions: Record<Phase, Permissions> = {
  read: {
    metadata: "read",
    contents: "read",
    pull_requests: "read",
    checks: "read",
    statuses: "read",
    actions: "read",
  },
  publish: { metadata: "read", pull_requests: "write", checks: "write" },
  dispatch: { metadata: "read", contents: "read", actions: "write" },
  inspect: { metadata: "read", actions: "read" },
};

export function createAppJwt(credentials: AppCredentials, now = Date.now()): string {
  try {
    if (
      !/^[1-9][0-9]*$/.test(credentials.appId) ||
      !Number.isSafeInteger(Number(credentials.appId)) ||
      !Number.isFinite(now)
    )
      throw new Error();
    const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const seconds = Math.floor(now / 1000);
    const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iat: seconds - 60, exp: seconds + 540, iss: credentials.appId })}`;
    return `${unsigned}.${sign("RSA-SHA256", Buffer.from(unsigned), credentials.privateKey).toString("base64url")}`;
  } catch {
    throw new Error("APP_CREDENTIALS_INVALID");
  }
}
function client(auth: string, options: AppClientOptions): Octokit {
  return new Octokit({
    auth,
    request: {
      fetch: (input: RequestInfo | URL, init?: RequestInit) =>
        (options.fetch ?? globalThis.fetch)(input, {
          ...init,
          signal: init?.signal
            ? AbortSignal.any([init.signal, AbortSignal.timeout(15_000)])
            : AbortSignal.timeout(15_000),
        }),
    },
    // Octokit errors may carry credentials/request data; callers expose fixed codes only.
    log: { debug() {}, info() {}, warn() {}, error() {} },
  });
}
function repoParams(repository: string): { owner: string; repo: string } {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || repository.length > 256)
    throw new Error("REPOSITORY_INVALID");
  const [owner, repo] = repository.split("/");
  return { owner: owner!, repo: repo! };
}
function requirePermissions(granted: Record<string, unknown>, required: Permissions): void {
  if (
    Object.entries(required).some(
      ([key, value]) => granted[key] !== value && !(value === "read" && granted[key] === "write"),
    )
  )
    throw new Error("INSTALLATION_PERMISSIONS_INSUFFICIENT");
}
async function installation(
  credentials: AppCredentials,
  repository: string,
  options: AppClientOptions,
  expectedId?: number,
) {
  const params = repoParams(repository);
  const app = client(createAppJwt(credentials, (options.now ?? Date.now)()), options);
  let data;
  try {
    ({ data } = await app.rest.apps.getRepoInstallation(params));
  } catch {
    throw new Error("INSTALLATION_REJECTED");
  }
  if (
    !Number.isSafeInteger(data.id) ||
    data.id <= 0 ||
    (expectedId !== undefined && data.id !== expectedId) ||
    data.app_id !== Number(credentials.appId) ||
    data.suspended_at !== null
  )
    throw new Error("INSTALLATION_REJECTED");
  return { app, data, params };
}
async function mint(
  verified: Awaited<ReturnType<typeof installation>>,
  repository: string,
  phase: Phase,
  options: AppClientOptions,
): Promise<string> {
  const permissions = phasePermissions[phase];
  if (!permissions) throw new Error("TOKEN_PHASE_INVALID");
  requirePermissions(verified.data.permissions ?? {}, permissions);
  let data;
  try {
    ({ data } = await verified.app.rest.apps.createInstallationAccessToken({
      installation_id: verified.data.id,
      repositories: [verified.params.repo],
      permissions,
    }));
  } catch {
    throw new Error("TOKEN_MINT_FAILED");
  }
  if (
    typeof data.token !== "string" ||
    data.token.length === 0 ||
    !Number.isFinite(Date.parse(data.expires_at)) ||
    Date.parse(data.expires_at) <= (options.now ?? Date.now)() ||
    !data.permissions ||
    Object.entries(permissions).some(
      ([key, value]) => (data.permissions as Record<string, unknown>)[key] !== value,
    ) ||
    Object.entries(data.permissions).some(([key, value]) => permissions[key] !== value)
  )
    throw new Error("TOKEN_SCOPE_REJECTED");
  // The token response's repositories field is optional. This authenticated GET
  // verifies both effective repository scope and the actual GitHub repository ID.
  let scope;
  try {
    ({ data: scope } = await client(
      data.token,
      options,
    ).rest.apps.listReposAccessibleToInstallation({ per_page: 100 }));
  } catch {
    throw new Error("TOKEN_SCOPE_REJECTED");
  }
  const selected = scope.repositories[0];
  if (
    scope.total_count !== 1 ||
    scope.repositories.length !== 1 ||
    !selected ||
    !Number.isSafeInteger(selected.id) ||
    selected.id <= 0 ||
    selected.full_name.toLowerCase() !== repository.toLowerCase()
  )
    throw new Error("TOKEN_SCOPE_REJECTED");
  if (
    data.repositories &&
    (data.repositories.length !== 1 ||
      data.repositories[0]?.id !== selected.id ||
      data.repositories[0]?.full_name.toLowerCase() !== repository.toLowerCase())
  )
    throw new Error("TOKEN_SCOPE_REJECTED");
  return data.token;
}

/** App JWT lookup, one repository, explicit phase rights, verified effective scope. */
export async function mintInstallationToken(
  credentials: AppCredentials,
  installationId: number | undefined,
  repository: string,
  phase: Phase,
  options: AppClientOptions = {},
): Promise<string> {
  if (
    installationId !== undefined &&
    (!Number.isSafeInteger(installationId) || installationId <= 0)
  )
    throw new Error("INSTALLATION_REJECTED");
  return mint(
    await installation(credentials, repository, options, installationId),
    repository,
    phase,
    options,
  );
}
export function createAppGitHubGateway(
  credentials: AppCredentials,
  central: CentralDispatchConfig,
  options: AppClientOptions = {},
): AppGitHubGateway {
  const centralParams = repoParams(central.repository);
  if (
    !central.credentials?.appId ||
    !central.credentials.privateKey ||
    Number(central.credentials.appId) === Number(credentials.appId) ||
    !/^[A-Za-z0-9_.-]+\.ya?ml$/.test(central.workflow) ||
    !central.ref ||
    central.ref.length > 255 ||
    Array.from(central.ref).some(
      (character) => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127,
    )
  )
    throw new Error("CENTRAL_DISPATCH_CONFIG_INVALID");
  async function centralClient(): Promise<Octokit> {
    const verified = await installation(central.credentials, central.repository, options);
    const token = await mint(verified, central.repository, "dispatch", options);
    const github = client(token, options);
    try {
      const repository = await requirePrivateExecutionRepository(github, central.repository);
      if (
        !Number.isSafeInteger(repository.id) ||
        repository.id <= 0 ||
        repository.default_branch !== central.ref
      )
        throw new Error();
    } catch {
      throw new Error("CENTRAL_REPOSITORY_REJECTED");
    }
    return github;
  }
  return {
    async resolveEngine() {
      const github = await centralClient();
      try {
        const { data } = await github.rest.repos.getCommit({ ...centralParams, ref: central.ref });
        if (!/^[0-9a-f]{40}$/.test(data.sha)) throw new Error();
        return data.sha;
      } catch {
        throw new Error("CENTRAL_ENGINE_REJECTED");
      }
    },
    async resolveTarget(repository, installationId, prNumber, actor) {
      const verified = await installation(credentials, repository, options, installationId);
      requirePermissions(verified.data.permissions ?? {}, {
        ...phasePermissions.read,
        ...phasePermissions.publish,
        issues: "read",
      });
      const token = await mint(verified, repository, "read", options);
      const target = client(token, options);
      let pr, permission;
      try {
        ({ data: pr } = await target.rest.pulls.get({ ...verified.params, pull_number: prNumber }));
        ({ data: permission } = await target.rest.repos.getCollaboratorPermissionLevel({
          ...verified.params,
          username: actor,
        }));
      } catch {
        throw new Error("TARGET_REJECTED");
      }
      if (!["write", "maintain", "admin"].includes(permission.permission))
        throw new Error("ACTOR_UNAUTHORIZED");
      return {
        repository: pr.base.repo.full_name,
        number: pr.number,
        state: pr.state,
        baseSha: pr.base.sha,
        headSha: pr.head.sha,
        baseBranch: pr.base.ref,
      };
    },
    async dispatch(request) {
      const github = await centralClient();
      try {
        await github.rest.actions.createWorkflowDispatch({
          ...centralParams,
          workflow_id: central.workflow,
          ref: central.ref,
          inputs: { request: JSON.stringify(request) },
        });
      } catch {
        throw new Error("DISPATCH_FAILED");
      }
    },
  };
}
