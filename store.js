"use strict";

// Durable job state, on node:sqlite.
//
// Why this file exists: the desk's whole claim is that the guards own the file lock
// and the three-attempt cap. With the state in a Map those guards died with the
// process — a restart forgot every job, so a restored job could be charged again
// and a real PayPal order could no longer be re-read. The guards were correct and
// the memory behind them was not.
//
// What changed on 29 Oct: an attempt is now claimed in the ledger *before* PayPal is
// called, with one deterministic request id per attempt. That is the only way the cap
// survives two callers (page, CLI, MCP, two agents) charging at once, and the only way
// a retried call reuses the first PayPal order instead of creating a second one.
//
// node:sqlite ships inside Node (>=22.5; no flag needed from 22.13), so this costs no dependency.

const path = require("path");

// The only warning this file can provoke is Node's own experimental notice for the
// SQLite module. Install the filter before the require that triggers it, so the desk
// boots quietly; pass every other warning through untouched.
const realEmitWarning = process.emitWarning;
process.emitWarning = function (warning, ...rest) {
  const name = typeof rest[0] === "string" ? rest[0] : rest[0] && rest[0].type;
  if (name === "ExperimentalWarning" && String(warning).includes("SQLite")) return;
  return realEmitWarning.call(process, warning, ...rest);
};

const { DatabaseSync } = require("node:sqlite");

// A claim holds an attempt slot while the PayPal POST is in flight. If the process
// dies mid-call the slot must not be lost forever, so a claim older than this is
// released on the next claim for the same job. A live call takes ~5-30 s.
const CLAIM_TTL_MS = 120000;
const MAX_ATTEMPTS = 3;

const BASE_TABLES = `
CREATE TABLE IF NOT EXISTS jobs (
  id          TEXT PRIMARY KEY,
  note        TEXT    NOT NULL DEFAULT '',
  created_at  TEXT    NOT NULL,
  closed      INTEGER NOT NULL DEFAULT 0,
  paid_on     INTEGER
);
CREATE TABLE IF NOT EXISTS orders (
  order_id  TEXT PRIMARY KEY,
  job_id    TEXT,
  body      TEXT NOT NULL,
  stored_at TEXT NOT NULL
);
-- Every time a source states what happened to an order, that statement is appended
-- here. The sources disagree (checkout says COMPLETED, the capture says DECLINED, a
-- later read says CREATED), so the disagreement is the fact worth keeping, not any
-- single one of them. Append-only: a row is never updated or deleted.
CREATE TABLE IF NOT EXISTS read_events (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id       TEXT NOT NULL,
  job_id         TEXT,
  source         TEXT NOT NULL,
  order_status   TEXT,
  capture_status TEXT,
  code           TEXT,
  read_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS read_events_by_order ON read_events(order_id, id);
-- The guarded decision is part of the job, not a value that lives in one browser tab.
-- Without this a refresh lost the proposal, the veto and the attempt count.
CREATE TABLE IF NOT EXISTS decisions (
  order_id        TEXT PRIMARY KEY,
  job_id          TEXT    NOT NULL,
  attempt_no      INTEGER NOT NULL,
  provider        TEXT,
  model           TEXT,
  proposed        TEXT,
  final           TEXT,
  vetoed          INTEGER NOT NULL DEFAULT 0,
  veto_reason     TEXT,
  fallback_reason TEXT,
  decided_by      TEXT    NOT NULL,
  not_before      TEXT,
  decided_at      TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS decisions_by_job ON decisions(job_id, attempt_no);
`;

// attempt_no is the slot, request_id is the idempotency key PayPal dedupes on, and
// order_id only exists once PayPal has answered. state is 'claimed' or 'charged'.
const ATTEMPTS_TABLE = `
CREATE TABLE IF NOT EXISTS attempts (
  attempt_id     INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id         TEXT    NOT NULL REFERENCES jobs(id),
  attempt_no     INTEGER NOT NULL,
  request_id     TEXT    NOT NULL UNIQUE,
  order_id       TEXT    UNIQUE,
  state          TEXT    NOT NULL,
  capture_status TEXT,
  code           TEXT,
  at             TEXT    NOT NULL,
  charged_at     TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS attempts_slot ON attempts(job_id, attempt_no);
CREATE INDEX IF NOT EXISTS attempts_by_job ON attempts(job_id, attempt_no);
`;

function migrate(db) {
  db.exec(BASE_TABLES);
  const cols = db.prepare("PRAGMA table_info(attempts)").all().map((c) => c.name);
  if (cols.length && !cols.includes("attempt_id")) {
    // v1 keyed attempts by order_id and had no request id, so the same attempt could
    // become two orders. Rebuild, renumbering any duplicate slot from that race.
    db.exec("ALTER TABLE attempts RENAME TO attempts_v1");
    db.exec(ATTEMPTS_TABLE);
    db.exec(`
      INSERT INTO attempts (job_id, attempt_no, request_id, order_id, state, capture_status, code, at, charged_at)
      SELECT job_id,
             ROW_NUMBER() OVER (PARTITION BY job_id ORDER BY attempt_no, at),
             order_id, order_id, 'charged', capture_status, code, at, at
        FROM attempts_v1
       ORDER BY job_id, attempt_no, at
    `);
    db.exec("DROP TABLE attempts_v1");
  } else {
    db.exec(ATTEMPTS_TABLE);
  }
  db.exec("PRAGMA user_version = 2");
}

function openStore(file) {
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  // Several callers share this file: the server, the CLI, an MCP client. WAL plus a
  // busy timeout is what lets them take turns instead of failing on a locked db.
  db.exec("PRAGMA busy_timeout = 5000");
  migrate(db);

  const stmt = {
    insertJob: db.prepare("INSERT INTO jobs (id, note, created_at, closed, paid_on) VALUES (?, ?, ?, 0, NULL)"),
    getJob: db.prepare("SELECT id, note, created_at, closed, paid_on FROM jobs WHERE id = ?"),
    listJobs: db.prepare("SELECT id, note, created_at, closed, paid_on FROM jobs ORDER BY created_at DESC LIMIT ?"),
    dropEmptyJob: db.prepare("DELETE FROM jobs WHERE id = ? AND NOT EXISTS (SELECT 1 FROM attempts WHERE job_id = ?)"),
    markPaid: db.prepare("UPDATE jobs SET paid_on = ? WHERE id = ?"),
    closeJob: db.prepare("UPDATE jobs SET closed = 1 WHERE id = ?"),
    putOrder: db.prepare("INSERT INTO orders (order_id, job_id, body, stored_at) VALUES (?, ?, ?, ?) ON CONFLICT(order_id) DO UPDATE SET body = excluded.body"),
    getOrder: db.prepare("SELECT order_id, job_id, body FROM orders WHERE order_id = ?"),
    ownsOrder: db.prepare("SELECT 1 AS ok FROM attempts WHERE order_id = ? LIMIT 1"),
    jobIdForOrder: db.prepare("SELECT job_id FROM attempts WHERE order_id = ? LIMIT 1"),
    chargedAttempts: db.prepare("SELECT * FROM attempts WHERE job_id = ? AND state = 'charged' ORDER BY attempt_no"),
    activeAttempts: db.prepare("SELECT * FROM attempts WHERE job_id = ? AND state IN ('claimed', 'charged') ORDER BY attempt_no"),
    slotAttempt: db.prepare("SELECT * FROM attempts WHERE job_id = ? AND attempt_no = ?"),
    activeCount: db.prepare("SELECT COUNT(*) AS n FROM attempts WHERE job_id = ? AND state IN ('claimed', 'charged')"),
    nextSlot: db.prepare("SELECT COALESCE(MAX(attempt_no), 0) + 1 AS n FROM attempts WHERE job_id = ?"),
    insertClaim: db.prepare("INSERT INTO attempts (job_id, attempt_no, request_id, order_id, state, capture_status, code, at, charged_at) VALUES (?, ?, ?, NULL, 'claimed', NULL, NULL, ?, NULL)"),
    finishClaim: db.prepare("UPDATE attempts SET order_id = ?, state = 'charged', capture_status = ?, code = ?, charged_at = ? WHERE attempt_id = ?"),
    releaseClaim: db.prepare("DELETE FROM attempts WHERE attempt_id = ? AND state = 'claimed'"),
    releaseStale: db.prepare("DELETE FROM attempts WHERE state = 'claimed' AND at < ?"),
    lastAttemptId: db.prepare("SELECT attempt_id FROM attempts WHERE job_id = ? ORDER BY attempt_no DESC LIMIT 1"),
    addRead: db.prepare("INSERT INTO read_events (order_id, job_id, source, order_status, capture_status, code, read_at) VALUES (?, ?, ?, ?, ?, ?, ?)"),
    readsByOrder: db.prepare("SELECT order_id, job_id, source, order_status, capture_status, code, read_at FROM read_events WHERE order_id = ? ORDER BY id"),
    allReads: db.prepare("SELECT order_id, job_id, source, order_status, capture_status, code, read_at FROM read_events ORDER BY id"),
    disagreementPairs: db.prepare(`
      SELECT order_id,
             COUNT(DISTINCT IFNULL(order_status, '') || '|' || IFNULL(capture_status, '')) AS versions,
             COUNT(*) AS reads
        FROM read_events
       GROUP BY order_id
      HAVING versions > 1
       ORDER BY versions DESC, reads DESC
    `),
    totals: db.prepare("SELECT COUNT(*) AS reads, COUNT(DISTINCT order_id) AS orders, COUNT(DISTINCT source) AS sources FROM read_events"),
    putDecision: db.prepare(`
      INSERT INTO decisions (order_id, job_id, attempt_no, provider, model, proposed, final, vetoed, veto_reason, fallback_reason, decided_by, not_before, decided_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(order_id) DO UPDATE SET
        proposed = excluded.proposed, final = excluded.final, vetoed = excluded.vetoed,
        veto_reason = excluded.veto_reason, fallback_reason = excluded.fallback_reason,
        decided_by = excluded.decided_by, not_before = excluded.not_before,
        decided_at = excluded.decided_at, provider = excluded.provider, model = excluded.model
    `),
    decisionByOrder: db.prepare("SELECT * FROM decisions WHERE order_id = ?"),
    decisionsByJob: db.prepare("SELECT * FROM decisions WHERE job_id = ? ORDER BY attempt_no"),
  };

  function hydrate(row) {
    if (!row) return null;
    return {
      id: row.id,
      note: row.note,
      created_at: row.created_at,
      closed: row.closed === 1,
      paid_on: row.paid_on,
      attempts: stmt.chargedAttempts.all(row.id).map((a) => ({
        order_id: a.order_id,
        attempt_no: a.attempt_no,
        capture_status: a.capture_status,
        code: a.code,
        at: a.at,
      })),
    };
  }

  function parseJson(text) {
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  function decisionRow(row) {
    if (!row) return null;
    return {
      order_id: row.order_id,
      job_id: row.job_id,
      attempt_no: row.attempt_no,
      provider: row.provider,
      model: row.model,
      proposed: parseJson(row.proposed),
      final: parseJson(row.final),
      vetoed: row.vetoed === 1,
      veto_reason: row.veto_reason,
      fallback_reason: row.fallback_reason,
      decided_by: row.decided_by,
      not_before: row.not_before,
      decided_at: row.decided_at,
    };
  }

  function attemptRow(row) {
    if (!row) return null;
    return {
      attempt_id: row.attempt_id,
      attempt_no: row.attempt_no,
      request_id: row.request_id,
      order_id: row.order_id,
      state: row.state,
      capture_status: row.capture_status,
      code: row.code,
      at: row.at,
      charged_at: row.charged_at,
    };
  }

  return {
    file,
    // Create a job, or return the one that already exists. The caller never has to
    // know which happened: a restart mid-job must not fork the job's history.
    ensureJob(id, note, createdAt) {
      const existing = hydrate(stmt.getJob.get(id));
      if (existing) return existing;
      stmt.insertJob.run(id, note, createdAt);
      return hydrate(stmt.getJob.get(id));
    },
    getJob: (id) => hydrate(stmt.getJob.get(id)),
    listJobs: (limit = 20) => stmt.listJobs.all(limit).map(hydrate),
    dropEmptyJob(jobId) {
      stmt.dropEmptyJob.run(jobId, jobId);
    },
    markPaid(jobId, attemptNo) {
      stmt.markPaid.run(attemptNo, jobId);
    },
    markClosed(jobId) {
      stmt.closeJob.run(jobId);
    },
    putOrder(orderId, jobId, body, at) {
      stmt.putOrder.run(orderId, jobId, JSON.stringify(body), at);
    },
    getOrder(orderId) {
      const row = stmt.getOrder.get(orderId);
      return row ? parseJson(row.body) : null;
    },
    // True only for an order this desk actually charged.
    ownsOrder: (orderId) => Boolean(stmt.ownsOrder.get(orderId)),
    jobIdForOrder(orderId) {
      const row = stmt.jobIdForOrder.get(orderId);
      return row ? row.job_id : null;
    },

    attempts(jobId) {
      return stmt.activeAttempts.all(jobId).map(attemptRow);
    },
    chargedAttempts(jobId) {
      return stmt.chargedAttempts.all(jobId).map(attemptRow);
    },
    latestCharged(jobId) {
      const rows = stmt.chargedAttempts.all(jobId);
      return rows.length ? attemptRow(rows[rows.length - 1]) : null;
    },
    attemptCount: (jobId) => stmt.activeCount.get(jobId).n,
    // One attempt slot, by number. Used to replay a charged attempt and to wait for
    // an attempt another caller is charging right now.
    slot(jobId, attemptNo) {
      return attemptRow(stmt.slotAttempt.get(jobId, attemptNo));
    },

    // Take the next attempt slot for a job, or say why not. Runs inside one write
    // transaction, so two callers cannot both read the same count and both proceed.
    //
    // Returns one of:
    //   { attemptNo, attemptId, requestId }  slot claimed, go call PayPal with requestId
    //   { replay: attempt }                  this slot already has an order; do not POST
    //   { busy: attempt }                    the same slot is being charged right now
    //   { refused: "cap" | "stale" }         tell the caller, charge nothing
    claimAttempt(jobId, opts = {}) {
      const now = opts.now || new Date().toISOString();
      const staleBefore = new Date(new Date(now).getTime() - CLAIM_TTL_MS).toISOString();
      const desired = Number.isInteger(opts.desiredAttempt) ? opts.desiredAttempt : null;
      db.exec("BEGIN IMMEDIATE");
      try {
        stmt.releaseStale.run(staleBefore);
        const active = stmt.activeCount.get(jobId).n;
        if (desired != null) {
          const existing = attemptRow(stmt.slotAttempt.get(jobId, desired));
          if (existing) {
            db.exec("COMMIT");
            // A charged slot is an idempotent read: hand back the order that already
            // exists for it. A claimed slot is in flight; the caller waits for it.
            if (existing.state === "charged") return { replay: existing };
            return { busy: existing };
          }
          if (desired !== active + 1) {
            db.exec("ROLLBACK");
            return { refused: "stale", active, desired };
          }
        }
        if (active >= MAX_ATTEMPTS) {
          db.exec("ROLLBACK");
          return { refused: "cap" };
        }
        const attemptNo = desired != null ? desired : stmt.nextSlot.get(jobId).n;
        const requestId = `${jobId}:a${attemptNo}`;
        stmt.insertClaim.run(jobId, attemptNo, requestId, now);
        const attemptId = stmt.lastAttemptId.get(jobId).attempt_id;
        db.exec("COMMIT");
        return { attemptNo, attemptId, requestId };
      } catch (err) {
        try { db.exec("ROLLBACK"); } catch {}
        throw err;
      }
    },
    // PayPal answered: pin the order to the claimed slot.
    finishAttempt(attemptId, { orderId, captureStatus, code, at }) {
      stmt.finishClaim.run(orderId, captureStatus || null, code || null, at || new Date().toISOString(), attemptId);
    },
    // PayPal refused or the call failed: give the slot back, nothing happened.
    releaseAttempt(attemptId) {
      stmt.releaseClaim.run(attemptId);
    },

    // Append one source's statement about an order. Never updated, never deleted.
    recordRead({ orderId, jobId, source, orderStatus, captureStatus, code, readAt }) {
      stmt.addRead.run(
        orderId,
        jobId || null,
        source,
        orderStatus || null,
        captureStatus || null,
        code || null,
        readAt || new Date().toISOString()
      );
    },
    readsFor(orderId) {
      return stmt.readsByOrder.all(orderId);
    },
    // Orders whose sources disagreed at least once, with how many distinct
    // (order_status, capture_status) versions were seen.
    disagreements() {
      return stmt.disagreementPairs.all();
    },
    readSummary() {
      const t = stmt.totals.get();
      return { reads: t.reads, orders: t.orders, sources: t.sources, disagreeing: stmt.disagreementPairs.all().length };
    },
    allReads() {
      return stmt.allReads.all();
    },

    putDecision(d) {
      stmt.putDecision.run(
        d.orderId, d.jobId, d.attemptNo,
        d.provider || null, d.model || null,
        d.proposed ? JSON.stringify(d.proposed) : null,
        d.final ? JSON.stringify(d.final) : null,
        d.vetoed ? 1 : 0,
        d.vetoReason || null, d.fallbackReason || null,
        d.decidedBy, d.notBefore || null, d.decidedAt
      );
    },
    decisionFor: (orderId) => decisionRow(stmt.decisionByOrder.get(orderId)),
    decisionsForJob(jobId) {
      return stmt.decisionsByJob.all(jobId).map(decisionRow);
    },
    close() {
      db.close();
    },
  };
}

// Default location, overridable so tests and checks do not touch the real desk.
function defaultStoreFile() {
  return process.env.DESK_DB || path.join(__dirname, "desk.db");
}

module.exports = { openStore, defaultStoreFile, MAX_ATTEMPTS, CLAIM_TTL_MS };
