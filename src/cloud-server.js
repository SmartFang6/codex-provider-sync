import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";

import { DatabaseSync } from "node:sqlite";

const PASSWORD_ITERATIONS = 310_000;
const TOKEN_BYTES = 32;

async function readBody(req, { limitBytes = 100 * 1024 * 1024 } = {}) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > limitBytes) {
      throw new Error("Request body is too large.");
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function json(res, data, status = 200) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization"
  });
  res.end(JSON.stringify(data));
}

function html(res, content, status = 200) {
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(content);
}

function serverAdminHtml() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Codex Session Sync</title>
<style>
:root{
  --bg:#f7f9fc;--surface:#ffffff;--line:#d9e1ec;--text:#1d2735;--muted:#66748a;
  --primary:#1165e5;--primary-strong:#0b4fb6;--danger:#c93434;--warn:#a15c00;
  --ok:#237a3b;--shadow:0 12px 30px rgba(29,39,53,.08);
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif;line-height:1.45}
.shell{max-width:1180px;margin:0 auto;padding:28px 18px 40px}
.top{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;margin-bottom:18px}
h1{font-size:24px;margin:0 0 6px;font-weight:700;letter-spacing:0}
.sub{font-size:14px;color:var(--muted)}
.badge{display:inline-flex;align-items:center;min-height:32px;padding:5px 12px;border-radius:999px;border:1px solid var(--line);background:var(--surface);font-size:13px;color:var(--muted)}
.panel{background:var(--surface);border:1px solid var(--line);border-radius:8px;box-shadow:var(--shadow);padding:16px;margin-bottom:14px}
.login{display:grid;grid-template-columns:1fr 1fr auto;gap:12px;align-items:end}
label{display:block;font-size:12px;font-weight:650;color:var(--muted);margin-bottom:6px}
input{width:100%;min-height:44px;border:1px solid var(--line);border-radius:8px;padding:10px 12px;font-size:15px;color:var(--text);background:#fff}
input:focus{outline:3px solid rgba(17,101,229,.18);border-color:var(--primary)}
button{min-height:44px;border:1px solid var(--line);border-radius:8px;padding:9px 14px;background:#fff;color:var(--text);font-weight:650;cursor:pointer}
button:hover{border-color:var(--primary);color:var(--primary)}
button:focus{outline:3px solid rgba(17,101,229,.18)}
button.primary{background:var(--primary);border-color:var(--primary);color:#fff}
button.primary:hover{background:var(--primary-strong);color:#fff}
button.danger{border-color:rgba(201,52,52,.45);color:var(--danger)}
button:disabled{opacity:.55;cursor:not-allowed}
.toolbar{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:12px}
.toolbar input{max-width:360px}
.stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin-bottom:14px}
.stat{border:1px solid var(--line);border-radius:8px;padding:12px;background:#fbfcff}
.stat .n{font-size:22px;font-weight:750;font-variant-numeric:tabular-nums}
.stat .l{font-size:12px;color:var(--muted);margin-top:2px}
table{width:100%;border-collapse:collapse;font-size:14px}
th{text-align:left;color:var(--muted);font-weight:700;border-bottom:1px solid var(--line);padding:10px 8px}
td{border-bottom:1px solid #edf1f6;padding:10px 8px;vertical-align:top}
tr:hover td{background:#fbfcff}
.title{font-weight:650;max-width:360px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.meta{font-size:12px;color:var(--muted);word-break:break-all;margin-top:2px}
.tag{display:inline-flex;align-items:center;min-height:24px;border-radius:999px;padding:2px 8px;font-size:12px;border:1px solid var(--line);background:#fff;color:var(--muted)}
.tag.warn{border-color:rgba(161,92,0,.28);color:var(--warn);background:#fff8ec}
.tag.ok{border-color:rgba(35,122,59,.28);color:var(--ok);background:#effaf2}
.row-actions{display:flex;gap:8px;justify-content:flex-end}
.empty{padding:34px;text-align:center;color:var(--muted);border:1px dashed var(--line);border-radius:8px}
.message{min-height:22px;font-size:13px;color:var(--muted);margin-top:10px}
.error{color:var(--danger)}.success{color:var(--ok)}
.hidden{display:none}
@media (max-width:820px){
  .top{display:block}.login,.stats{grid-template-columns:1fr}.toolbar input{max-width:none}
  table,thead,tbody,tr,th,td{display:block}
  thead{display:none}
  tr{border:1px solid var(--line);border-radius:8px;margin-bottom:10px;background:#fff}
  td{border:0;padding:8px 10px}.row-actions{justify-content:flex-start}
}
</style>
</head>
<body>
<main class="shell">
  <div class="top">
    <div>
      <h1>Codex Session Sync</h1>
      <div class="sub" id="health">Checking server</div>
    </div>
    <span class="badge" id="loginState">Signed out</span>
  </div>

  <section class="panel" id="loginPanel">
    <div class="login">
      <div>
        <label for="username">账号</label>
        <input id="username" autocomplete="username" value="admin">
      </div>
      <div>
        <label for="password">密码</label>
        <input id="password" type="password" autocomplete="current-password">
      </div>
      <button class="primary" id="loginBtn">登录</button>
    </div>
    <div class="message" id="loginMessage"></div>
  </section>

  <section class="panel hidden" id="sessionsPanel">
    <div class="stats">
      <div class="stat"><div class="n" id="statTotal">0</div><div class="l">会话</div></div>
      <div class="stat"><div class="n" id="statArchived">0</div><div class="l">已归档</div></div>
      <div class="stat"><div class="n" id="statConflicts">0</div><div class="l">冲突</div></div>
      <div class="stat"><div class="n" id="statRevisions">0</div><div class="l">版本</div></div>
    </div>
    <div class="toolbar">
      <input id="search" placeholder="搜索标题、ID、Provider、路径">
      <button id="refreshBtn">刷新</button>
      <button class="danger" id="deleteSelectedBtn" disabled>删除选中</button>
      <button id="logoutBtn">退出</button>
    </div>
    <div id="sessionContent" class="empty">No sessions</div>
    <div class="message" id="sessionMessage"></div>
  </section>
</main>
<script>
const tokenKey = 'codexSessionSyncToken';
let token = localStorage.getItem(tokenKey) || '';
let sessions = [];
let selected = new Set();

function $(id){ return document.getElementById(id); }
function setMessage(id, text, cls = '') {
  const el = $(id);
  el.textContent = text;
  el.className = 'message ' + cls;
}
function authHeaders() {
  return token ? { Authorization: 'Bearer ' + token } : {};
}
async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders(),
      ...(options.headers || {})
    }
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'HTTP ' + res.status);
  return data;
}
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
}
function formatTime(value) {
  if (!value) return '-';
  const n = Number(value);
  const d = Number.isFinite(n) && String(value).length <= 10 ? new Date(n * 1000) : new Date(value);
  return Number.isNaN(d.getTime()) ? '-' : d.toLocaleString();
}
function formatBytes(value) {
  const n = Number(value || 0);
  if (!n) return '-';
  const units = ['B','KB','MB','GB'];
  let v = n, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return i === 0 ? n + ' B' : v.toFixed(v >= 10 ? 1 : 2) + ' ' + units[i];
}
function updateShell() {
  $('loginState').textContent = token ? 'Signed in' : 'Signed out';
  $('sessionsPanel').classList.toggle('hidden', !token);
}
async function checkHealth() {
  try {
    const data = await api('/api/health', { headers: {} });
    $('health').textContent = data.name + ' · ' + new Date(data.time).toLocaleString();
  } catch {
    $('health').textContent = 'Server unavailable';
  }
}
async function login() {
  $('loginBtn').disabled = true;
  setMessage('loginMessage', 'Signing in');
  try {
    const data = await api('/api/login', {
      method: 'POST',
      body: JSON.stringify({ username: $('username').value || 'admin', password: $('password').value })
    });
    token = data.token;
    localStorage.setItem(tokenKey, token);
    $('password').value = '';
    setMessage('loginMessage', 'Signed in', 'success');
    updateShell();
    await loadSessions();
  } catch (error) {
    setMessage('loginMessage', error.message, 'error');
  } finally {
    $('loginBtn').disabled = false;
  }
}
function filteredSessions() {
  const q = $('search').value.trim().toLowerCase();
  if (!q) return sessions;
  return sessions.filter(s => [s.id, s.title, s.model_provider, s.cwd, s.rollout_relative_path]
    .filter(Boolean).some(v => String(v).toLowerCase().includes(q)));
}
function renderStats() {
  $('statTotal').textContent = sessions.length;
  $('statArchived').textContent = sessions.filter(s => s.archived).length;
  $('statConflicts').textContent = sessions.filter(s => s.conflict).length;
  $('statRevisions').textContent = sessions.reduce((sum, s) => sum + Number(s.revision_count || 0), 0);
}
function renderSessions() {
  renderStats();
  const list = filteredSessions();
  $('deleteSelectedBtn').disabled = selected.size === 0;
  if (!list.length) {
    $('sessionContent').className = 'empty';
    $('sessionContent').innerHTML = 'No sessions';
    return;
  }
  $('sessionContent').className = '';
  const rows = list.map(s => {
    const checked = selected.has(s.id) ? 'checked' : '';
    const tags = [
      s.conflict ? '<span class="tag warn">冲突</span>' : '',
      s.archived ? '<span class="tag">归档</span>' : '<span class="tag ok">活动</span>'
    ].join('');
    return '<tr>' +
      '<td><input type="checkbox" data-id="' + escapeHtml(s.id) + '" ' + checked + '></td>' +
      '<td><div class="title">' + escapeHtml(s.title || s.first_user_message || '(untitled)') + '</div><div class="meta">' + escapeHtml(s.id) + '</div></td>' +
      '<td><span class="tag">' + escapeHtml(s.model_provider || '(missing)') + '</span></td>' +
      '<td><div>' + formatTime(s.updated_at || s.updated_at_remote) + '</div><div class="meta">' + escapeHtml(s.device_id || '') + '</div></td>' +
      '<td><div>' + formatBytes(s.rollout_size) + '</div><div class="meta">' + escapeHtml(s.rollout_relative_path || '') + '</div></td>' +
      '<td>' + tags + '</td>' +
      '<td><div class="row-actions"><button class="danger" data-delete="' + escapeHtml(s.id) + '">删除</button></div></td>' +
    '</tr>';
  }).join('');
  $('sessionContent').innerHTML = '<table><thead><tr><th></th><th>会话</th><th>Provider</th><th>时间</th><th>Rollout</th><th>状态</th><th></th></tr></thead><tbody>' + rows + '</tbody></table>';
  $('sessionContent').querySelectorAll('input[type=checkbox]').forEach(input => {
    input.addEventListener('change', () => {
      if (input.checked) selected.add(input.dataset.id); else selected.delete(input.dataset.id);
      renderSessions();
    });
  });
  $('sessionContent').querySelectorAll('button[data-delete]').forEach(button => {
    button.addEventListener('click', () => deleteIds([button.dataset.delete]));
  });
}
async function loadSessions() {
  if (!token) return;
  setMessage('sessionMessage', 'Loading');
  try {
    const data = await api('/api/remote-sessions');
    sessions = data.sessions || [];
    selected.clear();
    renderSessions();
    setMessage('sessionMessage', 'Loaded ' + sessions.length + ' session(s)', 'success');
  } catch (error) {
    if (error.message === 'Unauthorized') {
      token = '';
      localStorage.removeItem(tokenKey);
      updateShell();
    }
    setMessage('sessionMessage', error.message, 'error');
  }
}
async function deleteIds(ids) {
  if (!ids.length || !confirm('删除 ' + ids.length + ' 个远端会话？')) return;
  setMessage('sessionMessage', 'Deleting');
  try {
    for (const id of ids) {
      await api('/api/remote-sessions/' + encodeURIComponent(id), { method: 'DELETE' });
      selected.delete(id);
    }
    await loadSessions();
  } catch (error) {
    setMessage('sessionMessage', error.message, 'error');
  }
}
$('loginBtn').addEventListener('click', login);
$('password').addEventListener('keydown', event => { if (event.key === 'Enter') login(); });
$('refreshBtn').addEventListener('click', loadSessions);
$('search').addEventListener('input', renderSessions);
$('deleteSelectedBtn').addEventListener('click', () => deleteIds([...selected]));
$('logoutBtn').addEventListener('click', () => {
  token = '';
  localStorage.removeItem(tokenKey);
  sessions = [];
  selected.clear();
  updateShell();
  renderSessions();
});
checkHealth();
updateShell();
if (token) loadSessions();
</script>
</body>
</html>`;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function hashPassword(password, saltHex, iterations = PASSWORD_ITERATIONS) {
  return crypto.pbkdf2Sync(password, Buffer.from(saltHex, "hex"), iterations, 32, "sha256").toString("hex");
}

function makePasswordRecord(password) {
  const saltHex = crypto.randomBytes(16).toString("hex");
  return {
    saltHex,
    hashHex: hashPassword(password, saltHex),
    iterations: PASSWORD_ITERATIONS
  };
}

function safeJsonParse(value, fallback) {
  if (!value) {
    return fallback;
  }
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function createDb(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password_salt TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      password_iterations INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS auth_tokens (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_seen_at TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS devices (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      platform TEXT,
      hostname TEXT,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS remote_sessions (
      id TEXT PRIMARY KEY,
      title TEXT,
      model_provider TEXT,
      cwd TEXT,
      archived INTEGER NOT NULL DEFAULT 0,
      source TEXT,
      model TEXT,
      first_user_message TEXT,
      created_at INTEGER,
      updated_at INTEGER,
      latest_revision_id TEXT,
      conflict INTEGER NOT NULL DEFAULT 0,
      created_at_remote TEXT NOT NULL,
      updated_at_remote TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS remote_session_revisions (
      revision_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      hash TEXT NOT NULL,
      size INTEGER NOT NULL,
      object_path TEXT NOT NULL,
      rollout_relative_path TEXT NOT NULL,
      rollout_directory TEXT NOT NULL,
      thread_json TEXT NOT NULL,
      session_meta_json TEXT,
      device_id TEXT,
      uploaded_at TEXT NOT NULL,
      is_conflict INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (session_id) REFERENCES remote_sessions(id) ON DELETE CASCADE
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_remote_session_revisions_hash
      ON remote_session_revisions(session_id, hash);

    CREATE TABLE IF NOT EXISTS remote_thread_edges (
      parent_thread_id TEXT NOT NULL,
      child_thread_id TEXT NOT NULL,
      status TEXT,
      edge_json TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (parent_thread_id, child_thread_id)
    );
  `);
  return db;
}

function ensureAdminUser(db, { adminUser, adminPassword }) {
  const existing = db.prepare("SELECT COUNT(*) AS count FROM users").get();
  if (existing.count > 0) {
    return;
  }
  if (!adminPassword) {
    throw new Error("Missing initial admin password. Set CODEX_SYNC_ADMIN_PASSWORD or pass adminPassword.");
  }
  const password = makePasswordRecord(adminPassword);
  db.prepare(`
    INSERT INTO users (id, username, password_salt, password_hash, password_iterations, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    crypto.randomUUID(),
    adminUser || "admin",
    password.saltHex,
    password.hashHex,
    password.iterations,
    new Date().toISOString()
  );
}

function verifyPassword(user, password) {
  const candidate = hashPassword(password, user.password_salt, user.password_iterations);
  return crypto.timingSafeEqual(Buffer.from(candidate, "hex"), Buffer.from(user.password_hash, "hex"));
}

function createToken(db, userId) {
  const token = crypto.randomBytes(TOKEN_BYTES).toString("base64url");
  db.prepare(`
    INSERT INTO auth_tokens (token_hash, user_id, created_at, last_seen_at)
    VALUES (?, ?, ?, ?)
  `).run(sha256(token), userId, new Date().toISOString(), new Date().toISOString());
  return token;
}

function authenticate(db, req) {
  const header = req.headers.authorization ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) {
    return null;
  }
  const tokenHash = sha256(match[1]);
  const row = db.prepare(`
    SELECT users.id, users.username
    FROM auth_tokens
    JOIN users ON users.id = auth_tokens.user_id
    WHERE auth_tokens.token_hash = ?
  `).get(tokenHash);
  if (!row) {
    return null;
  }
  db.prepare("UPDATE auth_tokens SET last_seen_at = ? WHERE token_hash = ?")
    .run(new Date().toISOString(), tokenHash);
  return row;
}

function requireAuth(db, req) {
  const user = authenticate(db, req);
  if (!user) {
    const error = new Error("Unauthorized");
    error.status = 401;
    throw error;
  }
  return user;
}

function upsertDevice(db, rawDevice = {}) {
  const device = {
    id: rawDevice.id || "unknown-device",
    name: rawDevice.name || rawDevice.hostname || rawDevice.id || "Unknown device",
    platform: rawDevice.platform || null,
    hostname: rawDevice.hostname || null
  };
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO devices (id, name, platform, hostname, first_seen_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      platform = excluded.platform,
      hostname = excluded.hostname,
      last_seen_at = excluded.last_seen_at
  `).run(device.id, device.name, device.platform, device.hostname, now, now);
  return device;
}

function objectRelativePath(hash) {
  return path.join("objects", hash.slice(0, 2), `${hash}.jsonl`);
}

async function writeObject(dataDir, hash, content) {
  const relativePath = objectRelativePath(hash);
  const fullPath = path.join(dataDir, relativePath);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  try {
    await fs.access(fullPath);
  } catch {
    await fs.writeFile(fullPath, content, "utf8");
  }
  return relativePath;
}

function sessionSummaryFromUpload(session, revisionId, conflict, now) {
  const row = session.threadRow ?? {};
  const meta = session.sessionMeta?.payload ?? {};
  return {
    id: session.id,
    title: row.title ?? meta.title ?? row.first_user_message ?? "",
    model_provider: row.model_provider ?? meta.model_provider ?? "",
    cwd: row.cwd ?? meta.cwd ?? "",
    archived: Number(row.archived ?? (session.rollout?.directory === "archived_sessions" ? 1 : 0)) ? 1 : 0,
    source: row.source ?? meta.source ?? "",
    model: row.model ?? meta.model ?? "",
    first_user_message: row.first_user_message ?? "",
    created_at: row.created_at ?? null,
    updated_at: row.updated_at ?? row.created_at ?? null,
    latest_revision_id: revisionId,
    conflict: conflict ? 1 : 0,
    now
  };
}

function upsertSessionRow(db, summary) {
  db.prepare(`
    INSERT INTO remote_sessions (
      id, title, model_provider, cwd, archived, source, model, first_user_message,
      created_at, updated_at, latest_revision_id, conflict, created_at_remote, updated_at_remote
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      title = excluded.title,
      model_provider = excluded.model_provider,
      cwd = excluded.cwd,
      archived = excluded.archived,
      source = excluded.source,
      model = excluded.model,
      first_user_message = excluded.first_user_message,
      created_at = excluded.created_at,
      updated_at = excluded.updated_at,
      latest_revision_id = excluded.latest_revision_id,
      conflict = CASE WHEN remote_sessions.conflict = 1 OR excluded.conflict = 1 THEN 1 ELSE 0 END,
      updated_at_remote = excluded.updated_at_remote
  `).run(
    summary.id,
    summary.title,
    summary.model_provider,
    summary.cwd,
    summary.archived,
    summary.source,
    summary.model,
    summary.first_user_message,
    summary.created_at,
    summary.updated_at,
    summary.latest_revision_id,
    summary.conflict,
    summary.now,
    summary.now
  );
}

function insertEdges(db, edges = []) {
  const now = new Date().toISOString();
  let count = 0;
  for (const edge of edges) {
    if (!edge?.parent_thread_id || !edge?.child_thread_id) {
      continue;
    }
    db.prepare(`
      INSERT INTO remote_thread_edges (parent_thread_id, child_thread_id, status, edge_json, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(parent_thread_id, child_thread_id) DO UPDATE SET
        status = excluded.status,
        edge_json = excluded.edge_json,
        updated_at = excluded.updated_at
    `).run(
      edge.parent_thread_id,
      edge.child_thread_id,
      edge.status ?? null,
      JSON.stringify(edge),
      now
    );
    count += 1;
  }
  return count;
}

async function handleLogin(db, req, res) {
  const body = await readBody(req);
  const user = db.prepare("SELECT * FROM users WHERE username = ?").get(body.username || "admin");
  if (!user || !body.password || !verifyPassword(user, body.password)) {
    return json(res, { error: "Invalid username or password." }, 401);
  }
  if (body.device) {
    upsertDevice(db, body.device);
  }
  const token = createToken(db, user.id);
  return json(res, {
    token,
    user: { id: user.id, username: user.username },
    serverTime: new Date().toISOString()
  });
}

function listRemoteSessions(db) {
  return db.prepare(`
    SELECT
      s.id, s.title, s.model_provider, s.cwd, s.archived, s.source, s.model,
      s.first_user_message, s.created_at, s.updated_at, s.conflict,
      s.created_at_remote, s.updated_at_remote,
      r.revision_id, r.hash AS rollout_hash, r.size AS rollout_size,
      r.rollout_relative_path, r.rollout_directory, r.device_id, r.uploaded_at,
      (SELECT COUNT(*) FROM remote_session_revisions rr WHERE rr.session_id = s.id) AS revision_count
    FROM remote_sessions s
    LEFT JOIN remote_session_revisions r ON r.revision_id = s.latest_revision_id
    ORDER BY COALESCE(s.updated_at, 0) DESC, s.updated_at_remote DESC
  `).all().map((row) => ({ ...row }));
}

async function handleUpload(db, dataDir, req, res) {
  requireAuth(db, req);
  const body = await readBody(req);
  const device = upsertDevice(db, body.device);
  const sessions = Array.isArray(body.sessions) ? body.sessions : [];
  const uploaded = [];
  const skippedSameHash = [];
  const conflicts = [];
  const now = new Date().toISOString();

  db.exec("BEGIN IMMEDIATE");
  try {
    for (const session of sessions) {
      if (!session?.id || typeof session.rollout?.content !== "string") {
        continue;
      }
      const hash = sha256(session.rollout.content);
      const existingRevision = db.prepare(`
        SELECT revision_id FROM remote_session_revisions
        WHERE session_id = ? AND hash = ?
      `).get(session.id, hash);
      if (existingRevision) {
        skippedSameHash.push(session.id);
        continue;
      }

      const objectPath = await writeObject(dataDir, hash, session.rollout.content);
      const latest = db.prepare(`
        SELECT r.hash
        FROM remote_sessions s
        LEFT JOIN remote_session_revisions r ON r.revision_id = s.latest_revision_id
        WHERE s.id = ?
      `).get(session.id);
      const conflict = Boolean(latest?.hash && latest.hash !== hash);
      const revisionId = crypto.randomUUID();

      db.prepare(`
        INSERT OR IGNORE INTO remote_sessions (id, created_at_remote, updated_at_remote)
        VALUES (?, ?, ?)
      `).run(session.id, now, now);

      db.prepare(`
        INSERT INTO remote_session_revisions (
          revision_id, session_id, hash, size, object_path, rollout_relative_path,
          rollout_directory, thread_json, session_meta_json, device_id, uploaded_at, is_conflict
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        revisionId,
        session.id,
        hash,
        Buffer.byteLength(session.rollout.content, "utf8"),
        objectPath,
        session.rollout.relativePath || session.threadRow?.rollout_path || "",
        session.rollout.directory || "sessions",
        JSON.stringify(session.threadRow ?? { id: session.id }),
        JSON.stringify(session.sessionMeta ?? null),
        device.id,
        now,
        conflict ? 1 : 0
      );
      upsertSessionRow(db, sessionSummaryFromUpload(session, revisionId, conflict, now));
      uploaded.push(session.id);
      if (conflict) {
        conflicts.push(session.id);
      }
    }
    const edgeCount = insertEdges(db, body.edges);
    db.exec("COMMIT");
    return json(res, {
      uploaded: uploaded.length,
      uploadedIds: uploaded,
      skippedSameHash,
      conflicts,
      edgeCount
    });
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Surface the original error.
    }
    throw error;
  }
}

function selectedRemoteIds(db, body) {
  if (body.all) {
    return db.prepare("SELECT id FROM remote_sessions ORDER BY id").all().map((row) => row.id);
  }
  return [...new Set(Array.isArray(body.ids) ? body.ids : [])].filter(Boolean);
}

async function handlePullBundle(db, dataDir, req, res) {
  requireAuth(db, req);
  const body = await readBody(req);
  const ids = selectedRemoteIds(db, body);
  const sessions = [];
  for (const id of ids) {
    const row = db.prepare(`
      SELECT s.id, r.hash, r.size, r.object_path, r.rollout_relative_path,
             r.rollout_directory, r.thread_json, r.session_meta_json
      FROM remote_sessions s
      JOIN remote_session_revisions r ON r.revision_id = s.latest_revision_id
      WHERE s.id = ?
    `).get(id);
    if (!row) {
      continue;
    }
    const content = await fs.readFile(path.join(dataDir, row.object_path), "utf8");
    sessions.push({
      id: row.id,
      threadRow: safeJsonParse(row.thread_json, { id: row.id }),
      sessionMeta: safeJsonParse(row.session_meta_json, null),
      rollout: {
        relativePath: row.rollout_relative_path,
        directory: row.rollout_directory,
        hash: row.hash,
        size: row.size,
        content
      }
    });
  }

  const idSet = new Set(sessions.map((session) => session.id));
  const edges = db.prepare("SELECT edge_json FROM remote_thread_edges").all()
    .map((row) => safeJsonParse(row.edge_json, null))
    .filter((edge) => edge && (idSet.has(edge.parent_thread_id) || idSet.has(edge.child_thread_id)));

  return json(res, {
    version: 1,
    sessions,
    edges
  });
}

function handleDeleteSession(db, req, res, id) {
  requireAuth(db, req);
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("DELETE FROM remote_sessions WHERE id = ?").run(id);
    db.prepare("DELETE FROM remote_thread_edges WHERE parent_thread_id = ? OR child_thread_id = ?").run(id, id);
    db.exec("COMMIT");
    return json(res, { deletedId: id });
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Surface the original error.
    }
    throw error;
  }
}

async function handleApi(db, dataDir, req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization"
    });
    return res.end();
  }
  if (url.pathname === "/api/health" && req.method === "GET") {
    return json(res, { ok: true, name: "codex-session-sync", time: new Date().toISOString() });
  }
  if (url.pathname === "/api/login" && req.method === "POST") {
    return await handleLogin(db, req, res);
  }
  if (url.pathname === "/api/remote-sessions" && req.method === "GET") {
    requireAuth(db, req);
    return json(res, { sessions: listRemoteSessions(db) });
  }
  if (url.pathname === "/api/remote-sessions/upload" && req.method === "POST") {
    return await handleUpload(db, dataDir, req, res);
  }
  if (url.pathname === "/api/remote-sessions/pull-bundle" && req.method === "POST") {
    return await handlePullBundle(db, dataDir, req, res);
  }
  const deleteMatch = /^\/api\/remote-sessions\/([^/]+)$/.exec(url.pathname);
  if (deleteMatch && req.method === "DELETE") {
    return handleDeleteSession(db, req, res, decodeURIComponent(deleteMatch[1]));
  }
  res.writeHead(404);
  res.end("Not found");
}

export async function startCloudServer({
  host = "127.0.0.1",
  port = 8787,
  dataDir = process.env.CODEX_SYNC_DATA_DIR || path.resolve("data"),
  adminUser = process.env.CODEX_SYNC_ADMIN_USER || "admin",
  adminPassword = process.env.CODEX_SYNC_ADMIN_PASSWORD
} = {}) {
  await fs.mkdir(dataDir, { recursive: true });
  const db = createDb(path.join(dataDir, "cloud.sqlite"));
  ensureAdminUser(db, { adminUser, adminPassword });

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (url.pathname === "/" && req.method === "GET") {
        return html(res, serverAdminHtml());
      }
      if (url.pathname.startsWith("/api/")) {
        return await handleApi(db, dataDir, req, res);
      }
      res.writeHead(404);
      res.end("Not found");
    } catch (error) {
      json(res, { error: error.message }, error.status || 500);
    }
  });

  server.once("close", () => db.close());

  return await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      const address = server.address();
      const actualPort = typeof address === "object" ? address.port : port;
      resolve({
        server,
        url: `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${actualPort}`,
        port: actualPort,
        dataDir
      });
    });
  });
}
