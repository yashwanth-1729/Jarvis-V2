/**
 * Thin HTTP entrypoint. All actual logic lives in handler.ts so it can be
 * unit-tested without binding a socket; this file only does request/response
 * plumbing and CORS.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { loadConfig } from "./config.js";
import { handleWrite } from "./handler.js";

const config = loadConfig();

function log(line: string): void {
  console.log(`[sldt-proxy] ${new Date().toISOString()} ${line}`);
}

function setCors(res: ServerResponse): void {
  if (config.allowedOrigin) {
    res.setHeader("Access-Control-Allow-Origin", config.allowedOrigin);
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  }
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (raw.length === 0) return {};
  return JSON.parse(raw);
}

const server = createServer((req, res) => {
  setCors(res);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method !== "POST" || req.url !== "/write") {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
    return;
  }

  readJsonBody(req)
    .then(async (body) => {
      const result = await handleWrite(body, config, log);
      res.writeHead(result.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result.body));
    })
    .catch((error) => {
      log(`request failed: ${error instanceof Error ? error.message : "unknown error"}`);
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "malformed request body" }));
    });
});

server.listen(config.port, () => {
  log(`listening on :${config.port}, repo=${config.repo} branch=${config.branch} prefix=${config.pathPrefix}`);
});
