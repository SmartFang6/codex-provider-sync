import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { DatabaseSync } from "node:sqlite";

import {
  DB_FILE_BASENAME,
  SESSION_DIRS,
  defaultCloudBackupRoot
} from "./constants.js";

function stateDbPath(codexHome) {
  return path.join(codexHome, DB_FILE_BASENAME);
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function listRolloutFiles(rootDir) {
  let entries;
  try {
    entries = await fs.readdir(rootDir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listRolloutFiles(fullPath)));
      continue;
    }
    if (entry.isFile() && entry.name.startsWith("rollout-") && entry.name.endsWith(".jsonl")) {
      files.push(fullPath);
    }
  }
  return files;
}

function parseFirstLineRecord(content) {
  const newlineIndex = content.indexOf("\n");
  const firstLine = newlineIndex === -1 ? content : content.slice(0, newlineIndex).replace(/\r$/, "");
  if (!firstLine) {
    return null;
  }
  try {
    const parsed = JSON.parse(firstLine);
    if (parsed?.type !== "session_meta" || typeof parsed?.payload !== "object" || parsed.payload === null) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function sha256(content) {
  return crypto.createHash("sha256").update(content).digest("hex");
}

function tableExists(db, tableName) {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(tableName);
  return Boolean(row);
}

function getTableColumns(db, tableName) {
  if (!tableExists(db, tableName)) {
    return [];
  }
  return db.prepare(`PRAGMA table_info(${tableName})`).all().map((row) => row.name);
}

function readAllRows(db, tableName) {
  if (!tableExists(db, tableName)) {
    return [];
  }
  return db.prepare(`SELECT * FROM ${tableName}`).all().map((row) => ({ ...row }));
}

async function readThreadRows(codexHome) {
  const dbPath = stateDbPath(codexHome);
  if (!(await pathExists(dbPath))) {
    return { threads: [], edges: [] };
  }

  const db = new DatabaseSync(dbPath);
  try {
    return {
      threads: readAllRows(db, "threads"),
      edges: readAllRows(db, "thread_spawn_edges")
    };
  } finally {
    db.close();
  }
}

function normalizeRelativePath(codexHome, filePath) {
  return path.relative(codexHome, filePath).split(path.sep).join("/");
}

function publicSessionFromParts({ rollout, threadRow, edges }) {
  const row = threadRow ?? {};
  const meta = rollout?.sessionMeta?.payload ?? {};
  const id = row.id ?? meta.id;
  const archived = Number(row.archived ?? (rollout?.directory === "archived_sessions" ? 1 : 0)) ? 1 : 0;
  const relatedEdges = edges.filter((edge) =>
    edge.parent_thread_id === id || edge.child_thread_id === id
  );
  return {
    id,
    title: row.title ?? meta.title ?? row.first_user_message ?? "",
    model_provider: row.model_provider ?? meta.model_provider ?? "",
    cwd: row.cwd ?? meta.cwd ?? "",
    rollout_path: row.rollout_path ?? rollout?.relativePath ?? "",
    rollout_relative_path: rollout?.relativePath ?? "",
    rollout_hash: rollout?.hash ?? null,
    rollout_size: rollout?.size ?? 0,
    rollout_missing: !rollout,
    created_at: row.created_at ?? meta.created_at ?? null,
    updated_at: row.updated_at ?? meta.updated_at ?? row.created_at ?? null,
    archived,
    source: row.source ?? meta.source ?? "",
    model: row.model ?? meta.model ?? "",
    first_user_message: row.first_user_message ?? "",
    edge_count: relatedEdges.length
  };
}

async function scanRollouts(codexHome, { includeContent = false } = {}) {
  const rollouts = new Map();
  for (const directory of SESSION_DIRS) {
    const root = path.join(codexHome, directory);
    const files = await listRolloutFiles(root);
    for (const fullPath of files) {
      const content = await fs.readFile(fullPath, "utf8");
      const sessionMeta = parseFirstLineRecord(content);
      const id = sessionMeta?.payload?.id;
      if (!id) {
        continue;
      }
      const rollout = {
        id,
        fullPath,
        relativePath: normalizeRelativePath(codexHome, fullPath),
        directory,
        sessionMeta,
        hash: sha256(content),
        size: Buffer.byteLength(content, "utf8")
      };
      if (includeContent) {
        rollout.content = content;
      }
      rollouts.set(id, rollout);
    }
  }
  return rollouts;
}

export async function listLocalCloudSessions(codexHome) {
  const [{ threads, edges }, rollouts] = await Promise.all([
    readThreadRows(codexHome),
    scanRollouts(codexHome)
  ]);
  const threadMap = new Map(threads.map((row) => [row.id, row]));
  const ids = new Set([...threadMap.keys(), ...rollouts.keys()]);
  const sessions = [...ids]
    .filter(Boolean)
    .map((id) => publicSessionFromParts({
      rollout: rollouts.get(id),
      threadRow: threadMap.get(id),
      edges
    }))
    .sort((left, right) => Number(right.updated_at ?? 0) - Number(left.updated_at ?? 0));

  return {
    codexHome,
    sessions
  };
}

function normalizeDevice(input = {}) {
  return {
    id: input.id ?? os.hostname(),
    name: input.name ?? os.hostname(),
    platform: process.platform,
    hostname: os.hostname()
  };
}

export async function buildUploadBundle(codexHome, { ids, all = false, device } = {}) {
  const [{ threads, edges }, rollouts] = await Promise.all([
    readThreadRows(codexHome),
    scanRollouts(codexHome, { includeContent: true })
  ]);
  const threadMap = new Map(threads.map((row) => [row.id, row]));
  const requestedIds = all
    ? [...new Set([...threadMap.keys(), ...rollouts.keys()])].filter(Boolean)
    : [...new Set(ids ?? [])].filter(Boolean);
  const selectedIds = new Set(requestedIds);
  const skippedMissingRollouts = [];
  const sessions = [];

  for (const id of requestedIds) {
    const rollout = rollouts.get(id);
    if (!rollout) {
      skippedMissingRollouts.push(id);
      continue;
    }
    const threadRow = threadMap.get(id) ?? {
      id,
      title: "",
      model_provider: rollout.sessionMeta?.payload?.model_provider ?? "",
      cwd: rollout.sessionMeta?.payload?.cwd ?? "",
      rollout_path: rollout.relativePath,
      created_at: null,
      updated_at: null,
      archived: rollout.directory === "archived_sessions" ? 1 : 0,
      source: rollout.sessionMeta?.payload?.source ?? "",
      model: rollout.sessionMeta?.payload?.model ?? "",
      first_user_message: ""
    };
    sessions.push({
      id,
      threadRow: {
        ...threadRow,
        rollout_path: rollout.relativePath,
        archived: Number(threadRow.archived ?? (rollout.directory === "archived_sessions" ? 1 : 0)) ? 1 : 0
      },
      rollout: {
        relativePath: rollout.relativePath,
        directory: rollout.directory,
        content: rollout.content,
        hash: rollout.hash,
        size: rollout.size
      },
      sessionMeta: rollout.sessionMeta
    });
  }

  return {
    version: 1,
    device: normalizeDevice(device),
    sessions,
    edges: edges.filter((edge) =>
      selectedIds.has(edge.parent_thread_id) || selectedIds.has(edge.child_thread_id)
    ),
    skippedMissingRollouts
  };
}

function timestampSlug(date = new Date()) {
  return date.toISOString().replaceAll(":", "").replaceAll("-", "").replace(".", "");
}

async function copyIfPresent(sourcePath, destinationPath) {
  if (!(await pathExists(sourcePath))) {
    return false;
  }
  await fs.mkdir(path.dirname(destinationPath), { recursive: true });
  await fs.copyFile(sourcePath, destinationPath);
  return true;
}

async function createCloudPullBackup(codexHome, incomingSessions) {
  const backupDir = path.join(defaultCloudBackupRoot(codexHome), timestampSlug());
  await fs.mkdir(path.join(backupDir, "db"), { recursive: true });
  const copiedDbFiles = [];
  for (const suffix of ["", "-shm", "-wal"]) {
    const fileName = `${DB_FILE_BASENAME}${suffix}`;
    const copied = await copyIfPresent(path.join(codexHome, fileName), path.join(backupDir, "db", fileName));
    if (copied) {
      copiedDbFiles.push(fileName);
    }
  }
  await fs.writeFile(
    path.join(backupDir, "metadata.json"),
    JSON.stringify({
      version: 1,
      namespace: "cloud-sync",
      codexHome,
      createdAt: new Date().toISOString(),
      dbFiles: copiedDbFiles,
      incomingSessionIds: incomingSessions.map((session) => session.id)
    }, null, 2),
    "utf8"
  );
  return backupDir;
}

function ensureMinimalStateSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS threads (
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
    )
  `);
}

function ensureMinimalEdgeSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS thread_spawn_edges (
      parent_thread_id TEXT NOT NULL,
      child_thread_id TEXT NOT NULL,
      status TEXT,
      PRIMARY KEY (parent_thread_id, child_thread_id)
    )
  `);
}

function normalizeDbValue(value) {
  if (value === undefined) {
    return null;
  }
  if (typeof value === "boolean") {
    return value ? 1 : 0;
  }
  if (typeof value === "object" && value !== null) {
    return JSON.stringify(value);
  }
  return value;
}

function defaultEpochSeconds() {
  return Math.floor(Date.now() / 1000);
}

function fallbackThreadRow(session, rolloutPath) {
  const meta = session.sessionMeta?.payload ?? {};
  const now = defaultEpochSeconds();
  return {
    id: session.id,
    title: meta.title ?? "",
    model_provider: meta.model_provider ?? "",
    cwd: meta.cwd ?? "",
    rollout_path: rolloutPath,
    created_at: meta.created_at ?? now,
    updated_at: meta.updated_at ?? meta.created_at ?? now,
    archived: session.rollout?.directory === "archived_sessions" ? 1 : 0,
    source: meta.source ?? "",
    model: meta.model ?? "",
    first_user_message: ""
  };
}

function safeFilename(value) {
  return String(value ?? "session")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "session";
}

function fallbackRolloutRelativePath(session) {
  const rawTime = session.sessionMeta?.timestamp ?? session.sessionMeta?.payload?.timestamp;
  const date = rawTime ? new Date(rawTime) : new Date();
  const safeDate = Number.isNaN(date.getTime()) ? new Date() : date;
  const year = String(safeDate.getUTCFullYear());
  const month = String(safeDate.getUTCMonth() + 1).padStart(2, "0");
  const day = String(safeDate.getUTCDate()).padStart(2, "0");
  const directory = session.rollout?.directory === "archived_sessions" ? "archived_sessions" : "sessions";
  return `${directory}/${year}/${month}/${day}/rollout-${safeFilename(session.id)}.jsonl`;
}

function sanitizeRolloutRelativePath(rawPath, session) {
  const fallback = fallbackRolloutRelativePath(session);
  if (!rawPath || typeof rawPath !== "string") {
    return fallback;
  }
  const normalized = rawPath.replaceAll("\\", "/");
  if (path.isAbsolute(normalized) || /^[A-Za-z]:\//.test(normalized)) {
    return fallback;
  }
  const parts = normalized.split("/").filter(Boolean);
  if (parts.some((part) => part === "." || part === "..")) {
    return fallback;
  }
  if (!SESSION_DIRS.includes(parts[0]) || !parts.at(-1)?.startsWith("rollout-") || !parts.at(-1)?.endsWith(".jsonl")) {
    return fallback;
  }
  return parts.join("/");
}

async function uniqueRolloutRelativePath(codexHome, rawPath, session) {
  const relativePath = sanitizeRolloutRelativePath(rawPath, session);
  if (!(await pathExists(path.join(codexHome, relativePath)))) {
    return relativePath;
  }
  const parsed = path.parse(relativePath);
  for (let index = 1; index < 1000; index += 1) {
    const candidate = path.join(parsed.dir, `${parsed.name}.imported-${index}${parsed.ext}`).split(path.sep).join("/");
    if (!(await pathExists(path.join(codexHome, candidate)))) {
      return candidate;
    }
  }
  throw new Error(`Unable to choose a free rollout path for ${session.id}`);
}

function insertThread(db, session, rolloutPath) {
  const columns = getTableColumns(db, "threads");
  const threadRow = {
    ...fallbackThreadRow(session, rolloutPath),
    ...(session.threadRow ?? {}),
    id: session.id,
    rollout_path: rolloutPath,
    archived: Number(session.threadRow?.archived ?? (session.rollout?.directory === "archived_sessions" ? 1 : 0)) ? 1 : 0
  };
  const insertColumns = columns.filter((column) => threadRow[column] !== undefined);
  if (!insertColumns.includes("id")) {
    throw new Error("Local threads table does not include an id column.");
  }
  const placeholders = insertColumns.map(() => "?").join(", ");
  const quotedColumns = insertColumns.map((column) => `"${column}"`).join(", ");
  const values = insertColumns.map((column) => normalizeDbValue(threadRow[column]));
  db.prepare(`INSERT INTO threads (${quotedColumns}) VALUES (${placeholders})`).run(...values);
}

function insertEdges(db, edges, importedIds) {
  if (!edges.length) {
    return 0;
  }
  ensureMinimalEdgeSchema(db);
  const columns = getTableColumns(db, "thread_spawn_edges");
  let inserted = 0;
  for (const edge of edges) {
    if (!importedIds.has(edge.parent_thread_id) && !importedIds.has(edge.child_thread_id)) {
      continue;
    }
    const edgeRow = {
      status: "completed",
      ...edge
    };
    const insertColumns = columns.filter((column) => edgeRow[column] !== undefined);
    if (!insertColumns.includes("parent_thread_id") || !insertColumns.includes("child_thread_id")) {
      continue;
    }
    const placeholders = insertColumns.map(() => "?").join(", ");
    const quotedColumns = insertColumns.map((column) => `"${column}"`).join(", ");
    const values = insertColumns.map((column) => normalizeDbValue(edgeRow[column]));
    db.prepare(`INSERT OR IGNORE INTO thread_spawn_edges (${quotedColumns}) VALUES (${placeholders})`).run(...values);
    inserted += 1;
  }
  return inserted;
}

export async function applyPullBundle(codexHome, bundle) {
  const sessions = bundle?.sessions ?? [];
  const backupDir = await createCloudPullBackup(codexHome, sessions);
  await fs.mkdir(codexHome, { recursive: true });

  const db = new DatabaseSync(stateDbPath(codexHome));
  const writtenPaths = [];
  const importedIds = new Set();
  const skippedExisting = [];
  let transactionOpen = false;

  try {
    ensureMinimalStateSchema(db);
    db.exec("BEGIN IMMEDIATE");
    transactionOpen = true;
    const existingRows = db.prepare("SELECT id FROM threads").all();
    const existingIds = new Set(existingRows.map((row) => row.id));

    for (const session of sessions) {
      if (!session?.id) {
        continue;
      }
      if (existingIds.has(session.id)) {
        skippedExisting.push(session.id);
        continue;
      }
      const rolloutPath = await uniqueRolloutRelativePath(
        codexHome,
        session.rollout?.relativePath ?? session.threadRow?.rollout_path,
        session
      );
      const fullPath = path.join(codexHome, rolloutPath);
      await fs.mkdir(path.dirname(fullPath), { recursive: true });
      await fs.writeFile(fullPath, session.rollout?.content ?? "", "utf8");
      writtenPaths.push(fullPath);
      insertThread(db, session, rolloutPath);
      existingIds.add(session.id);
      importedIds.add(session.id);
    }

    const insertedEdges = insertEdges(db, bundle?.edges ?? [], existingIds);
    db.exec("COMMIT");
    transactionOpen = false;
    return {
      codexHome,
      backupDir,
      imported: importedIds.size,
      skippedExisting,
      insertedEdges,
      writtenPaths
    };
  } catch (error) {
    if (transactionOpen) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // Ignore rollback errors and clean up files below.
      }
    }
    for (const filePath of writtenPaths.reverse()) {
      await fs.rm(filePath, { force: true });
    }
    throw error;
  } finally {
    db.close();
  }
}
