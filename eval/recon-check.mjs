// Reconciliation check: the desk records what each source claimed, and notices when
// they disagree.
//
// The whole premise of Capture Desk is that three sources contradict each other about
// one order. Before this, that contradiction was a paragraph in the README. Now it is
// rows in read_events and a count at /api/reconcile.
//
// Offline: it drives the store directly, no PayPal and no model. Run: npm run check:recon
import { createRequire } from "node:module";
import { existsSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const { openStore } = require(path.join(root, "store.js"));

const DB = path.join(here, "recon-check.db");
for (const suffix of ["", "-wal", "-shm"]) {
  const f = DB + suffix;
  if (existsSync(f)) rmSync(f);
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}

const store = openStore(DB);
try {
  const job = store.ensureJob("job_recon01", "Recon check.", "2026-10-21T00:00:00Z");

  // Source 1: the checkout response. It calls the order complete.
  store.recordRead({
    orderId: "ORDER_ONE", jobId: job.id, source: "checkout",
    orderStatus: "COMPLETED", captureStatus: "DECLINED", code: "5120",
    readAt: "2026-10-21T00:00:01Z",
  });
  // Source 2: a later read of the same order. It says CREATED.
  store.recordRead({
    orderId: "ORDER_ONE", jobId: job.id, source: "reread",
    orderStatus: "CREATED", captureStatus: "DECLINED", code: "5120",
    readAt: "2026-10-21T00:05:00Z",
  });

  // An order where nothing disagrees, to prove the count is not just "everything".
  store.recordRead({
    orderId: "ORDER_TWO", jobId: job.id, source: "checkout",
    orderStatus: "COMPLETED", captureStatus: "COMPLETED", code: "0000",
    readAt: "2026-10-21T00:06:00Z",
  });
  store.recordRead({
    orderId: "ORDER_TWO", jobId: job.id, source: "reread",
    orderStatus: "COMPLETED", captureStatus: "COMPLETED", code: "0000",
    readAt: "2026-10-21T00:07:00Z",
  });

  const reads = store.readsFor("ORDER_ONE");
  check("both claims on the disagreeing order are kept", reads.length === 2, `${reads.length} rows`);
  check("the checkout claim survives verbatim",
    reads[0].source === "checkout" && reads[0].order_status === "COMPLETED",
    `${reads[0].source} ${reads[0].order_status}`);
  check("the later read is kept next to it, not merged",
    reads[1].source === "reread" && reads[1].order_status === "CREATED",
    `${reads[1].source} ${reads[1].order_status}`);
  check("order of reads is insertion order, oldest first",
    reads[0].read_at < reads[1].read_at, `${reads[0].read_at} < ${reads[1].read_at}`);

  const dis = store.disagreements();
  check("exactly one order is reported as disagreeing", dis.length === 1, `${dis.length} reported`);
  check("the disagreeing order is the right one", dis.length === 1 && dis[0].order_id === "ORDER_ONE",
    dis.length ? dis[0].order_id : "none");
  check("it reports two distinct versions", dis.length === 1 && dis[0].versions === 2,
    dis.length ? String(dis[0].versions) : "n/a");

  const sum = store.readSummary();
  check("summary counts every read", sum.reads === 4, `reads=${sum.reads}`);
  check("summary counts both orders", sum.orders === 2, `orders=${sum.orders}`);
  check("summary counts both sources", sum.sources === 2, `sources=${sum.sources}`);
  check("summary counts one disagreement", sum.disagreeing === 1, `disagreeing=${sum.disagreeing}`);

  // Append-only: a new claim never rewrites an old one.
  store.recordRead({
    orderId: "ORDER_ONE", jobId: job.id, source: "reread",
    orderStatus: "COMPLETED", captureStatus: "COMPLETED", code: "0000",
    readAt: "2026-10-21T01:00:00Z",
  });
  const after = store.readsFor("ORDER_ONE");
  check("a third claim is appended, not overwritten", after.length === 3, `${after.length} rows`);
  check("the earliest claim is still the checkout one",
    after[0].source === "checkout" && after[0].order_status === "COMPLETED",
    `${after[0].source} ${after[0].order_status}`);
  check("the newest claim is last",
    after[after.length - 1].read_at === "2026-10-21T01:00:00Z",
    after[after.length - 1].read_at);

  // Durability of the log itself.
  store.close();
  const reopened = openStore(DB);
  const persisted = reopened.readsFor("ORDER_ONE");
  check("the log survives closing and reopening the store", persisted.length === 3, `${persisted.length} rows`);
  check("disagreement count survives too", reopened.disagreements().length === 1,
    `${reopened.disagreements().length} reported`);
  reopened.close();
} catch (err) {
  check("harness completed", false, err.message || String(err));
} finally {
  try { store.close(); } catch {}
  for (const suffix of ["", "-wal", "-shm"]) {
    const f = DB + suffix;
    if (existsSync(f)) { try { rmSync(f); } catch {} }
  }
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);