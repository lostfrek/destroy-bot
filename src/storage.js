const fs = require("node:fs");
const path = require("node:path");
const mysql = require("mysql2/promise");

const ROOT = path.join(__dirname, "..");

const state = {
  applications: {},
  botInfo: {},
  captReplayWindow: { isOpen: false, openedAt: null, openedBy: null, threadId: null, openCount: 0, threadHistory: [] },
  ranks: {},
  supportTickets: {},
  users: {},
  warnings: {}
};

let pool;
let writeQueue = Promise.resolve();
let reloadQueue = Promise.resolve();
let lastWriteError = null;

function mysqlDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? date.toISOString().slice(0, 23).replace("T", " ")
    : null;
}

function isoDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function json(value) {
  return JSON.stringify(value ?? {});
}

function parseJsonArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function queueWrite(label, operation) {
  const operationPromise = writeQueue.catch(() => null).then(operation);
  writeQueue = operationPromise.then(
    () => {
      lastWriteError = null;
    },
    (error) => {
      lastWriteError = error;
      console.error(`MySQL write failed (${label}):`, error);
    }
  );
  return operationPromise;
}

async function replaceRows(table, insertRows, where = null) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    if (where) {
      await connection.query(`DELETE FROM \`${table}\` WHERE ${where.sql}`, where.params);
    } else {
      await connection.query(`DELETE FROM \`${table}\``);
    }
    await insertRows(connection);
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

async function initStorage() {
  const required = ["MYSQL_HOST", "MYSQL_USER", "MYSQL_PASSWORD", "MYSQL_DBNAME"];
  const missing = required.filter((name) => !process.env[name]);
  if (missing.length) throw new Error(`Не заданы переменные MySQL: ${missing.join(", ")}`);

  // TLS is required and pinned to a specific CA (e.g. the Timeweb Cloud MySQL cert) only when
  // MYSQL_SSL_CA_PATH is explicitly set. Providers reachable only over a private/internal network
  // (e.g. Railway's <service>.railway.internal) neither offer nor need that — leave it unset there.
  const sslCaPath = process.env.MYSQL_SSL_CA_PATH
    ? path.resolve(ROOT, process.env.MYSQL_SSL_CA_PATH)
    : null;
  if (sslCaPath && !fs.existsSync(sslCaPath)) {
    throw new Error(`Не найден TLS-сертификат: ${sslCaPath}`);
  }

  const poolOptions = {
      host: process.env.MYSQL_HOST,
      port: Number(process.env.MYSQL_PORT || 3306),
      user: process.env.MYSQL_USER,
      password: process.env.MYSQL_PASSWORD,
      database: process.env.MYSQL_DBNAME,
      charset: "utf8mb4",
      waitForConnections: true,
      connectionLimit: 5,
      connectTimeout: 15000,
      ...(sslCaPath
        ? { ssl: { ca: fs.readFileSync(sslCaPath, "utf8"), rejectUnauthorized: true } }
        : {})
    };
  const retryDelays = [0, 2000, 5000, 10000, 20000];
  let tls;
  let lastError;
  for (let attempt = 0; attempt < retryDelays.length; attempt += 1) {
    if (retryDelays[attempt]) {
      console.warn(`MySQL недоступна, повторное подключение через ${retryDelays[attempt] / 1000} сек.`);
      await new Promise((resolve) => setTimeout(resolve, retryDelays[attempt]));
    }
    pool = mysql.createPool(poolOptions);
    try {
      [[tls]] = await pool.query("SHOW STATUS LIKE 'Ssl_cipher'");
      lastError = null;
      break;
    } catch (error) {
      lastError = error;
      await pool.end().catch(() => null);
      pool = null;
    }
  }
  if (lastError) throw lastError;
  if (sslCaPath && !tls?.Value) throw new Error("MySQL-соединение установлено без TLS");
  resetState();
  await loadState();
  console.log(tls?.Value ? `MySQL storage connected with TLS (${tls.Value}).` : "MySQL storage connected (private network, no TLS).");
}

function resetState() {
  state.applications = {};
  state.botInfo = {};
  state.captReplayWindow = { isOpen: false, openedAt: null, openedBy: null, threadId: null, openCount: 0, threadHistory: [] };
  state.ranks = {};
  state.supportTickets = {};
  state.users = {};
  state.warnings = {};
}

function reloadStorage() {
  const reload = reloadQueue.catch(() => null).then(async () => {
    await flushStorage();
    resetState();
    await loadState();
  });
  reloadQueue = reload.catch(() => null);
  return reload;
}

async function loadState() {
  const [recruitmentRows] = await pool.query(
    "SELECT id, section, recruitment_open, updated_at FROM recruitment_settings ORDER BY id"
  );
  const captSettings = recruitmentRows.find((row) => row.id === 1 || String(row.section).toLowerCase() === "capt");
  const rpSettings = recruitmentRows.find((row) => row.id === 2 || String(row.section).toLowerCase() === "rp");
  state.botInfo = {
    captRecruitmentOpen: Boolean(captSettings?.recruitment_open),
    rpRecruitmentOpen: Boolean(rpSettings?.recruitment_open),
    captUpdatedAt: isoDate(captSettings?.updated_at),
    rpUpdatedAt: isoDate(rpSettings?.updated_at)
  };

  const [captReplayRows] = await pool.query(
    "SELECT is_open, opened_at, opened_by, thread_id, open_count, thread_history FROM capt_replay_window WHERE id = 1"
  );
  state.captReplayWindow = {
    isOpen: Boolean(captReplayRows[0]?.is_open),
    openedAt: isoDate(captReplayRows[0]?.opened_at),
    openedBy: captReplayRows[0]?.opened_by ?? null,
    threadId: captReplayRows[0]?.thread_id ?? null,
    openCount: Number(captReplayRows[0]?.open_count ?? 0),
    threadHistory: parseJsonArray(captReplayRows[0]?.thread_history)
  };

  const [users] = await pool.query("SELECT * FROM users");
  for (const row of users) {
    state.users[row.discord_id] = { dmNotifications: Boolean(row.dm_notifications) };
  }

  // rank_logs and warning_logs are merged into one user_logs table, discriminated
  // by log_type — both are the same shape (who, when, which admin, why), just
  // with a few type-specific columns left null on the other type's rows.
  const [logRows] = await pool.query("SELECT * FROM user_logs ORDER BY created_at, id");
  for (const row of logRows) {
    if (row.log_type === "rank") {
      state.ranks[row.user_id] ??= [];
      state.ranks[row.user_id].push({
        oldRank: row.old_rank == null ? null : Number(row.old_rank),
        newRank: row.new_rank == null ? null : Number(row.new_rank),
        adminId: row.administrator_id ?? "system",
        reason: row.reason,
        createdAt: isoDate(row.created_at)
      });
    } else if (row.log_type === "warn") {
      state.warnings[row.user_id] ??= { active: [], history: [] };
      const action = row.warn_action === "issued" ? "add" : "remove";
      state.warnings[row.user_id].history.push({
        action,
        adminId: row.administrator_id ?? "system",
        reason: row.reason,
        warnReason: row.warning_reason,
        createdAt: isoDate(row.created_at)
      });
      if (row.is_active) {
        state.warnings[row.user_id].active.push({
          reason: row.warning_reason,
          issuedBy: row.administrator_id ?? "system",
          issuedAt: isoDate(row.created_at)
        });
      }
    }
  }

  const [ticketRows] = await pool.query("SELECT * FROM tickets ORDER BY created_at, id");
  for (const row of ticketRows) {
    if (row.category === "application") {
      state.applications[row.ticket_key] = {
        userId: row.user_id,
        uid: row.uid,
        status: row.status,
        characterInfo: [row.ic_name, row.character_level, row.character_static_id]
          .filter((part) => part !== null && part !== undefined && part !== "")
          .join(" / "),
        captRole: row.capt_role,
        oocAge: row.ooc_age,
        reason: row.details,
        requestType: row.request_type,
        claimedBy: row.claimed_by,
        closedBy: row.decided_by,
        decisionReason: row.decision_reason,
        channelId: row.channel_id,
        messageId: row.message_id,
        announcementChannelId: row.announcement_channel_id,
        announcementMessageId: row.announcement_message_id,
        createdAt: isoDate(row.created_at),
        updatedAt: isoDate(row.updated_at),
        closedAt: isoDate(row.closed_at)
      };
    } else if (row.category === "support") {
      state.supportTickets[row.ticket_key] = {
        id: row.ticket_key,
        uid: row.uid,
        userId: row.user_id,
        status: row.status,
        requestType: row.request_type,
        details: row.details,
        claimedBy: row.claimed_by,
        closedBy: row.decided_by,
        decisionReason: row.decision_reason,
        channelId: row.channel_id,
        messageId: row.message_id,
        createdAt: isoDate(row.created_at),
        updatedAt: isoDate(row.updated_at),
        closedAt: isoDate(row.closed_at)
      };
    }
  }
}

function getWarnings() { return state.warnings; }
function getBotInfo() { return state.botInfo; }
function getCaptReplayWindow() { return state.captReplayWindow; }
function getApplications() { return state.applications; }
function getUserDb() { return state.users; }
function getRankHistory() { return state.ranks; }
function getSupportTickets() { return state.supportTickets; }

async function getActiveGameAfkSessions() {
  const [rows] = await pool.query(
    `SELECT user_id, reason, started_at, expires_at
     FROM afk_sessions
     WHERE expires_at > CURRENT_TIMESTAMP(3)
     ORDER BY expires_at, started_at`
  );
  return rows.map((row) => ({
    userId: row.user_id,
    reason: row.reason,
    startedAt: isoDate(row.started_at),
    expiresAt: isoDate(row.expires_at)
  }));
}

async function getGameAfkSession(userId) {
  const [rows] = await pool.execute(
    `SELECT user_id, reason, started_at, expires_at
     FROM afk_sessions WHERE user_id = ? LIMIT 1`,
    [String(userId)]
  );
  const row = rows[0];
  return row ? {
    userId: row.user_id,
    reason: row.reason,
    startedAt: isoDate(row.started_at),
    expiresAt: isoDate(row.expires_at)
  } : null;
}

async function saveGameAfkSession({ userId, reason, startedAt, expiresAt }) {
  await pool.execute(
    `INSERT INTO afk_sessions (user_id, reason, started_at, expires_at, updated_at)
     VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP(3))
     ON DUPLICATE KEY UPDATE reason = VALUES(reason),
       started_at = VALUES(started_at), expires_at = VALUES(expires_at),
       updated_at = CURRENT_TIMESTAMP(3)`,
    [String(userId), reason, mysqlDate(startedAt), mysqlDate(expiresAt)]
  );
}

async function removeGameAfkSession(userId) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [rows] = await connection.execute(
      `SELECT user_id, reason, started_at, expires_at
       FROM afk_sessions WHERE user_id = ? FOR UPDATE`,
      [String(userId)]
    );
    if (!rows.length) {
      await connection.commit();
      return null;
    }
    await connection.execute("DELETE FROM afk_sessions WHERE user_id = ?", [String(userId)]);
    await connection.commit();
    const row = rows[0];
    return {
      userId: row.user_id,
      reason: row.reason,
      startedAt: isoDate(row.started_at),
      expiresAt: isoDate(row.expires_at)
    };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

async function takeExpiredGameAfkSessions() {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [rows] = await connection.query(
      `SELECT user_id, reason, started_at, expires_at
       FROM afk_sessions
       WHERE expires_at <= CURRENT_TIMESTAMP(3)
       ORDER BY expires_at
       FOR UPDATE`
    );
    if (rows.length) {
      await connection.query(
        "DELETE FROM afk_sessions WHERE expires_at <= CURRENT_TIMESTAMP(3)"
      );
    }
    await connection.commit();
    return rows.map((row) => ({
      userId: row.user_id,
      reason: row.reason,
      startedAt: isoDate(row.started_at),
      expiresAt: isoDate(row.expires_at)
    }));
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

function saveBotInfo(info, section = "both") {
  state.botInfo = info;
  return queueWrite("recruitment settings", async () => {
    const updates = [];
    if (section === "capt" || section === "both") {
      updates.push([1, "Capt", Boolean(info.captRecruitmentOpen)]);
    }
    if (section === "rp" || section === "both") {
      updates.push([2, "RP", Boolean(info.rpRecruitmentOpen)]);
    }
    for (const [id, sectionName, open] of updates) {
      await pool.execute(
        `INSERT INTO recruitment_settings (id, section, recruitment_open, updated_at)
         VALUES (?, ?, ?, CURRENT_TIMESTAMP(3))
         ON DUPLICATE KEY UPDATE
           section = VALUES(section),
           recruitment_open = VALUES(recruitment_open),
           updated_at = CURRENT_TIMESTAMP(3)`,
        [id, sectionName, open]
      );
    }
  });
}

function saveCaptReplayWindow(window) {
  state.captReplayWindow = window;
  return queueWrite("capt replay window", async () => {
    await pool.execute(
      `INSERT INTO capt_replay_window (id, is_open, opened_at, opened_by, thread_id, open_count, thread_history, updated_at)
       VALUES (1, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP(3))
       ON DUPLICATE KEY UPDATE
         is_open = VALUES(is_open),
         opened_at = VALUES(opened_at),
         opened_by = VALUES(opened_by),
         thread_id = VALUES(thread_id),
         open_count = VALUES(open_count),
         thread_history = VALUES(thread_history),
         updated_at = CURRENT_TIMESTAMP(3)`,
      [
        Boolean(window.isOpen),
        mysqlDate(window.openedAt),
        window.openedBy ?? null,
        window.threadId ?? null,
        Number(window.openCount) || 0,
        json(window.threadHistory ?? [])
      ]
    );
  });
}

function saveUserDb(users) {
  state.users = users;
  return queueWrite("users", async () => {
    for (const [userId, user] of Object.entries(users)) {
      await pool.execute(
        `INSERT INTO users (discord_id, dm_notifications) VALUES (?, ?)
         ON DUPLICATE KEY UPDATE dm_notifications = VALUES(dm_notifications)`,
        [userId, user.dmNotifications !== false]
      );
    }
  });
}

function saveRankHistory(history) {
  state.ranks = history;
  return queueWrite("rank logs", () => replaceRows("user_logs", async (connection) => {
    for (const [userId, entries] of Object.entries(history)) {
      for (const entry of entries) {
        await connection.execute(
          `INSERT INTO user_logs
           (log_type, user_id, old_rank, new_rank, administrator_id, reason, created_at)
           VALUES ('rank', ?, ?, ?, ?, ?, ?)`,
          [userId,
            Number.isFinite(Number(entry.oldRank)) ? Number(entry.oldRank) : null,
            Number.isFinite(Number(entry.newRank)) ? Number(entry.newRank) : null,
            entry.adminId === "system" ? null : entry.adminId ?? null,
            entry.reason ?? null, mysqlDate(entry.createdAt)]
        );
      }
      const latest = entries.at(-1);
      if (latest) {
        await connection.execute(
          `UPDATE users SET current_rank = ? WHERE discord_id = ?`,
          [Number.isFinite(Number(latest.newRank)) ? Number(latest.newRank) : null, userId]
        );
      }
    }
  }, { sql: "log_type = ?", params: ["rank"] }));
}

function saveWarnings(warnings) {
  state.warnings = warnings;
  return queueWrite("warning logs", () => replaceRows("user_logs", async (connection) => {
    await connection.query("UPDATE users SET active_warnings = 0, total_warnings = 0");
    for (const [userId, record] of Object.entries(warnings)) {
      const active = record.active ?? [];
      const history = record.history ?? [];
      // Match "add" history entries to still-active warnings by their shared issuedAt/createdAt
      // timestamp rather than by position: active warnings are removed LIFO, so the most
      // recently *issued* entry in history is not always the one still active (e.g. warn ->
      // remove -> warn again). Matching by identity avoids dropping or duplicating rows.
      const activeTimestamps = new Set(active.map((warning) => warning.issuedAt).filter(Boolean));
      const matchedTimestamps = new Set();
      for (const entry of history) {
        const issued = entry.action === "add";
        const isStillActive = issued &&
          entry.createdAt &&
          activeTimestamps.has(entry.createdAt) &&
          !matchedTimestamps.has(entry.createdAt);
        if (isStillActive) matchedTimestamps.add(entry.createdAt);
        await connection.execute(
          `INSERT INTO user_logs
           (log_type, user_id, warn_action, warning_reason, reason, administrator_id, is_active, created_at)
           VALUES ('warn', ?, ?, ?, ?, ?, ?, ?)`,
          [userId, issued ? "issued" : "removed", entry.warnReason ?? entry.reason ?? null,
            entry.reason ?? null, entry.adminId === "system" ? null : entry.adminId ?? null,
            isStillActive, mysqlDate(entry.createdAt)]
        );
      }
      // Active warnings without a matching history "add" entry (e.g. synced from Discord roles,
      // which are never logged to history) still need their own row.
      for (const warning of active) {
        if (warning.issuedAt && matchedTimestamps.has(warning.issuedAt)) continue;
        await connection.execute(
          `INSERT INTO user_logs
           (log_type, user_id, warn_action, warning_reason, reason, administrator_id, is_active, created_at)
           VALUES ('warn', ?, 'issued', ?, ?, ?, TRUE, ?)`,
          [userId, warning.reason ?? null, warning.reason ?? null,
            warning.issuedBy === "system" ? null : warning.issuedBy ?? null,
            mysqlDate(warning.issuedAt)]
        );
      }
      await connection.execute(
        `UPDATE users SET active_warnings = ?, total_warnings = ? WHERE discord_id = ?`,
        [active.length, history.filter((entry) => entry.action === "add").length, userId]
      );
    }
  }, { sql: "log_type = ?", params: ["warn"] }));
}

async function syncUserProfile(userId, profile) {
  state.users[userId] ??= { dmNotifications: true };
  await pool.execute(
    `INSERT INTO users (discord_id, username, current_rank)
     VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE username = VALUES(username),
       current_rank = VALUES(current_rank),
       updated_at = users.updated_at`,
    [userId, profile.username ?? null, profile.currentRank ?? null]
  );
}

async function deleteUserProfile(userId) {
  const normalizedUserId = String(userId);
  await flushStorage();
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    await connection.execute("DELETE FROM user_logs WHERE user_id = ?", [normalizedUserId]);
    await connection.execute("DELETE FROM tickets WHERE user_id = ?", [normalizedUserId]);
    await connection.execute("DELETE FROM afk_sessions WHERE user_id = ?", [normalizedUserId]);
    await connection.execute("DELETE FROM users WHERE discord_id = ?", [normalizedUserId]);
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }

  delete state.users[normalizedUserId];
  delete state.ranks[normalizedUserId];
  delete state.warnings[normalizedUserId];
  for (const [key, application] of Object.entries(state.applications)) {
    if (application.userId === normalizedUserId) delete state.applications[key];
  }
  for (const [key, ticket] of Object.entries(state.supportTickets)) {
    if (ticket.userId === normalizedUserId) delete state.supportTickets[key];
  }
}

function replaceTicketCategory(category, insertRows) {
  return queueWrite(`tickets:${category}`, async () => {
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      await connection.execute("DELETE FROM tickets WHERE category = ?", [category]);
      await insertRows(connection);
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  });
}

function saveApplications(applications) {
  state.applications = applications;
  return replaceTicketCategory("application", async (connection) => {
    for (const [applicationKey, application] of Object.entries(applications)) {
      const characterParts = String(application.characterInfo ?? "")
        .split("/")
        .map((part) => part.trim());
      await connection.execute(
         `INSERT INTO tickets
         (category, ticket_key, uid, user_id, status, request_type, ic_name, character_level,
          character_static_id, capt_role, ooc_age, details, claimed_by, decided_by, decision_reason,
          channel_id, message_id, announcement_channel_id, announcement_message_id,
          created_at, updated_at, closed_at)
         VALUES ('application', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [applicationKey, application.uid ?? null, application.userId,
          application.status ?? "new", application.requestType ?? "rp", characterParts[0] || null,
          characterParts[1] || null, characterParts[2] || null, application.captRole ?? null,
          application.oocAge ?? null,
          application.reason ?? null,
          application.claimedBy ?? null,
          application.closedBy ?? null,
          application.decisionReason ?? null,
          application.channelId ?? null, application.messageId ?? null,
          application.announcementChannelId ?? null,
          application.announcementMessageId ?? null,
          mysqlDate(application.createdAt), mysqlDate(application.updatedAt),
          mysqlDate(application.closedAt)]
      );
    }
  });
}

function saveSupportTickets(tickets) {
  state.supportTickets = tickets;
  return replaceTicketCategory("support", async (connection) => {
    for (const [ticketId, ticket] of Object.entries(tickets)) {
      await connection.execute(
        `INSERT INTO tickets
         (category, ticket_key, uid, user_id, status, request_type, details,
          claimed_by, decided_by, decision_reason, channel_id, message_id,
          created_at, updated_at, closed_at)
         VALUES ('support', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [ticket.id ?? ticketId, ticket.uid ?? null, ticket.userId,
          ticket.status ?? "new", ticket.requestType ?? null, ticket.details ?? null,
          ticket.claimedBy ?? null,
          ticket.closedBy ?? null,
          ticket.decisionReason ?? null, ticket.channelId ?? null,
          ticket.messageId ?? null, mysqlDate(ticket.createdAt),
          mysqlDate(ticket.updatedAt), mysqlDate(ticket.closedAt)]
      );
    }
  });
}

async function flushStorage() {
  await writeQueue;
  if (lastWriteError) throw lastWriteError;
}

async function closeStorage() {
  await flushStorage();
  if (pool) await pool.end();
}

module.exports = {
  closeStorage,
  deleteUserProfile,
  flushStorage,
  getActiveGameAfkSessions,
  getApplications,
  getBotInfo,
  getCaptReplayWindow,
  getGameAfkSession,
  getRankHistory,
  getSupportTickets,
  getUserDb,
  getWarnings,
  initStorage,
  reloadStorage,
  removeGameAfkSession,
  saveApplications,
  saveBotInfo,
  saveCaptReplayWindow,
  saveGameAfkSession,
  saveRankHistory,
  saveSupportTickets,
  saveUserDb,
  saveWarnings,
  syncUserProfile,
  takeExpiredGameAfkSessions
};
