import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { DatabaseSync } from "node:sqlite";

import { startCloudServer } from "../src/cloud-server.js";
import {
  listCloudRemoteSessions,
  runCloudLogin,
  runCloudPull,
  runCloudPush
} from "../src/cloud-service.js";

async function makeTempCodexHome(name = "codex-cloud-sync-") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), name));
  const codexHome = path.join(root, ".codex");
  await fs.mkdir(path.join(codexHome, "sessions", "2026", "03", "19"), { recursive: true });
  await fs.mkdir(path.join(codexHome, "archived_sessions", "2026", "03", "18"), { recursive: true });
  return { root, codexHome };
}

async function writeRollout(filePath, { id, provider = "openai", message = "hi" }) {
  const payload = {
    id,
    timestamp: "2026-03-19T00:00:00.000Z",
    cwd: "/tmp/project",
    source: "cli",
    cli_version: "0.115.0",
    model_provider: provider
  };
  const lines = [
    JSON.stringify({ timestamp: payload.timestamp, type: "session_meta", payload }),
    JSON.stringify({ timestamp: payload.timestamp, type: "event_msg", payload: { type: "user_message", message } })
  ];
  await fs.writeFile(filePath, `${lines.join("\n")}\n`, "utf8");
}

async function writeStateDb(codexHome) {
  const db = new DatabaseSync(path.join(codexHome, "state_5.sqlite"));
  try {
    db.exec(`
      CREATE TABLE threads (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL DEFAULT '',
        model_provider TEXT,
        cwd TEXT,
        rollout_path TEXT,
        created_at INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL DEFAULT 0,
        archived INTEGER NOT NULL DEFAULT 0,
        source TEXT,
        model TEXT,
        first_user_message TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE thread_spawn_edges (
        parent_thread_id TEXT NOT NULL,
        child_thread_id TEXT NOT NULL,
        status TEXT,
        PRIMARY KEY (parent_thread_id, child_thread_id)
      );
    `);
    const stmt = db.prepare(`
      INSERT INTO threads (
        id, title, model_provider, cwd, rollout_path, created_at, updated_at,
        archived, source, model, first_user_message
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      "thread-a",
      "Local thread",
      "openai",
      "/tmp/project",
      "sessions/2026/03/19/rollout-a.jsonl",
      1773878400,
      1773878500,
      0,
      "cli",
      "gpt-test",
      "hello"
    );
    stmt.run(
      "thread-b",
      "Archived thread",
      "openai",
      "/tmp/project",
      "archived_sessions/2026/03/18/rollout-b.jsonl",
      1773792000,
      1773792100,
      1,
      "cli",
      "gpt-test",
      "archive"
    );
    db.prepare("INSERT INTO thread_spawn_edges (parent_thread_id, child_thread_id, status) VALUES (?, ?, ?)")
      .run("thread-a", "thread-b", "completed");
  } finally {
    db.close();
  }
}

async function startTestServer() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-cloud-server-"));
  const started = await startCloudServer({
    port: 0,
    dataDir,
    adminUser: "admin",
    adminPassword: "secret"
  });
  return started;
}

async function closeServer(server) {
  await new Promise((resolve) => server.close(resolve));
}

test("cloud server rejects unauthenticated remote session access", async () => {
  const { server, url } = await startTestServer();
  try {
    const response = await fetch(`${url}/api/remote-sessions`);
    assert.equal(response.status, 401);
  } finally {
    await closeServer(server);
  }
});

test("cloud push uploads sessions and pull imports them into another codex home", async () => {
  const source = await makeTempCodexHome("codex-cloud-source-");
  const dest = await makeTempCodexHome("codex-cloud-dest-");
  const sessionPath = path.join(source.codexHome, "sessions", "2026", "03", "19", "rollout-a.jsonl");
  const archivedPath = path.join(source.codexHome, "archived_sessions", "2026", "03", "18", "rollout-b.jsonl");
  await writeRollout(sessionPath, { id: "thread-a" });
  await writeRollout(archivedPath, { id: "thread-b" });
  await writeStateDb(source.codexHome);

  const { server, url } = await startTestServer();
  try {
    await runCloudLogin({ codexHome: source.codexHome, server: url, username: "admin", password: "secret" });
    const push = await runCloudPush({ codexHome: source.codexHome, all: true });
    assert.equal(push.uploaded, 2);
    assert.deepEqual(push.skippedMissingRollouts, []);

    const remote = await listCloudRemoteSessions({ codexHome: source.codexHome });
    assert.equal(remote.sessions.length, 2);

    await runCloudLogin({ codexHome: dest.codexHome, server: url, username: "admin", password: "secret" });
    const pull = await runCloudPull({ codexHome: dest.codexHome, all: true });
    assert.equal(pull.received, 2);
    assert.equal(pull.imported, 2);
    assert.deepEqual(pull.skippedExisting, []);

    await fs.access(path.join(dest.codexHome, "sessions", "2026", "03", "19", "rollout-a.jsonl"));
    await fs.access(path.join(dest.codexHome, "archived_sessions", "2026", "03", "18", "rollout-b.jsonl"));

    const db = new DatabaseSync(path.join(dest.codexHome, "state_5.sqlite"));
    try {
      const rows = db.prepare("SELECT id, archived FROM threads ORDER BY id").all();
      assert.deepEqual(rows.map((row) => ({ ...row })), [
        { id: "thread-a", archived: 0 },
        { id: "thread-b", archived: 1 }
      ]);
      const edges = db.prepare("SELECT parent_thread_id, child_thread_id FROM thread_spawn_edges").all();
      assert.deepEqual(edges.map((row) => ({ ...row })), [
        { parent_thread_id: "thread-a", child_thread_id: "thread-b" }
      ]);
    } finally {
      db.close();
    }

    const secondPull = await runCloudPull({ codexHome: dest.codexHome, all: true });
    assert.equal(secondPull.imported, 0);
    assert.deepEqual(secondPull.skippedExisting.sort(), ["thread-a", "thread-b"]);
  } finally {
    await closeServer(server);
  }
});

test("cloud push keeps a conflict revision for the same session id with different content", async () => {
  const source = await makeTempCodexHome("codex-cloud-conflict-");
  const sessionPath = path.join(source.codexHome, "sessions", "2026", "03", "19", "rollout-a.jsonl");
  await writeRollout(sessionPath, { id: "thread-a", message: "first" });
  await writeStateDb(source.codexHome);

  const { server, url } = await startTestServer();
  try {
    await runCloudLogin({ codexHome: source.codexHome, server: url, username: "admin", password: "secret" });
    const firstPush = await runCloudPush({ codexHome: source.codexHome, ids: ["thread-a"] });
    assert.equal(firstPush.uploaded, 1);

    await fs.appendFile(
      sessionPath,
      JSON.stringify({ timestamp: "2026-03-19T00:00:01.000Z", type: "event_msg", payload: { type: "assistant_message", message: "changed" } }) + "\n",
      "utf8"
    );
    const secondPush = await runCloudPush({ codexHome: source.codexHome, ids: ["thread-a"] });
    assert.equal(secondPush.uploaded, 1);
    assert.deepEqual(secondPush.conflicts, ["thread-a"]);

    const remote = await listCloudRemoteSessions({ codexHome: source.codexHome });
    assert.equal(remote.sessions.length, 1);
    const conflicted = remote.sessions.find((session) => session.id === "thread-a");
    assert.equal(conflicted.conflict, 1);
    assert.equal(conflicted.revision_count, 2);
  } finally {
    await closeServer(server);
  }
});
