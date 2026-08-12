import assert from "node:assert/strict";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { LightroomSocketTransport } from "../src/socket-transport.mjs";

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

test("authenticated two-socket transport calls a localhost mock plug-in", async (t) => {
  let responsePeer;
  const responseServer = net.createServer((socket) => { responsePeer = socket; });
  const requestServer = net.createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const request = JSON.parse(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        assert.equal(request.token, "a".repeat(64));
        assert.equal(request.method, "capabilities");
        responsePeer.write(`${JSON.stringify({
          request_id: request.request_id,
          ok: true,
          result: { host: "127.0.0.1", single_client: true },
        })}\n`);
      }
    });
  });
  const responsePort = await listen(responseServer);
  const requestPort = await listen(requestServer);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "lr-bridge-test-"));
  const sessionPath = path.join(tempDir, "session.json");
  await fs.writeFile(sessionPath, JSON.stringify({
    protocol_version: 1,
    session_id: "mock-session",
    host: "127.0.0.1",
    request_port: requestPort,
    response_port: responsePort,
    token: "a".repeat(64),
    max_request_bytes: 1_048_576,
    max_response_bytes: 1_048_576,
  }));
  const transport = new LightroomSocketTransport({ sessionPath, timeoutMs: 2_000 });
  t.after(async () => {
    transport.close();
    responsePeer?.destroy();
    await Promise.all([closeServer(requestServer), closeServer(responseServer)]);
    await fs.rm(tempDir, { recursive: true, force: true });
  });
  const result = await transport.call("capabilities", {});
  assert.deepEqual(result, { host: "127.0.0.1", single_client: true });
});

test("transport refuses a session descriptor for a non-loopback host", async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "lr-bridge-host-test-"));
  const sessionPath = path.join(tempDir, "session.json");
  await fs.writeFile(sessionPath, JSON.stringify({
    session_id: "unsafe",
    host: "0.0.0.0",
    request_port: 1000,
    response_port: 1001,
    token: "b".repeat(64),
  }));
  t.after(() => fs.rm(tempDir, { recursive: true, force: true }));
  const transport = new LightroomSocketTransport({ sessionPath, timeoutMs: 100 });
  await assert.rejects(() => transport.call("capabilities", {}), (error) => error.code === "UNSAFE_HOST");
});
