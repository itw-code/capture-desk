// Agent-tool check: the thing that makes the desk safe to share.
//
// Three properties a caller relies on, none of which the earlier checks covered:
//   1. One attempt, one PayPal order — even when two callers charge the same attempt
//      at the same instant, and even when the caller repeats itself later.
//   2. The guarded decision is durable: /api/job, the CLI and MCP return the same
//      envelope the page got, after the process that produced it is gone.
//   3. The three-attempt cap holds under concurrency, not just serially.
//
// Uses the real sandbox (a decision has to come from a real capture) and a throwaway db.
// Run: npm run check:tool
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const desk = require(path.join(root, "desk.js"));
const { MAX_ATTEMPTS, aiConfig } = desk;

if (aiConfig().kind === "none") {
  console.error("No AI key set in .env. The tool check makes a real decision.");
  process.exit(2);
}

const DB = path.join(here, "tool-check.db");
for (const suffix of ["", "-wal", "-shm"]) {
  const f = DB + suffix;
  if (existsSync(f)) rmSync(f);
}

const basePort = Number(process.env.TOOL_PORT || 8792);
let portSeq = 0;
let PORT = basePort;
let BASE = `http://127.0.0.1:${PORT}`;

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}

function startServer() {
  PORT = basePort + portSeq++;
  BASE = `http://127.0.0.1:${PORT}`;
  const child = spawn(process.execPath, [path.join(root, "server.js")], {
    env: Object.assign({}, process.env, { DESK_PORT: String(PORT), DESK_DB: DB }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("server did not start in 15s")), 15000);
    let out = "";
    child.stdout.on("data", (b) => {
      out += b.toString();
      if (out.includes("capture desk")) {
        clearTimeout(timer);
        resolve(child);
      }
    });
    child.stderr.on("data", (b) => { out += b.toString(); });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited early (${code}): ${out.slice(0, 200)}`));
    });
  });
}

function stopServer(child) {
  return new Promise((resolve) => {
    child.once("exit", () => resolve());
    child.kill();
    setTimeout(() => { try { child.kill("SIGKILL"); } catch {} resolve(); }, 4000);
  });
}

async function api(method, pathname, body) {
  const res = await fetch(BASE + pathname, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed = {};
  try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { raw: text }; }
  return { status: res.status, body: parsed };
}

// The CLI is a separate process with its own ledger handle: exactly what an agent runs.
function cli(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(root, "cli.js"), ...args, "--db", DB], {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (b) => { out += b.toString(); });
    child.stderr.on("data", (b) => { err += b.toString(); });
    child.on("exit", (code) => {
      let body = null;
      try { body = JSON.parse(out); } catch { body = { raw: out, stderr: err }; }
      resolve({ code, body });
    });
  });
}

// MCP over stdio: initialize, then one tools/call. Same process an MCP client spawns.
function mcpCall(tool, args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(root, "mcp.js")], {
      env: Object.assign({}, process.env, { DESK_DB: DB }),
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (b) => {
      out += b.toString();
      const lines = out.trim().split("\n");
      for (const l of lines) {
        let m;
        try { m = JSON.parse(l); } catch { continue; }
        if (m.id === 2) {
          child.stdin.end();
          resolve(m.result || m.error);
        }
      }
    });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "tool-check", version: "0" } } }) + "\n");
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: tool, arguments: args } }) + "\n");
    setTimeout(() => {
      try { child.kill(); } catch {}
      resolve({ error: "mcp timeout", raw: out.slice(0, 300) });
    }, 30000);
  });
}

// One-shot MCP call: write both messages, close stdin immediately, then read the reply.
// This is what a `printf | node mcp.js` client does, and it used to close the ledger
// while a model call was still in flight ("statement has been finalized").
function mcpOneShot(tool, args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(root, "mcp.js")], {
      env: Object.assign({}, process.env, { DESK_DB: DB }),
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (b) => { out += b.toString(); });
    child.on("exit", () => {
      const lines = out.trim().split("\n").filter(Boolean);
      for (const l of lines) {
        let m;
        try { m = JSON.parse(l); } catch { continue; }
        if (m.id === 2) return resolve(m.result || m.error);
      }
      resolve({ error: "no reply", raw: out.slice(0, 300) });
    });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "tool-check", version: "0" } } }) + "\n");
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: tool, arguments: args } }) + "\n");
    child.stdin.end();
    setTimeout(() => { try { child.kill(); } catch {} }, 45000);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

let server;
try {
  server = await startServer();

  // ---- job A: one attempt, one decision, three readers ----------------------
  const first = await api("POST", "/api/charge", { trigger: "CCREJECT-IF", note: "Repeat client, paid me 6 times. Said payday is Friday." });
  check("charge accepted", first.status < 300, `HTTP ${first.status}`);
  const jobA = first.body.job && first.body.job.id;
  const orderA = first.body.id;
  check("job created with one attempt", Boolean(jobA) && first.body.job.attempt === 1, `${jobA} attempt=${first.body.job && first.body.job.attempt}`);

  // Charged but not yet decided is a real state: the CLI smoke in the brief's §6 is
  // exactly `charge` then `status`. The guard fields must be there without a model call.
  const undecided = await cli(["status", jobA]);
  const undecidedEnv = undecided.body && undecided.body.latest;
  check("status before decide still reports the lock", Boolean(undecidedEnv) && undecidedEnv.files_locked === true, `locked=${undecidedEnv && undecidedEnv.files_locked}`);
  check("status before decide still reports the buyer line", Boolean(undecidedEnv) && undecidedEnv.buyer_message === "The charge didn't clear. PayPal response code 5120.", JSON.stringify(undecidedEnv && undecidedEnv.buyer_message));
  check("status before decide does not invent a next step", Boolean(undecidedEnv) && undecidedEnv.final === null && undecidedEnv.decided === false && undecidedEnv.decided_by === null, `final=${JSON.stringify(undecidedEnv && undecidedEnv.final)} decided=${undecidedEnv && undecidedEnv.decided}`);

  const decided = await api("POST", "/api/decide", { order: { id: orderA }, job_id: jobA });
  check("decision produced", decided.status === 200, `HTTP ${decided.status}`);
  const d = decided.body.decision || {};
  check("declined capture stays locked", d.files_locked === true && d.fulfill === false, `locked=${d.files_locked} fulfill=${d.fulfill}`);
  check("buyer line is the desk's exact 5120 line", d.buyer_message === "The charge didn't clear. PayPal response code 5120.", JSON.stringify(d.buyer_message));

  const jobRead = await api("GET", "/api/job?id=" + encodeURIComponent(jobA));
  const env = jobRead.body.latest && jobRead.body.latest.decision;
  const stored = jobRead.body.attempts[0] && jobRead.body.attempts[0].envelope;
  check("GET /api/job returns the job", jobRead.status === 200, `HTTP ${jobRead.status}`);
  check("the stored envelope matches the live decision",
    Boolean(stored) && same(stored.buyer_message, d.buyer_message) && same(stored.final, d.final) && same(stored.vetoed, d.vetoed) && same(stored.decided_by, d.decided_by),
    stored ? `final=${JSON.stringify(stored.final)} by=${stored.decided_by}` : "no envelope");
  check("the envelope keeps the wait the model gave",
    !d.not_before || Boolean(stored && stored.not_before === d.not_before),
    `not_before=${stored && stored.not_before}`);

  // A second decide must not spend another model call or change the answer.
  const again = await api("POST", "/api/decide", { order: { id: orderA }, job_id: jobA });
  check("decide is cached, not re-run", again.body.cached === true, `cached=${again.body.cached}`);
  check("cached decide returns the same final move", same(again.body.decision.final, d.final), JSON.stringify(again.body.decision.final));

  // ---- parity: the CLI and MCP read the same ledger -------------------------
  const cliStatus = await cli(["status", jobA]);
  const cliEnv = cliStatus.body && cliStatus.body.attempts && cliStatus.body.attempts[0] && cliStatus.body.attempts[0].envelope;
  check("CLI exits 0 on status", cliStatus.code === 0, `exit=${cliStatus.code}`);
  check("CLI reports the same buyer line", Boolean(cliEnv) && cliEnv.buyer_message === d.buyer_message, JSON.stringify(cliEnv && cliEnv.buyer_message));
  check("CLI reports the same final move", Boolean(cliEnv) && same(cliEnv.final, d.final), JSON.stringify(cliEnv && cliEnv.final));
  check("CLI reports files locked", Boolean(cliEnv) && cliEnv.files_locked === true, `locked=${cliEnv && cliEnv.files_locked}`);

  const cliDecide = await cli(["decide", jobA]);
  check("CLI decide is cached like the HTTP path", cliDecide.body && cliDecide.body.cached === true, `cached=${cliDecide.body && cliDecide.body.cached}`);

  const mcp = await mcpCall("capture_desk_status", { job_id: jobA });
  const mcpBody = mcp && mcp.structuredContent;
  const mcpEnv = mcpBody && mcpBody.attempts && mcpBody.attempts[0] && mcpBody.attempts[0].envelope;
  check("MCP status returns content, not an error", Boolean(mcpBody) && mcp.isError === false, mcp.error || "ok");
  check("MCP reports the same buyer line", Boolean(mcpEnv) && mcpEnv.buyer_message === d.buyer_message, JSON.stringify(mcpEnv && mcpEnv.buyer_message));
  check("MCP reports the same final move", Boolean(mcpEnv) && same(mcpEnv.final, d.final), JSON.stringify(mcpEnv && mcpEnv.final));

  const mcpReconcile = await mcpCall("capture_desk_reconcile", { job_id: jobA });
  check("MCP reconcile sees this job's order", Boolean(mcpReconcile.structuredContent), mcpReconcile.error || "ok");

  // A client that closes stdin right after writing must still get a full answer, even
  // when the call is still waiting on the model. This used to finalize the ledger early.
  const oneShot = await mcpOneShot("capture_desk_decide", { job_id: jobA });
  const oneShotBody = oneShot && oneShot.structuredContent;
  check("one-shot MCP decide answers after stdin closes",
    Boolean(oneShotBody) && oneShot.isError === false,
    oneShot.error || (oneShotBody ? `cached=${oneShotBody.cached}` : "no content"));
  check("one-shot MCP decide returns the same guarded move",
    Boolean(oneShotBody) && same(oneShotBody.decision.final, d.final),
    JSON.stringify(oneShotBody && oneShotBody.decision.final));

  // ---- one attempt, one order: two callers, same instant --------------------
  const dup = await Promise.all([
    api("POST", "/api/charge", { trigger: "Sandbox Buyer", job_id: jobA, attempt_no: 2 }),
    api("POST", "/api/charge", { trigger: "Sandbox Buyer", job_id: jobA, attempt_no: 2 }),
  ]);
  const ids = dup.map((r) => r.body && r.body.id).filter(Boolean);
  const replayed = dup.filter((r) => r.body && r.body.replay).length;
  check("both duplicate callers got an answer", dup.every((r) => r.status < 300), `HTTP ${dup.map((r) => r.status).join(",")}`);
  check("the duplicate made one PayPal order, not two", new Set(ids).size === 1, `ids=${ids.join(",")}`);

  const afterDup = await api("GET", "/api/job?id=" + encodeURIComponent(jobA));
  check("the duplicate added one attempt", afterDup.body.attempt === 2, `attempt=${afterDup.body.attempt}`);
  check("the cleared capture unlocked the job", afterDup.body.paid_on === 2, `paid_on=${afterDup.body.paid_on}`);
  check("the second caller was told it was a replay", replayed >= 1, `replays=${replayed}`);

  // A repeat of a finished attempt is still a replay, never a third order.
  const repeat = await api("POST", "/api/charge", { trigger: "Sandbox Buyer", job_id: jobA, attempt_no: 2 });
  check("a later repeat replays instead of charging", repeat.status === 200 && repeat.body.replay === true && repeat.body.id === ids[0], `HTTP ${repeat.status} replay=${repeat.body.replay}`);

  const closedJob = await api("POST", "/api/charge", { trigger: "CCREJECT-IF", job_id: jobA, attempt_no: 3 });
  check("a paid job refuses another charge", closedJob.status === 409, `HTTP ${closedJob.status} ${closedJob.body.error || ""}`);

  // ---- the cap is atomic, not just serial ----------------------------------
  const jobB = (await api("POST", "/api/charge", { trigger: "CCREJECT-IF", note: "Cap race." })).body.job.id;
  const race = await Promise.all([
    api("POST", "/api/charge", { trigger: "CCREJECT-IF", job_id: jobB, attempt_no: 2 }),
    api("POST", "/api/charge", { trigger: "CCREJECT-IF", job_id: jobB, attempt_no: 3 }),
    api("POST", "/api/charge", { trigger: "CCREJECT-IF", job_id: jobB, attempt_no: 4 }),
  ]);
  const accepted = race.filter((r) => r.status < 300).length;
  const refused = race.filter((r) => r.status === 409).length;
  check(`exactly ${MAX_ATTEMPTS - 1} extra attempts accepted under race`, accepted === MAX_ATTEMPTS - 1, `accepted=${accepted} statuses=${race.map((r) => r.status).join(",")}`);
  check("the over-cap caller got 409", refused === 1, `refused=${refused}`);
  const jobBRead = await api("GET", "/api/job?id=" + encodeURIComponent(jobB));
  check(`the job holds exactly ${MAX_ATTEMPTS} attempts`, jobBRead.body.attempt === MAX_ATTEMPTS, `attempt=${jobBRead.body.attempt}`);

  // ---- closing a job is a state the ledger keeps, not a UI-only label ------
  const closeIt = await api("POST", "/api/close", { job_id: jobB });
  check("close is accepted", closeIt.status === 200 && closeIt.body.job.closed === true, `HTTP ${closeIt.status}`);
  const closedRead = await api("GET", "/api/job?id=" + encodeURIComponent(jobB));
  check("a closed job still reports its attempts and lock",
    closedRead.body.closed === true && closedRead.body.latest && closedRead.body.latest.files_locked === true,
    `closed=${closedRead.body.closed} locked=${closedRead.body.latest && closedRead.body.latest.files_locked}`);
  const closedCharge = await api("POST", "/api/charge", { trigger: "CCREJECT-IF", job_id: jobB });
  check("a closed job refuses a new charge", closedCharge.status === 409, `HTTP ${closedCharge.status}`);

  // ---- a stored reread is part of the job, not a button state --------------
  const orderB = jobBRead.body.attempts[0].order_id;
  const reread = await api("GET", "/api/order?id=" + encodeURIComponent(orderB));
  check("a fresh read of a charged order is accepted", reread.status === 200, `HTTP ${reread.status}`);
  const afterReread = await api("GET", "/api/job?id=" + encodeURIComponent(jobB));
  const reads = (afterReread.body.attempts[0] && afterReread.body.attempts[0].reads) || [];
  check("the reread is stored next to the checkout claim",
    reads.filter((r) => r.source === "checkout").length === 1 && reads.filter((r) => r.source === "reread").length >= 1,
    `sources=${reads.map((r) => r.source).join(",")}`);
  check("the disagreement is visible without calling reconcile",
    new Set(reads.map((r) => r.order_status)).size >= 1 && reads.some((r) => r.order_status === "CREATED"),
    `statuses=${[...new Set(reads.map((r) => r.order_status))].join("/")}`);

  // ---- the decision survives the process that made it ----------------------
  await stopServer(server);
  server = null;
  await sleep(300);
  const cliAfterRestart = await cli(["status", jobA]);
  const envAfter = cliAfterRestart.body && cliAfterRestart.body.attempts && cliAfterRestart.body.attempts[0] && cliAfterRestart.body.attempts[0].envelope;
  check("after the server is gone, the CLI still reports the decision",
    Boolean(envAfter) && envAfter.buyer_message === d.buyer_message && same(envAfter.final, d.final),
    envAfter ? `by=${envAfter.decided_by}` : "no decision");
  const latestAfter = cliAfterRestart.body && cliAfterRestart.body.latest;
  check("the cleared attempt is the job's current answer",
    Boolean(latestAfter) && latestAfter.files_locked === false && latestAfter.paid_on_attempt === 2,
    latestAfter ? `locked=${latestAfter.files_locked} paid_on=${latestAfter.paid_on_attempt}` : "no latest");

  const mcpAfter = await mcpCall("capture_desk_status", { job_id: jobA });
  const mcpEnvAfter = mcpAfter.structuredContent && mcpAfter.structuredContent.attempts && mcpAfter.structuredContent.attempts[0] && mcpAfter.structuredContent.attempts[0].envelope;
  check("MCP reads the same decision with no server running",
    Boolean(mcpEnvAfter) && mcpEnvAfter.buyer_message === d.buyer_message,
    JSON.stringify(mcpEnvAfter && mcpEnvAfter.buyer_message));

  // ---- unknown ids are refused, not invented ------------------------------
  const badJob = await cli(["status", "job_does_not_exist"]);
  check("CLI exits 1 for an unknown job", badJob.code === 1, `exit=${badJob.code}`);
  const badOrder = await cli(["read", "NOT_A_REAL_ORDER"]);
  check("CLI refuses an order the desk never charged", badOrder.code === 1, `exit=${badOrder.code}`);
  const badTrigger = await cli(["charge", "--trigger", "CCREJECT-NOPE"]);
  check("CLI refuses an unknown trigger without charging", badTrigger.code === 1, `exit=${badTrigger.code}`);
} catch (err) {
  check("harness completed", false, err.message || String(err));
} finally {
  if (server) await stopServer(server);
  for (const suffix of ["", "-wal", "-shm"]) {
    const f = DB + suffix;
    if (existsSync(f)) { try { rmSync(f); } catch {} }
  }
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
