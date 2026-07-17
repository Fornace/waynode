import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { cleanupSseOnResponseClose } from "../routes/sessions.js";

const subscribers = new Set();
const cleanupCounts = { ping: 0, agent: 0, hammersmith: 0 };
let response;
let resolveCleanup;
const cleanupComplete = new Promise((resolve) => { resolveCleanup = resolve; });

async function within(promise, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), 3_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

const server = http.createServer((req, res) => {
  response = res;
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  const subscriber = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);
  subscribers.add(subscriber);
  subscriber({ type: "sync" });

  const ping = setInterval(() => {}, 60_000);
  cleanupSseOnResponseClose(res, [
    () => { clearInterval(ping); cleanupCounts.ping += 1; },
    () => { subscribers.delete(subscriber); cleanupCounts.agent += 1; },
    () => { cleanupCounts.hammersmith += 1; resolveCleanup(); },
  ]);
  req.resume();
});

let request;
let clientResponse;
try {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  request = http.get({ host: address.address, port: address.port, path: "/stream" });
  [clientResponse] = await once(request, "response");
  clientResponse.setEncoding("utf8");

  let body = "";
  const syncEvent = new Promise((resolve) => {
    clientResponse.on("data", (chunk) => {
      body += chunk;
      if (body.includes('"type":"sync"')) resolve();
    });
  });

  await within(syncEvent, "the initial SSE event");
  assert.equal(subscribers.size, 1, "the client remains subscribed while its response is open");
  assert.match(body, /data: \{"type":"sync"\}/);

  clientResponse.destroy();
  request.destroy();
  await within(cleanupComplete, "response disconnect cleanup");
  assert.equal(subscribers.size, 0, "response disconnect immediately unsubscribes the SSE client");
  assert.deepEqual(cleanupCounts, { ping: 1, agent: 1, hammersmith: 1 });

  response.emit("close");
  assert.deepEqual(cleanupCounts, { ping: 1, agent: 1, hammersmith: 1 }, "cleanup runs exactly once");
} finally {
  clientResponse?.destroy();
  request?.destroy();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

console.log("session SSE lifecycle: response disconnect deleted the subscriber immediately and cleanup ran once");
