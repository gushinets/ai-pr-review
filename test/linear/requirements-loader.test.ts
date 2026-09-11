import { LinearClient } from "@linear/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LinearRequirementsLoader,
  type LinearClientLike,
} from "../../src/linear/requirements-loader.js";

const credentials = { clientId: "id", clientSecret: "secret" };

function fakeClient(
  issue: Partial<Awaited<ReturnType<LinearClientLike["issue"]>>> = {},
): LinearClientLike {
  return {
    issue: vi.fn(async () => ({
      identifier: "ANY-451",
      title: "Title",
      description: "Description",
      comments: vi.fn(async () => ({
        nodes: [],
        pageInfo: { hasNextPage: false, endCursor: null },
      })),
      ...issue,
    })),
  };
}

function loader(client: LinearClientLike, token = vi.fn(async () => "temporary-token")) {
  const createClient = vi.fn(() => client);
  return {
    loader: new LinearRequirementsLoader({ exchangeToken: token, createClient }),
    createClient,
  };
}

const nativeFetch = globalThis.fetch;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  expect(globalThis.fetch).toBe(nativeFetch);
});

describe("LinearRequirementsLoader", () => {
  it("loads normalized normative fields with zero comments using a fresh token", async () => {
    const token = vi.fn(async () => "temporary-token");
    const { loader: subject, createClient } = loader(
      fakeClient({ title: "A\r\nB\0", description: null }),
      token,
    );

    await expect(subject.load("ANY-451", credentials)).resolves.toEqual({
      schema_version: 1,
      identifier: "ANY-451",
      title: "A\nB�",
      description: "",
      comments: [],
    });
    expect(token).toHaveBeenCalledOnce();
    expect(createClient).toHaveBeenCalledWith("temporary-token");

    await subject.load("ANY-451", credentials);
    expect(token).toHaveBeenCalledTimes(2);
  });

  it("loads fresh comment pages, normalizes, and sorts by timestamp then id", async () => {
    const comments = vi
      .fn()
      .mockResolvedValueOnce({
        nodes: [
          { id: "b", createdAt: new Date("2026-01-02T00:00:00Z"), body: "second\r" },
          { id: "z", createdAt: new Date("2026-01-01T00:00:00Z"), body: "z" },
        ],
        pageInfo: { hasNextPage: true, endCursor: "cursor-1" },
      })
      .mockResolvedValueOnce({
        nodes: [{ id: "a", createdAt: new Date("2026-01-01T00:00:00Z"), body: "a\0" }],
        pageInfo: { hasNextPage: false, endCursor: "cursor-2" },
      });
    const { loader: subject } = loader(fakeClient({ comments }));

    const result = await subject.load("ANY-451", credentials);

    expect(comments).toHaveBeenNthCalledWith(1, {});
    expect(comments).toHaveBeenNthCalledWith(2, { after: "cursor-1" });
    expect(result.comments).toEqual([
      { created_at: "2026-01-01T00:00:00.000Z", body: "a�" },
      { created_at: "2026-01-01T00:00:00.000Z", body: "z" },
      { created_at: "2026-01-02T00:00:00.000Z", body: "second\n" },
    ]);
    expect(result.comments[0]).not.toHaveProperty("id");
  });

  it("maps a missing issue and rejects a mismatched returned identifier", async () => {
    const missing = loader({
      issue: vi.fn(async () => Promise.reject({ status: 404, type: "AuthenticationError" })),
    }).loader;
    await expect(missing.load("ANY-451", credentials)).rejects.toMatchObject({
      reason: "LINEAR_NOT_FOUND",
    });

    const mismatch = loader(fakeClient({ identifier: "ANY-452" })).loader;
    await expect(mismatch.load("ANY-451", credentials)).rejects.toMatchObject({
      reason: "LINEAR_NOT_FOUND",
    });
  });

  it("rejects oversized normalized context while paging without requesting another page", async () => {
    const comments = vi.fn(async () => ({
      nodes: [{ id: "large", createdAt: new Date(0), body: "💾".repeat(40_000) }],
      pageInfo: { hasNextPage: true, endCursor: "unused" },
    }));
    const { loader: subject } = loader(fakeClient({ comments }));

    await expect(subject.load("ANY-451", credentials)).rejects.toMatchObject({
      reason: "LINEAR_CONTEXT_TOO_LARGE",
    });
    expect(comments).toHaveBeenCalledOnce();
  });

  it("fails boundedly when pagination does not advance", async () => {
    const comments = vi.fn(async () => ({
      nodes: [],
      pageInfo: { hasNextPage: true, endCursor: null },
    }));
    const { loader: subject } = loader(fakeClient({ comments }));

    await expect(subject.load("ANY-451", credentials)).rejects.toMatchObject({
      reason: "LINEAR_UNAVAILABLE",
    });
    expect(comments).toHaveBeenCalledOnce();
  });

  it("retries transient SDK reads within the bound", async () => {
    const issue = vi
      .fn()
      .mockRejectedValueOnce({ status: 503 })
      .mockRejectedValueOnce({ status: 429 })
      .mockResolvedValueOnce(await fakeClient().issue("ANY-451"));
    const { loader: subject } = loader({ issue });

    await expect(subject.load("ANY-451", credentials)).resolves.toMatchObject({
      identifier: "ANY-451",
    });
    expect(issue).toHaveBeenCalledTimes(3);
  });

  it("retries the pinned SDK network error classification", async () => {
    const issue = vi
      .fn()
      .mockRejectedValueOnce({ type: "NetworkError" })
      .mockResolvedValueOnce(await fakeClient().issue("ANY-451"));
    const { loader: subject } = loader({ issue });

    await expect(subject.load("ANY-451", credentials)).resolves.toMatchObject({
      identifier: "ANY-451",
    });
    expect(issue).toHaveBeenCalledTimes(2);
  });

  it("uses the pinned Linear SDK with the temporary OAuth token", async () => {
    const requests: Array<{ authorization: string | null; body: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const request = new Request(input, init);
        const body = await request.text();
        requests.push({
          authorization: request.headers.get("authorization"),
          body,
        });
        const operation = JSON.parse(body) as { query: string };
        if (operation.query.includes("query issue_comments")) {
          return new Response(
            JSON.stringify({
              data: {
                issue: {
                  comments: {
                    nodes: [
                      {
                        id: "c1",
                        createdAt: "2026-01-01T00:00:00.000Z",
                        updatedAt: "2026-01-01T00:00:00.000Z",
                        body: "SDK",
                        reactions: [],
                      },
                    ],
                    pageInfo: {
                      hasNextPage: false,
                      hasPreviousPage: false,
                      startCursor: "c1",
                      endCursor: "c1",
                    },
                  },
                },
              },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response(
          JSON.stringify({
            data: {
              issue: {
                id: "issue-id",
                identifier: "ANY-451",
                title: "Real adapter",
                description: "Only requested fields are consumed",
                reactions: [],
                sharedAccess: { sharedWithUsers: [] },
              },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    );
    const subject = new LinearRequirementsLoader({
      exchangeToken: async () => "temporary-oauth-token",
      createClient: (accessToken) => new LinearClient({ accessToken }),
    });

    await expect(subject.load("ANY-451", credentials)).resolves.toMatchObject({
      title: "Real adapter",
      comments: [{ body: "SDK" }],
    });
    expect(requests).toHaveLength(2);
    expect(
      requests.every(({ authorization }) => authorization === "Bearer temporary-oauth-token"),
    ).toBe(true);
  });
});
