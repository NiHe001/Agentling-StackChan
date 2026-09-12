#!/usr/bin/env node

const chunks = [];
for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));

try {
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) process.exit(0);
  const endpoint = process.env.AGENTLING_ENDPOINT || "http://127.0.0.1:17321";
  const headers = { "content-type": "application/json" };
  if (process.env.AGENTLING_TOKEN) headers.authorization = `Bearer ${process.env.AGENTLING_TOKEN}`;
  await fetch(`${endpoint}/v1/hook`, {
    method: "POST",
    headers,
    body: raw,
    signal: AbortSignal.timeout(800),
  });
} catch {
  // Observation must never block or alter the Codex lifecycle.
}
