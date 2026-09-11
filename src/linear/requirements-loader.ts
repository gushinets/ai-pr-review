import { LinearClient } from "@linear/sdk";
import { setTimeout } from "node:timers/promises";
import { CENTRAL_CONFIG } from "../config/central-config.js";
import { exchangeLinearAccessToken, type LinearOAuthCredentials } from "./oauth.js";

export interface LinearRequirementsContextV1 {
  schema_version: 1;
  identifier: string;
  title: string;
  description: string;
  comments: Array<{ created_at: string; body: string }>;
}

interface LinearCommentLike {
  id: string;
  createdAt: Date | string;
  body: string;
}

interface LinearCommentConnectionLike {
  nodes: LinearCommentLike[];
  pageInfo: { hasNextPage: boolean; endCursor?: string | null };
}

interface LinearIssueLike {
  identifier: string;
  title: string;
  description?: string | null;
  comments(variables: { after?: string }): Promise<LinearCommentConnectionLike>;
}

export interface LinearClientLike {
  issue(identifier: string): Promise<LinearIssueLike>;
}

export class LinearRequirementsError extends Error {
  constructor(
    public readonly reason:
      "LINEAR_AUTH_FAILED" | "LINEAR_NOT_FOUND" | "LINEAR_UNAVAILABLE" | "LINEAR_CONTEXT_TOO_LARGE",
    message: string,
  ) {
    super(message);
    this.name = "LinearRequirementsError";
  }
}

interface LoaderDependencies {
  exchangeToken?: (credentials: LinearOAuthCredentials) => Promise<string>;
  createClient?: (accessToken: string) => LinearClientLike;
  sleep?: (ms: number) => Promise<unknown>;
}

function normalize(value: string): string {
  return value.replace(/\r\n?/g, "\n").replaceAll("\0", "�");
}

function status(error: unknown): number | undefined {
  return typeof error === "object" && error !== null && "status" in error
    ? typeof error.status === "number"
      ? error.status
      : undefined
    : undefined;
}

function errorType(error: unknown): unknown {
  return typeof error === "object" && error !== null && "type" in error ? error.type : undefined;
}

function isTransient(error: unknown): boolean {
  const errorStatus = status(error);
  const type = errorType(error);
  return (
    error instanceof TypeError ||
    errorStatus === 429 ||
    (errorStatus !== undefined && errorStatus >= 500 && errorStatus <= 599) ||
    type === "Ratelimited" ||
    type === "NetworkError" ||
    type === "InternalError"
  );
}

function mapError(error: unknown): LinearRequirementsError {
  const errorStatus = status(error);
  const type = errorType(error);
  if (errorStatus === 404 || type === "EntityNotFound")
    return new LinearRequirementsError("LINEAR_NOT_FOUND", "Linear issue was not found");
  if (
    errorStatus === 401 ||
    errorStatus === 403 ||
    type === "AuthenticationError" ||
    type === "Forbidden"
  )
    return new LinearRequirementsError("LINEAR_AUTH_FAILED", "Linear authentication failed");
  return new LinearRequirementsError("LINEAR_UNAVAILABLE", "Linear is unavailable");
}

function ensureSize(context: LinearRequirementsContextV1): void {
  if (Buffer.byteLength(JSON.stringify(context), "utf8") > CENTRAL_CONFIG.maxLinearBytes)
    throw new LinearRequirementsError(
      "LINEAR_CONTEXT_TOO_LARGE",
      "Linear requirements context exceeds the configured limit",
    );
}

export class LinearRequirementsLoader {
  private readonly exchangeToken: (credentials: LinearOAuthCredentials) => Promise<string>;
  private readonly createClient: (accessToken: string) => LinearClientLike;
  private readonly sleep: (ms: number) => Promise<unknown>;

  constructor(dependencies: LoaderDependencies = {}) {
    this.exchangeToken = dependencies.exchangeToken ?? exchangeLinearAccessToken;
    this.createClient =
      dependencies.createClient ?? ((accessToken) => new LinearClient({ accessToken }));
    this.sleep = dependencies.sleep ?? setTimeout;
  }

  private async read<T>(operation: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await operation();
      } catch (error) {
        if (attempt >= 2 || !isTransient(error)) throw mapError(error);
        await this.sleep([250, 1_000][attempt]!);
      }
    }
  }

  async load(
    identifier: string,
    credentials: LinearOAuthCredentials,
  ): Promise<LinearRequirementsContextV1> {
    const accessToken = await this.exchangeToken(credentials);
    const client = this.createClient(accessToken);
    const issue = await this.read(() => client.issue(identifier));
    if (issue.identifier !== identifier)
      throw new LinearRequirementsError(
        "LINEAR_NOT_FOUND",
        "Linear issue identifier did not match",
      );

    const comments: Array<LinearRequirementsContextV1["comments"][number] & { id: string }> = [];
    const context: LinearRequirementsContextV1 = {
      schema_version: 1,
      identifier,
      title: normalize(issue.title),
      description: normalize(issue.description ?? ""),
      comments: [],
    };
    ensureSize(context);

    let after: string | undefined;
    for (;;) {
      const page = await this.read(() => issue.comments(after === undefined ? {} : { after }));
      for (const comment of page.nodes) {
        comments.push({
          id: comment.id,
          created_at: new Date(comment.createdAt).toISOString(),
          body: normalize(comment.body),
        });
        context.comments = comments.map(({ created_at, body }) => ({ created_at, body }));
        ensureSize(context);
      }
      if (!page.pageInfo.hasNextPage) break;
      const cursor = page.pageInfo.endCursor ?? undefined;
      if (cursor === undefined || cursor === after)
        throw new LinearRequirementsError(
          "LINEAR_UNAVAILABLE",
          "Linear pagination did not advance",
        );
      after = cursor;
    }

    comments.sort(
      (left, right) =>
        left.created_at.localeCompare(right.created_at) || left.id.localeCompare(right.id),
    );
    context.comments = comments.map(({ created_at, body }) => ({ created_at, body }));
    ensureSize(context);
    return context;
  }
}
