import { generateKeyPairSync, verify } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createAppJwt,
  mintInstallationToken,
  createAppGitHubGateway,
  getAppIdentity,
} from "../../src/app/github-app.js";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const credentials = {
  appId: "123",
  privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
};
const dispatchKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const dispatchCredentials = {
  appId: "456",
  privateKey: dispatchKeys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
};
const now = Date.parse("2026-10-02T10:00:00Z");
const permissions = {
  metadata: "read",
  contents: "read",
  pull_requests: "write",
  issues: "read",
  checks: "write",
  statuses: "read",
  actions: "read",
};
const readPermissions = {
  metadata: "read",
  contents: "read",
  pull_requests: "read",
  checks: "read",
  statuses: "read",
  actions: "read",
};
const central = {
  repository: "engine/central",
  workflow: "ai-review-v2.yml",
  ref: "main",
  credentials: dispatchCredentials,
};
const request = {
  schema_version: 2,
  repository: "owner/repo",
  prNumber: 5,
  baseSha: "a".repeat(40),
  headSha: "b".repeat(40),
  baseBranch: "main",
  trigger: {
    kind: "app",
    actor: "writer",
    installationId: 17,
    commentId: 71,
    deliveryId: "delivery-1",
  },
  requirementsSource: { kind: "none" },
  graphMode: "off",
  execution: "canonical",
} as const;
afterEach(() => vi.restoreAllMocks());
function fixture() {
  const calls: {
    path: string;
    method: string;
    auth: string;
    body: Record<string, unknown> | undefined;
  }[] = [];
  const f = {
    installation: {
      id: 17,
      app_id: 123,
      permissions: { ...permissions },
      suspended_at: null as string | null,
    },
    centralInstallation: {
      id: 29,
      app_id: 456,
      permissions: { metadata: "read", actions: "write" },
      suspended_at: null as string | null,
    },
    permission: "write",
    pr: {
      number: 5,
      state: "open",
      base: { repo: { full_name: "owner/repo" }, sha: "a".repeat(40), ref: "main" },
      head: { sha: "b".repeat(40) },
    },
    returnedPermissions: undefined as Record<string, string> | undefined,
    scope: { total_count: 1, repositories: [{ id: 99, full_name: "owner/repo" }] },
    errorPath: "",
    token: "ghs_APPID_JWT-long-new-format",
    publishToken: "ghs_TARGET-publish-token",
    dispatchToken: "ghs_DISPATCH-central-token",
    centralScope: { total_count: 1, repositories: [{ id: 100, full_name: "engine/central" }] },
    expiresAt: new Date(now + 3_600_000).toISOString(),
    calls,
    options: { now: () => now, fetch: undefined as unknown as typeof globalThis.fetch },
  };
  f.options.fetch = async (input, init) => {
    const url = new URL(String(input));
    const body =
      typeof init?.body === "string"
        ? (JSON.parse(init.body) as Record<string, unknown>)
        : undefined;
    const auth = new Headers(init?.headers).get("authorization") ?? "";
    calls.push({ path: url.pathname, method: init?.method ?? "GET", auth, body });
    if (url.pathname === f.errorPath)
      return new Response(JSON.stringify({ message: "private-secret" }), {
        status: 403,
        headers: { "content-type": "application/json" },
      });
    let data: unknown;
    if (url.pathname === "/app") data = { id: 123, slug: "ai-review-example" };
    else if (url.pathname.endsWith("/installation"))
      data = url.pathname.includes("engine/central") ? f.centralInstallation : f.installation;
    else if (url.pathname.endsWith("/access_tokens"))
      data = {
        token: url.pathname.includes("/29/")
          ? f.dispatchToken
          : (body?.permissions as Record<string, string>)?.checks === "write"
            ? f.publishToken
            : f.token,
        expires_at: f.expiresAt,
        permissions: f.returnedPermissions ?? body?.permissions,
      };
    else if (url.pathname === "/installation/repositories")
      data = auth === `token ${f.dispatchToken}` ? f.centralScope : f.scope;
    else if (url.pathname.endsWith("/pulls/5")) data = f.pr;
    else if (url.pathname.endsWith("/collaborators/writer/permission"))
      data = { permission: f.permission };
    else if (url.pathname.endsWith("/dispatches")) return new Response(null, { status: 204 });
    else throw new Error(`Unexpected endpoint ${url.pathname}`);
    return new Response(JSON.stringify(data), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return f;
}

describe("App JWT and scoped installation credentials", () => {
  it("resolves internal requests through the authenticated repository installation", async () => {
    const f = fixture();
    expect(
      await mintInstallationToken(credentials, undefined, "owner/repo", "read", f.options),
    ).toBe(f.token);
    expect(f.calls.map((call) => call.path)).toEqual([
      "/repos/owner/repo/installation",
      "/app/installations/17/access_tokens",
      "/installation/repositories",
    ]);
    expect(f.calls[1]?.body).toEqual({ repositories: ["repo"], permissions: readPermissions });
  });
  it("aborts an unresponsive GitHub fetch with the configured request deadline", async () => {
    vi.spyOn(AbortSignal, "timeout").mockImplementation((milliseconds) => {
      expect(milliseconds).toBe(15_000);
      return AbortSignal.abort(new Error("deadline reached"));
    });
    const fetch: typeof globalThis.fetch = async (_input, init) => {
      if (init?.signal?.aborted) throw init.signal.reason;
      return new Response(JSON.stringify({ id: 123, slug: "ai-review-example" }), {
        headers: { "content-type": "application/json" },
      });
    };
    await expect(getAppIdentity(credentials, { now: () => now, fetch })).rejects.toThrow(
      "APP_IDENTITY_REJECTED",
    );
  });
  it("resolves trusted App slug and bot login for publication ownership", async () => {
    const f = fixture();
    expect(await getAppIdentity(credentials, f.options)).toEqual({
      id: 123,
      slug: "ai-review-example",
      botLogin: "ai-review-example[bot]",
    });
  });
  it("signs a bounded RS256 JWT with clock skew allowance", () => {
    const jwt = createAppJwt(credentials, now);
    const [header, payload, signature] = jwt.split(".");
    expect(JSON.parse(Buffer.from(header!, "base64url").toString())).toEqual({
      alg: "RS256",
      typ: "JWT",
    });
    expect(JSON.parse(Buffer.from(payload!, "base64url").toString())).toEqual({
      iat: 1790935140,
      exp: 1790935740,
      iss: "123",
    });
    expect(
      verify(
        "RSA-SHA256",
        Buffer.from(`${header}.${payload}`),
        publicKey,
        Buffer.from(signature!, "base64url"),
      ),
    ).toBe(true);
  });
  it.each(["", "0", "17\n", "bad"])("rejects invalid App ID %j", (appId) => {
    expect(() => createAppJwt({ ...credentials, appId }, now)).toThrow("APP_CREDENTIALS_INVALID");
  });
  it.each([
    ["read", readPermissions],
    ["publish", { metadata: "read", pull_requests: "write", checks: "write" }],
  ] as const)(
    "mints only one repository and explicit %s rights",
    async (phase, expectedPermissions) => {
      const f = fixture();
      const token = phase === "publish" ? f.publishToken : f.token;
      expect(await mintInstallationToken(credentials, 17, "owner/repo", phase, f.options)).toBe(
        token,
      );
      expect(f.calls.map(({ path, method }) => [method, path])).toEqual([
        ["GET", "/repos/owner/repo/installation"],
        ["POST", "/app/installations/17/access_tokens"],
        ["GET", "/installation/repositories"],
      ]);
      expect(f.calls[1]?.body).toEqual({
        repositories: ["repo"],
        permissions: expectedPermissions,
      });
      expect(f.calls[0]?.auth).toMatch(/^bearer ey/);
      expect(f.calls[2]?.auth).toBe(`token ${token}`);
    },
  );
  it.each(["contents", "pull_requests", "checks", "statuses", "actions", "metadata"])(
    "rejects missing read permission %s before minting",
    async (permission) => {
      const f = fixture();
      delete (f.installation.permissions as Record<string, string>)[permission];
      await expect(
        mintInstallationToken(credentials, 17, "owner/repo", "read", f.options),
      ).rejects.toThrow("INSTALLATION_PERMISSIONS_INSUFFICIENT");
      expect(f.calls).toHaveLength(1);
    },
  );
  it("narrows the central dispatcher to Actions read for operator reconciliation", async () => {
    const f = fixture();
    expect(
      await mintInstallationToken(dispatchCredentials, 29, "engine/central", "inspect", f.options),
    ).toBe(f.dispatchToken);
    expect(f.calls[1]?.body).toEqual({
      repositories: ["central"],
      permissions: { metadata: "read", actions: "read" },
    });
    expect(f.calls[2]?.auth).toBe(`token ${f.dispatchToken}`);
  });
  it("rejects wrong installation, wrong App identity and suspended installs before minting", async () => {
    for (const installation of [{ id: 18 }, { app_id: 124 }, { suspended_at: "2026-10-01" }]) {
      const f = fixture();
      Object.assign(f.installation, installation);
      await expect(
        mintInstallationToken(credentials, 17, "owner/repo", "read", f.options),
      ).rejects.toThrow("INSTALLATION_REJECTED");
      expect(f.calls).toHaveLength(1);
    }
  });
  it("rejects broadened or insufficient minted permissions and expired tokens", async () => {
    for (const returnedPermissions of [
      { ...readPermissions, actions: "write" },
      { metadata: "read" },
    ]) {
      const f = fixture();
      f.returnedPermissions = returnedPermissions;
      await expect(
        mintInstallationToken(credentials, 17, "owner/repo", "read", f.options),
      ).rejects.toThrow("TOKEN_SCOPE_REJECTED");
    }
    const f = fixture();
    f.expiresAt = new Date(now - 1).toISOString();
    await expect(
      mintInstallationToken(credentials, 17, "owner/repo", "read", f.options),
    ).rejects.toThrow("TOKEN_SCOPE_REJECTED");
  });
  it("verifies minted token repository identity and rejects additional repositories", async () => {
    for (const scope of [
      { total_count: 1, repositories: [{ id: 99, full_name: "other/repo" }] },
      { total_count: 2, repositories: [{ id: 99, full_name: "owner/repo" }] },
      { total_count: 1, repositories: [{ id: 0, full_name: "owner/repo" }] },
    ]) {
      const f = fixture();
      f.scope = scope;
      await expect(
        mintInstallationToken(credentials, 17, "owner/repo", "read", f.options),
      ).rejects.toThrow("TOKEN_SCOPE_REJECTED");
    }
  });
  it("replaces GitHub/key errors with fixed diagnostics", async () => {
    const f = fixture();
    f.errorPath = "/repos/owner/repo/installation";
    await expect(
      mintInstallationToken(credentials, 17, "owner/repo", "read", f.options),
    ).rejects.toThrow("INSTALLATION_REJECTED");
    expect(() => createAppJwt({ ...credentials, privateKey: "PRIVATE-KEY-MATERIAL" }, now)).toThrow(
      "APP_CREDENTIALS_INVALID",
    );
  });
});

describe("trusted GitHub App gateway adapter", () => {
  it("requires a separate dispatcher identity without leaking credentials", () => {
    for (const changed of [
      { ...central, credentials: undefined },
      { ...central, credentials: { ...dispatchCredentials, appId: "" } },
      { ...central, credentials: { ...dispatchCredentials, privateKey: "" } },
      { ...central, credentials },
    ]) {
      let diagnostic = "";
      try {
        createAppGitHubGateway(credentials, changed as never);
      } catch (error) {
        diagnostic = (error as Error).message;
      }
      expect(diagnostic).toBe("CENTRAL_DISPATCH_CONFIG_INVALID");
    }
  });
  it.each(["write", "maintain", "admin"])(
    "allows %s commenter and captures live PR",
    async (permission) => {
      const f = fixture();
      f.permission = permission;
      const gateway = createAppGitHubGateway(credentials, central, f.options);
      expect(await gateway.resolveTarget("owner/repo", 17, 5, "writer")).toEqual({
        repository: "owner/repo",
        number: 5,
        state: "open",
        baseSha: "a".repeat(40),
        headSha: "b".repeat(40),
        baseBranch: "main",
      });
      expect(f.calls.every(({ path }) => !path.includes("dispatch"))).toBe(true);
      expect(f.calls.filter(({ method }) => method === "POST")[0]?.body?.permissions).toEqual(
        readPermissions,
      );
    },
  );
  it.each(["read", "triage", "none", "custom"])("rejects %s commenter", async (permission) => {
    const f = fixture();
    f.permission = permission;
    await expect(
      createAppGitHubGateway(credentials, central, f.options).resolveTarget(
        "owner/repo",
        17,
        5,
        "writer",
      ),
    ).rejects.toThrow("ACTOR_UNAUTHORIZED");
    expect(f.calls.every(({ path }) => !path.includes("dispatch"))).toBe(true);
  });
  it.each(["pull_requests", "checks"])(
    "requires target publish rights for %s before budget dispatch",
    async (permission) => {
      const f = fixture();
      (f.installation.permissions as Record<string, string>)[permission] = "read";
      await expect(
        createAppGitHubGateway(credentials, central, f.options).resolveTarget(
          "owner/repo",
          17,
          5,
          "writer",
        ),
      ).rejects.toThrow("INSTALLATION_PERMISSIONS_INSUFFICIENT");
      expect(f.calls).toHaveLength(1);
    },
  );
  it("rejects absent installation and deleted PR without dispatch", async () => {
    for (const errorPath of ["/repos/owner/repo/installation", "/repos/owner/repo/pulls/5"]) {
      const f = fixture();
      f.errorPath = errorPath;
      await expect(
        createAppGitHubGateway(credentials, central, f.options).resolveTarget(
          "owner/repo",
          17,
          5,
          "writer",
        ),
      ).rejects.toThrow();
      expect(f.calls.every(({ path }) => !path.includes("dispatch"))).toBe(true);
    }
  });
  it("uses only dispatcher JWTs and central-scoped Actions write for dispatch", async () => {
    const f = fixture();
    await createAppGitHubGateway(credentials, central, f.options).dispatch(request);
    expect(f.calls.map(({ path }) => path)).toEqual([
      "/repos/engine/central/installation",
      "/app/installations/29/access_tokens",
      "/installation/repositories",
      "/repos/engine/central/actions/workflows/ai-review-v2.yml/dispatches",
    ]);
    expect(f.calls[1]?.body).toEqual({
      repositories: ["central"],
      permissions: { metadata: "read", actions: "write" },
    });
    expect(f.calls[3]?.body).toEqual({ ref: "main", inputs: { request: JSON.stringify(request) } });
    expect(f.calls[2]?.auth).toBe(`token ${f.dispatchToken}`);
    expect(f.calls[3]?.auth).toBe(`token ${f.dispatchToken}`);
    for (const call of f.calls.slice(0, 2)) {
      const [header, payload, signature] = call.auth.replace(/^bearer /, "").split(".");
      expect(JSON.parse(Buffer.from(payload!, "base64url").toString()).iss).toBe("456");
      expect(
        verify(
          "RSA-SHA256",
          Buffer.from(`${header}.${payload}`),
          dispatchKeys.publicKey,
          Buffer.from(signature!, "base64url"),
        ),
      ).toBe(true);
    }
  });
  it("keeps target read and publisher tokens separate from dispatcher credentials", async () => {
    const f = fixture();
    const gateway = createAppGitHubGateway(credentials, central, f.options);
    await gateway.resolveTarget("owner/repo", 17, 5, "writer");
    expect(await mintInstallationToken(credentials, 17, "owner/repo", "publish", f.options)).toBe(
      f.publishToken,
    );
    const targetCalls = [...f.calls];
    await gateway.dispatch(request);
    for (const call of targetCalls.filter(({ auth }) => auth.startsWith("bearer "))) {
      const [header, payload, signature] = call.auth.slice("bearer ".length).split(".");
      expect(JSON.parse(Buffer.from(payload!, "base64url").toString()).iss).toBe("123");
      expect(
        verify(
          "RSA-SHA256",
          Buffer.from(`${header}.${payload}`),
          publicKey,
          Buffer.from(signature!, "base64url"),
        ),
      ).toBe(true);
    }
    for (const call of targetCalls.filter(({ path }) => path.endsWith("/access_tokens"))) {
      expect(call.body?.repositories).toEqual(["repo"]);
      expect((call.body!.permissions as Record<string, string>).actions).not.toBe("write");
    }
    expect(targetCalls.some(({ auth }) => auth === `token ${f.token}`)).toBe(true);
    expect(targetCalls.some(({ auth }) => auth === `token ${f.publishToken}`)).toBe(true);
    expect(targetCalls.some(({ auth }) => auth === `token ${f.dispatchToken}`)).toBe(false);
  });
  it("does not dispatch when central installation cannot grant Actions write", async () => {
    const f = fixture();
    f.centralInstallation.permissions.actions = "read";
    await expect(
      createAppGitHubGateway(credentials, central, f.options).dispatch(request),
    ).rejects.toThrow("INSTALLATION_PERMISSIONS_INSUFFICIENT");
    expect(f.calls).toHaveLength(1);
  });
  it("rejects dispatcher installation ownership, suspension, expiry and broadened scope", async () => {
    for (const change of [
      (f: ReturnType<typeof fixture>) => {
        f.centralInstallation.app_id = 123;
      },
      (f: ReturnType<typeof fixture>) => {
        f.centralInstallation.suspended_at = "2026-10-01";
      },
      (f: ReturnType<typeof fixture>) => {
        f.expiresAt = new Date(now - 1).toISOString();
      },
      (f: ReturnType<typeof fixture>) => {
        f.returnedPermissions = { metadata: "read", actions: "write", contents: "read" };
      },
      (f: ReturnType<typeof fixture>) => {
        f.centralScope = {
          total_count: 2,
          repositories: [
            { id: 100, full_name: "engine/central" },
            { id: 99, full_name: "owner/repo" },
          ],
        };
      },
    ]) {
      const f = fixture();
      change(f);
      await expect(
        createAppGitHubGateway(credentials, central, f.options).dispatch(request),
      ).rejects.toThrow();
      expect(f.calls.some(({ path }) => path.endsWith("/dispatches"))).toBe(false);
    }
  });
  it("does not retry an ambiguous workflow dispatch failure", async () => {
    const f = fixture();
    f.errorPath = "/repos/engine/central/actions/workflows/ai-review-v2.yml/dispatches";
    await expect(
      createAppGitHubGateway(credentials, central, f.options).dispatch(request),
    ).rejects.toThrow("DISPATCH_FAILED");
    expect(f.calls.filter(({ path }) => path.endsWith("/dispatches"))).toHaveLength(1);
  });
});
