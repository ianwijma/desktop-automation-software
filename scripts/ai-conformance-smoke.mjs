/** Harness acceptance uses only a private loopback fixture and synthetic data. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporary = await mkdtemp(
  path.join(tmpdir(), "relay-ai-conformance-smoke-"),
);
const exec = promisify(execFile);
let requests = 0,
  closed = 0,
  redirects = 0,
  forbidden = 0;
const server = createServer((req, res) => {
  let body = "";
  req.on("data", (data) => {
    body += data;
  });
  req.on("end", () => {
    if (req.url === "/redirect/api/chat") {
      redirects++;
      res.writeHead(302, {
        Location: `http://127.0.0.1:${server.address().port}/forbidden/api/chat`,
      });
      res.end();
      return;
    }
    if (req.url.startsWith("/forbidden")) {
      forbidden++;
      res.writeHead(500);
      res.end();
      return;
    }
    assert.equal(req.url, "/api/chat");
    assert.equal(req.method, "POST");
    requests++;
    const data = JSON.parse(body);
    assert.equal(data.model, "loopback-fixture-pinned");
    assert.equal(data.options.num_predict, 256);
    if (requests === 3) {
      res.on("close", () => {
        closed++;
      });
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        model: "loopback-fixture-actual",
        message: {
          content: data.format ? '{"relay":"connected"}' : "Relay connected",
        },
        prompt_eval_count: 3,
        eval_count: 2,
        private: "never-retain-this-response-field",
      }),
    );
  });
});
try {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const config = {
    version: 1,
    maxRequests: 3,
    requestTimeoutMs: 5000,
    totalTimeoutMs: 20000,
    profiles: [
      {
        id: "loopback-fixture",
        provider: "ollama",
        model: "loopback-fixture-pinned",
        baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
        capabilities: { text: true, structured: true, vision: false },
        runtime: {
          name: "harness-fixture",
          version: "1.0.0",
          modelRevision: "sha256:fixture",
        },
        operations: ["text", "structured"],
        cancellation: { operation: "text", afterMs: 500 },
      },
    ],
  };
  const configPath = path.join(temporary, "config.json");
  await writeFile(configPath, JSON.stringify(config));
  const run = async (name, flag, gate, expectedExit = 0) => {
    const output = path.join(temporary, `${name}.json`);
    let result;
    try {
      result = await exec(
        process.execPath,
        [
          "scripts/ai-conformance.mjs",
          "--config",
          configPath,
          "--output",
          output,
          ...(flag ? ["--run"] : []),
        ],
        {
          cwd: root,
          env: {
            ...process.env,
            RELAY_AI_LIVE: gate,
            RELAY_HARNESS_MISSING_KEY: undefined,
          },
          timeout: 60000,
          maxBuffer: 1024 * 1024,
        },
      );
      assert.equal(expectedExit, 0, "Expected a failing CLI exit");
    } catch (error) {
      if (error.code !== expectedExit) throw error;
      result = error;
    }
    assert(!result.stdout.includes("Relay connected"));
    assert(!result.stderr.includes("never-retain"));
    return JSON.parse(await readFile(output, "utf8"));
  };
  for (const [flag, gate] of [
    [false, "1"],
    [true, "0"],
  ]) {
    const report = await run(`disabled-${flag}`, flag, gate);
    assert.equal(report.status, "incomplete");
    assert.equal(report.live, false);
    assert.equal(report.requests, 0);
    assert.equal(requests, 0);
  }
  const report = await run("live-loopback", true, "1");
  assert.equal(report.status, "pass-selected");
  assert.equal(report.requests, 3);
  assert.equal(requests, 3);
  assert.equal(report.profiles[0].cases[2].diagnostics.errorCode, "cancelled");
  assert(report.environment.aiSDK);
  assert(report.environment.adapterSha256);
  assert(!JSON.stringify(report).includes("never-retain-this-response-field"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    closed,
    1,
    "Provider HTTP request must actually close on cancellation",
  );
  config.profiles[0].baseUrl = `http://127.0.0.1:${server.address().port}/redirect/v1`;
  config.profiles[0].operations = ["text"];
  delete config.profiles[0].cancellation;
  await writeFile(configPath, JSON.stringify(config));
  const redirect = await run("redirect-rejected", true, "1", 1);
  assert.equal(redirect.status, "fail");
  assert.equal(redirect.requests, 1);
  assert.equal(redirects, 1);
  assert.equal(
    forbidden,
    0,
    "Provider redirects must not create an extra request",
  );
  config.profiles[0].provider = "openrouter";
  config.profiles[0].keyEnv = "RELAY_HARNESS_MISSING_KEY";
  await writeFile(configPath, JSON.stringify(config));
  const missing = await run("missing-key", true, "1", 2);
  assert.equal(missing.status, "incomplete");
  assert.equal(missing.requests, 0);
  assert.equal(missing.profiles[0].cases[0].reason, "missing-key");
  assert.equal(redirects, 1);
  await mkdir(path.join(root, "test-results/ai-conformance"), {
    recursive: true,
  });
  await writeFile(
    path.join(root, "test-results/ai-conformance/harness-acceptance.json"),
    JSON.stringify(
      {
        schemaVersion: 1,
        status: "pass",
        mode: "loopback-fixture-only",
        liveProviderQualified: false,
        checks: [
          "both-opt-in-gates",
          "real-production-adapter-HTTP",
          "actual-cancellation-closes-request",
          "bounded-synthetic-output",
          "metadata-only-report",
          "missing-key-skips-with-incomplete-exit",
          "redirect-rejected-without-following",
        ],
        requests: 3,
        redirectRequests: 1,
      },
      null,
      2,
    ),
  );
  console.log(
    "PASS: AI conformance CLI opt-in gates, real production Ollama HTTP/metadata, cancellation, request bounds and redirect rejection; private loopback fixtures only, no live model qualification.",
  );
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await rm(temporary, { recursive: true, force: true });
}
