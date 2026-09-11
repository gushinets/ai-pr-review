import { setTimeout } from "node:timers/promises";

export interface LinearOAuthCredentials {
  clientId: string;
  clientSecret: string;
}

export class LinearOAuthError extends Error {
  constructor(
    public readonly reason: "LINEAR_AUTH_FAILED" | "LINEAR_UNAVAILABLE",
    message: string,
  ) {
    super(message);
    this.name = "LinearOAuthError";
  }
}

interface OAuthDependencies {
  fetch?: typeof globalThis.fetch;
  sleep?: (ms: number) => Promise<unknown>;
}

function transientStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

export async function exchangeLinearAccessToken(
  credentials: LinearOAuthCredentials,
  dependencies: OAuthDependencies = {},
): Promise<string> {
  const fetch = dependencies.fetch ?? globalThis.fetch;
  const sleep = dependencies.sleep ?? setTimeout;
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    scope: "read",
    client_id: credentials.clientId,
    client_secret: credentials.clientSecret,
  });

  for (let attempt = 0; attempt < 3; attempt++) {
    let response: Response;
    try {
      response = await fetch("https://api.linear.app/oauth/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
      });
    } catch (error) {
      if (attempt < 2 && error instanceof TypeError) {
        await sleep([250, 1_000][attempt]!);
        continue;
      }
      throw new LinearOAuthError("LINEAR_UNAVAILABLE", "Linear OAuth is unavailable");
    }

    if (response.status === 401 || response.status === 403)
      throw new LinearOAuthError("LINEAR_AUTH_FAILED", "Linear OAuth authentication failed");
    if (!response.ok) {
      if (attempt < 2 && transientStatus(response.status)) {
        await sleep([250, 1_000][attempt]!);
        continue;
      }
      throw new LinearOAuthError("LINEAR_UNAVAILABLE", "Linear OAuth is unavailable");
    }

    try {
      const value: unknown = await response.json();
      if (
        typeof value === "object" &&
        value !== null &&
        "access_token" in value &&
        typeof value.access_token === "string" &&
        value.access_token.length > 0
      )
        return value.access_token;
    } catch {
      // The response is intentionally not included in the public error.
    }
    throw new LinearOAuthError("LINEAR_UNAVAILABLE", "Linear OAuth returned an invalid response");
  }

  throw new LinearOAuthError("LINEAR_UNAVAILABLE", "Linear OAuth is unavailable");
}
