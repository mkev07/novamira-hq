// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import {
  bearerAuth,
  createHttpClient,
  jsonBody,
} from "../dist/hosting/http-client.js";

// Never a real-looking secret: this only has to prove the header travels.
const TOKEN = "placeholder-not-a-secret";

async function startServer(handler) {
  const server = createServer(handler);
  await new Promise((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/** Records what each hop actually received, body included. */
function recordingHandler(respond) {
  const seen = [];
  return {
    seen,
    handler(request, response) {
      const chunks = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => {
        seen.push({
          method: request.method,
          url: request.url,
          body: Buffer.concat(chunks).toString("utf8"),
          contentType: request.headers["content-type"],
          authorization: request.headers.authorization,
        });
        respond(request, response);
      });
    },
  };
}

function client(server, options = {}) {
  return createHttpClient({
    baseUrl: `${server.baseUrl}/v1`,
    providerLabel: "Kinsta",
    auth: bearerAuth(TOKEN),
    retry: { maxAttempts: 1 },
    ...options,
  });
}

// RFC 9110 §15.4: a 303 — and a 301/302 answering a POST — is followed with
// GET and no body. Replaying the method and body would re-send a mutating
// request the provider never asked to be repeated, defeating the retry guard
// that deliberately refuses to replay a non-idempotent method.
for (const status of [301, 302, 303]) {
  test(`a ${String(status)} after POST is followed as a bodiless GET`, async () => {
    const recorder = recordingHandler((request, response) => {
      if (request.url === "/v1/sites") {
        response.writeHead(status, { location: "/v1/sites/42" });
        response.end();
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ id: 42 }));
    });
    const server = await startServer(recorder.handler);
    try {
      const response = await client(server).request({
        path: "/sites",
        method: "POST",
        body: jsonBody({ name: "new-site" }),
      });
      assert.equal(response.status, 200);
      assert.deepEqual(response.data, { id: 42 });
      assert.equal(recorder.seen.length, 2);

      assert.deepEqual(recorder.seen[0], {
        method: "POST",
        url: "/v1/sites",
        body: '{"name":"new-site"}',
        contentType: "application/json",
        authorization: `Bearer ${TOKEN}`,
      });
      // The redirect hop must not be a second POST, and must carry no body.
      assert.equal(recorder.seen[1].method, "GET");
      assert.equal(recorder.seen[1].url, "/v1/sites/42");
      assert.equal(recorder.seen[1].body, "");
      assert.equal(recorder.seen[1].contentType, undefined);
      // Same origin, so the credential still travels.
      assert.equal(recorder.seen[1].authorization, `Bearer ${TOKEN}`);
    } finally {
      await server.close();
    }
  });
}

test("only 307 and 308 replay the method and body", async () => {
  const recorder = recordingHandler((request, response) => {
    if (request.url === "/v1/sites") {
      response.writeHead(307, { location: "/v1/sites/42" });
      response.end();
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ id: 42 }));
  });
  const server = await startServer(recorder.handler);
  try {
    await client(server).request({
      path: "/sites",
      method: "POST",
      body: jsonBody({ name: "new-site" }),
    });
    assert.equal(recorder.seen.length, 2);
    assert.equal(recorder.seen[1].method, "POST");
    assert.equal(recorder.seen[1].body, '{"name":"new-site"}');
    assert.equal(recorder.seen[1].contentType, "application/json");
  } finally {
    await server.close();
  }
});

test("a redirect chain cannot outlive the request's own timeout", async () => {
  const hopDelayMs = 120;
  const timeoutMs = 200;
  const server = await startServer((request, response) => {
    const hop = Number(/hop(\d+)/.exec(request.url)[1]);
    setTimeout(() => {
      if (hop < 3) {
        response.writeHead(302, { location: `/v1/hop${String(hop + 1)}` });
        response.end();
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    }, hopDelayMs);
  });
  try {
    const startedAt = Date.now();
    // Each hop used to get a fresh `AbortSignal.timeout(timeoutMs)`, so three
    // redirects could run for four times the configured budget and still
    // succeed. The budget is now one absolute deadline for the whole attempt.
    await assert.rejects(
      client(server).request({
        path: "/hop0",
        timeoutMs,
        totalTimeoutMs: timeoutMs,
      }),
      { code: "timeout" },
    );
    const elapsedMs = Date.now() - startedAt;
    assert.ok(
      elapsedMs < 4 * timeoutMs,
      `the attempt took ${String(elapsedMs)}ms, over the ${String(timeoutMs)}ms budget`,
    );
  } finally {
    await server.close();
  }
});

test("a total timeout shorter than one attempt remains the upper bound", async () => {
  let requests = 0;
  const http = createHttpClient({
    baseUrl: "https://api.example.invalid/v1",
    providerLabel: "Kinsta",
    retry: { maxAttempts: 1 },
    fetch: async (_input, init) => {
      requests += 1;
      return new Promise((_resolve, reject) => {
        const signal = init.signal;
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      });
    },
  });

  const startedAt = Date.now();
  await assert.rejects(
    http.request({
      path: "/sites",
      timeoutMs: 1000,
      totalTimeoutMs: 20,
    }),
    { code: "timeout" },
  );
  assert.equal(requests, 1);
  assert.ok(Date.now() - startedAt < 500);
});

test("a redirect chain that fits the budget still succeeds", async () => {
  const server = await startServer((request, response) => {
    const hop = Number(/hop(\d+)/.exec(request.url)[1]);
    if (hop < 3) {
      response.writeHead(302, { location: `/v1/hop${String(hop + 1)}` });
      response.end();
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ hop }));
  });
  try {
    const response = await client(server).request({ path: "/hop0" });
    assert.equal(response.status, 200);
    assert.deepEqual(response.data, { hop: 3 });
    assert.ok(response.url.endsWith("/v1/hop3"));
  } finally {
    await server.close();
  }
});

test("a fourth redirect is refused rather than followed", async () => {
  const server = await startServer((request, response) => {
    const hop = Number(/hop(\d+)/.exec(request.url)[1]);
    response.writeHead(302, { location: `/v1/hop${String(hop + 1)}` });
    response.end();
  });
  try {
    await assert.rejects(client(server).request({ path: "/hop0" }), {
      code: "provider_error",
    });
  } finally {
    await server.close();
  }
});

test("a request with redirect: return gets the 3xx response and its cookies", async () => {
  const seen = [];
  const client = createHttpClient({
    baseUrl: "https://api.example.test",
    retry: { maxAttempts: 1 },
    fetch: async (input, init) => {
      seen.push(String(input));
      assert.equal(init.redirect, "manual");
      const headers = new Headers({ location: "/next" });
      headers.append("set-cookie", "a=1; HttpOnly");
      headers.append("set-cookie", "b=2; HttpOnly");
      return new Response(null, { status: 307, headers });
    },
  });
  const response = await client.request({ path: "/login", redirect: "return" });
  assert.equal(response.status, 307);
  assert.deepEqual(response.headers.getSetCookie(), [
    "a=1; HttpOnly",
    "b=2; HttpOnly",
  ]);
  assert.deepEqual(seen, ["https://api.example.test/login"]);
});

// A URL's pathname cannot be assigned "": http(s) normalizes it back to "/".
// Stripping the trailing slash through the URL object therefore left every
// request against a path-less base URL — Pantheon, Rocket.net and Hostinger all
// default to a bare origin — resolving to "//path" on the wire.
test("a base URL with no path does not double the leading slash", async () => {
  const recorder = recordingHandler((request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end("{}");
  });
  const server = await startServer(recorder.handler);
  try {
    for (const baseUrl of [
      server.baseUrl,
      `${server.baseUrl}/`,
      `${server.baseUrl}//`,
    ]) {
      const bare = createHttpClient({
        baseUrl,
        providerLabel: "Pantheon",
        retry: { maxAttempts: 1 },
      });
      assert.equal(bare.baseUrl, server.baseUrl);
      await bare.request({ path: "/v0/sites" });
      // A path with no leading slash joins the same way.
      await bare.request({ path: "v0/sites" });
    }
    assert.deepEqual(
      recorder.seen.map((hop) => hop.url),
      Array.from({ length: 6 }, () => "/v0/sites"),
    );

    // A base URL that does carry a prefix keeps it, with exactly one slash.
    const prefixed = createHttpClient({
      baseUrl: `${server.baseUrl}/api/v2/`,
      providerLabel: "Cloudways",
      retry: { maxAttempts: 1 },
    });
    assert.equal(prefixed.baseUrl, `${server.baseUrl}/api/v2`);
    await prefixed.request({ path: "/regions" });
    assert.equal(recorder.seen.at(-1).url, "/api/v2/regions");
  } finally {
    await server.close();
  }
});

test("multipart bodies carry fields and files and let fetch set the boundary", async () => {
  let seen;
  const client = createHttpClient({
    baseUrl: "https://api.example.test",
    retry: { maxAttempts: 1 },
    fetch: async (input, init) => {
      seen = {
        type: new Headers(init.headers).get("content-type"),
        body: init.body,
      };
      return new Response("{}", {
        headers: { "content-type": "application/json" },
      });
    },
  });
  await client.json({
    path: "/upload",
    method: "POST",
    body: {
      kind: "multipart",
      fields: { dir: "public_html/wp-content" },
      files: [
        {
          field: "file-1",
          filename: "a.zip",
          contentType: "application/zip",
          bytes: new Uint8Array([80, 75, 3, 4]),
        },
      ],
    },
  });
  assert.ok(seen.body instanceof FormData);
  assert.equal(seen.body.get("dir"), "public_html/wp-content");
  const file = seen.body.get("file-1");
  assert.equal(file.name, "a.zip");
  assert.equal(file.type, "application/zip");
  assert.deepEqual(
    new Uint8Array(await file.arrayBuffer()),
    new Uint8Array([80, 75, 3, 4]),
  );
  assert.equal(seen.type, null);
});

test("a retried idempotent multipart POST resends the complete form on every attempt", async () => {
  const bytes = new Uint8Array([80, 75, 3, 4, 9, 9]);
  const received = [];
  const server = await startServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const text = Buffer.concat(chunks).toString("latin1");
      received.push({ contentType: request.headers["content-type"], text });
      if (received.length === 1) {
        response.writeHead(503, { "retry-after": "0" });
        response.end("{}");
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
  });
  try {
    const client = createHttpClient({
      baseUrl: server.baseUrl,
      retry: { maxAttempts: 2, initialDelayMs: 1 },
    });
    await client.json({
      path: "/upload",
      method: "POST",
      idempotent: true,
      body: {
        kind: "multipart",
        fields: { dir: "public_html/wp-content" },
        files: [
          {
            field: "file-1",
            filename: "a.zip",
            contentType: "application/zip",
            bytes,
          },
        ],
      },
    });
    assert.equal(received.length, 2);
    for (const attempt of received) {
      assert.match(attempt.contentType, /^multipart\/form-data; boundary=/);
      assert.match(attempt.text, /name="dir"\r\n\r\npublic_html\/wp-content/);
      assert.match(attempt.text, /name="file-1"; filename="a\.zip"/);
      assert.ok(attempt.text.includes("PK\x03\x04\x09\x09"));
    }
  } finally {
    await server.close();
  }
});

test("multipart file bytes are not walked as sensitive body values", async () => {
  const bytes = new Uint8Array(8 * 1024 * 1024);
  const started = Date.now();
  const client = createHttpClient({
    baseUrl: "https://api.example.test",
    retry: { maxAttempts: 1 },
    fetch: async () =>
      new Response("{}", { headers: { "content-type": "application/json" } }),
  });
  await client.json({
    path: "/upload",
    method: "POST",
    body: {
      kind: "multipart",
      fields: { dir: "public_html" },
      files: [
        {
          field: "file-1",
          filename: "big.zip",
          contentType: "application/zip",
          bytes,
        },
      ],
    },
  });
  assert.ok(
    Date.now() - started < 1000,
    "body secret scan must not enumerate file bytes",
  );
});
