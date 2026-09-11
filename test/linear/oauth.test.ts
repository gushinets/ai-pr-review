import { describe, expect, it, vi } from "vitest";
import { exchangeLinearAccessToken } from "../../src/linear/oauth.js";

const credentials = { clientId: "client id", clientSecret: "secret&value" };

describe("exchangeLinearAccessToken", () => {
  it("posts the exact client-credentials form and returns the token in memory", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(JSON.stringify({ access_token: "temporary-token" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await expect(exchangeLinearAccessToken(credentials, { fetch })).resolves.toBe(
      "temporary-token",
    );
    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("https://api.linear.app/oauth/token");
    expect(init).toMatchObject({
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    expect(String(init?.body)).toBe(
      "grant_type=client_credentials&scope=read&client_id=client+id&client_secret=secret%26value",
    );
  });

  it.each([401, 403])("maps HTTP %s to LINEAR_AUTH_FAILED without retrying", async (status) => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response(null, { status }));

    await expect(exchangeLinearAccessToken(credentials, { fetch })).rejects.toMatchObject({
      reason: "LINEAR_AUTH_FAILED",
    });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("retries transient responses only within the bound", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 429 }))
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 500 }));
    const sleep = vi.fn(async () => undefined);

    await expect(exchangeLinearAccessToken(credentials, { fetch, sleep })).rejects.toMatchObject({
      reason: "LINEAR_UNAVAILABLE",
    });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("retries a network failure and does not expose its raw error as a cause", async () => {
    const raw = new TypeError("fetch failed: secret detail");
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockRejectedValueOnce(raw)
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: "fresh-token" }), { status: 200 }),
      );

    await expect(
      exchangeLinearAccessToken(credentials, { fetch, sleep: async () => undefined }),
    ).resolves.toBe("fresh-token");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("rejects a successful response without a token", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ token_type: "Bearer" }), { status: 200 }));

    await expect(exchangeLinearAccessToken(credentials, { fetch })).rejects.toMatchObject({
      reason: "LINEAR_UNAVAILABLE",
    });
  });
});
