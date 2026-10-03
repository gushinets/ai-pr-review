import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";
import { handleWebhook, MAX_WEBHOOK_BYTES, type GatewayDependencies } from "./gateway.js";
import {
  createAppGitHubGateway,
  type AppCredentials,
  type CentralDispatchConfig,
} from "./github-app.js";
import { SqliteCommandLedger } from "./command-ledger.js";
import { handleCompletion, MAX_COMPLETION_BYTES } from "./completion.js";

function respond(res: ServerResponse, code: number, status: string) {
  res.writeHead(code, {
    "content-type": "application/json",
    "cache-control": "no-store",
    connection: "close",
  });
  res.end(JSON.stringify({ status }));
}
function header(req: IncomingMessage, name: string): string {
  const value = req.headers[name];
  return typeof value === "string" ? value : "";
}
export function createWebhookServer(deps: GatewayDependencies & { completionSecret: string }) {
  const server = createServer({ maxHeaderSize: 16_384 }, (req, res) => {
    void (async () => {
      try {
        if (req.url === "/healthz" && req.method === "GET") {
          respond(res, 200, "OK");
          return;
        }
        const completion = req.url === "/completion";
        if (req.url !== "/webhook" && !completion) {
          respond(res, 404, "NOT_FOUND");
          return;
        }
        if (req.method !== "POST") {
          respond(res, 405, "METHOD_REJECTED");
          return;
        }
        if (!/^application\/json(?:\s*;|$)/i.test(header(req, "content-type"))) {
          respond(res, 415, "CONTENT_TYPE_REJECTED");
          return;
        }
        const limit = completion ? MAX_COMPLETION_BYTES : MAX_WEBHOOK_BYTES;
        if (Number(header(req, "content-length")) > limit) {
          respond(res, 413, "PAYLOAD_TOO_LARGE");
          return;
        }
        const chunks: Buffer[] = [];
        let length = 0;
        for await (const value of req) {
          const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as string);
          length += chunk.length;
          if (length > limit) {
            respond(res, 413, "PAYLOAD_TOO_LARGE");
            return;
          }
          chunks.push(chunk);
        }
        const body = Buffer.concat(chunks, length);
        const result = completion
          ? await handleCompletion(
              { body, signature: header(req, "x-ai-review-signature-256") },
              deps,
            )
          : await handleWebhook(
              {
                body,
                signature: header(req, "x-hub-signature-256"),
                event: header(req, "x-github-event"),
                delivery: header(req, "x-github-delivery"),
              },
              deps,
            );
        const code =
          result.status === "INVALID_SIGNATURE"
            ? 401
            : result.status === "INVALID_PAYLOAD"
              ? 400
              : result.status === "PAYLOAD_TOO_LARGE"
                ? 413
                : ["TARGET_REJECTED", "COMPLETION_REJECTED"].includes(result.status)
                  ? 403
                  : ["DISPATCH_UNCERTAIN", "LEDGER_UNAVAILABLE"].includes(result.status)
                    ? 503
                    : 202;
        respond(res, code, result.status);
      } catch {
        if (!res.headersSent) respond(res, 500, "REQUEST_REJECTED");
        else res.destroy();
      }
    })();
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  server.timeout = 30_000;
  server.keepAliveTimeout = 5_000;
  return server;
}
export interface GatewayConfig {
  credentials: AppCredentials;
  webhookSecret: string;
  completionSecret: string;
  central: CentralDispatchConfig;
  ledgerPath: string;
  port: number;
}
export function readGatewayConfig(env: NodeJS.ProcessEnv): GatewayConfig {
  try {
    const privateKey =
      env.GITHUB_APP_PRIVATE_KEY ??
      (env.GITHUB_APP_PRIVATE_KEY_FILE
        ? readFileSync(env.GITHUB_APP_PRIVATE_KEY_FILE, "utf8")
        : undefined);
    const dispatchPrivateKey =
      env.GITHUB_DISPATCH_APP_PRIVATE_KEY ??
      (env.GITHUB_DISPATCH_APP_PRIVATE_KEY_FILE
        ? readFileSync(env.GITHUB_DISPATCH_APP_PRIVATE_KEY_FILE, "utf8")
        : undefined);
    const portText = env.PORT ?? "3000";
    if (
      !env.GITHUB_APP_ID ||
      !privateKey ||
      !env.GITHUB_DISPATCH_APP_ID ||
      !dispatchPrivateKey ||
      Number(env.GITHUB_APP_ID) === Number(env.GITHUB_DISPATCH_APP_ID) ||
      !env.GITHUB_WEBHOOK_SECRET ||
      !env.AI_REVIEW_COMPLETION_SECRET ||
      !env.AI_REVIEW_CENTRAL_REPOSITORY ||
      !env.AI_REVIEW_LEDGER_PATH ||
      !/^[0-9]+$/.test(portText) ||
      Number(portText) < 1 ||
      Number(portText) > 65535
    )
      throw new Error();
    return {
      credentials: { appId: env.GITHUB_APP_ID, privateKey },
      webhookSecret: env.GITHUB_WEBHOOK_SECRET,
      completionSecret: env.AI_REVIEW_COMPLETION_SECRET,
      central: {
        credentials: { appId: env.GITHUB_DISPATCH_APP_ID, privateKey: dispatchPrivateKey },
        repository: env.AI_REVIEW_CENTRAL_REPOSITORY,
        workflow: env.AI_REVIEW_CENTRAL_WORKFLOW ?? "central-ai-pr-review.yml",
        ref: env.AI_REVIEW_CENTRAL_REF ?? "main",
      },
      ledgerPath: env.AI_REVIEW_LEDGER_PATH,
      port: Number(portText),
    };
  } catch {
    throw new Error("GATEWAY_CONFIG_INVALID");
  }
}
export function startGateway(env: NodeJS.ProcessEnv = process.env) {
  const config = readGatewayConfig(env);
  const github = createAppGitHubGateway(config.credentials, config.central);
  const ledger = new SqliteCommandLedger(config.ledgerPath);
  const server = createWebhookServer({
    webhookSecret: config.webhookSecret,
    completionSecret: config.completionSecret,
    ledger,
    github,
  });
  server.once("close", () => ledger.close());
  server.on("error", () => {
    console.error("GATEWAY_LISTEN_FAILED");
    server.close();
  });
  server.listen(config.port, "0.0.0.0");
  return server;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const server = startGateway();
    const stop = () => server.close();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  } catch {
    console.error("GATEWAY_START_FAILED");
    process.exitCode = 1;
  }
}
