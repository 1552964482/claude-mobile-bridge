"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const {
  buildClaudeArgs,
  createApp,
  parseArgs,
  translateClaudeEvent,
} = require("../server");

const SESSION_ID = "123e4567-e89b-42d3-a456-426614174000";

test("safe mode limits tools and starts a fixed session", () => {
  const args = buildClaudeArgs({
    sessionId: SESSION_ID,
    hasStarted: false,
    mode: "safe",
  });

  assert.deepEqual(args.slice(-4), ["--tools", "Read,Edit,Write,Glob,Grep", "--session-id", SESSION_ID]);
  assert.ok(args.includes("acceptEdits"));
  assert.ok(!args.includes("bypassPermissions"));
});

test("autonomous mode resumes with bypass permissions", () => {
  const args = buildClaudeArgs({
    sessionId: SESSION_ID,
    hasStarted: true,
    mode: "autonomous",
  });

  assert.ok(args.includes("bypassPermissions"));
  assert.ok(args.includes("--resume"));
  assert.ok(!args.includes("--tools"));
});

test("assistant and tool events are translated for the mobile UI", () => {
  const events = translateClaudeEvent({
    type: "assistant",
    message: {
      content: [
        { type: "text", text: "完成修改。" },
        {
          type: "tool_use",
          name: "Edit",
          input: { file_path: "src/app.js" },
        },
      ],
    },
  });

  assert.deepEqual(events, [
    { type: "assistant", text: "完成修改。" },
    { type: "tool", name: "Edit", detail: "src/app.js" },
  ]);
});

test("workspace argument is resolved", () => {
  const config = parseArgs(["--port", "4567", "--workspace", "."]);
  assert.equal(config.port, 4567);
  assert.equal(config.workspace, path.resolve("."));
});

test("mobile browser can exchange a pairing code for an access token", async (t) => {
  const app = createApp({
    config: { host: "127.0.0.1", port: 0, workspace: path.resolve(".") },
    token: "test-access-token",
    pairingCode: "123456",
  });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  t.after(() => app.close());
  const address = app.server.address();

  const response = await fetch(`http://127.0.0.1:${address.port}/api/pair`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: "123456" }),
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { token: "test-access-token" });
});

test("pairing accepts a strong remote access code", async (t) => {
  const app = createApp({
    config: { host: "127.0.0.1", port: 0, workspace: path.resolve(".") },
    token: "remote-test-token",
    pairingCode: "xN7pQ2mK9vRt4sLd",
  });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  t.after(() => app.close());
  const address = app.server.address();

  const response = await fetch(`http://127.0.0.1:${address.port}/api/pair`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: "xN7pQ2mK9vRt4sLd" }),
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { token: "remote-test-token" });
});
