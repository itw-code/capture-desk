// Durability check for the guard invariant.
//
// The desk's claim is that the guards own the file lock and the three-attempt cap.
// Before the ledger those guards lived in a Map, so a restart forgot every job: a
// restored job could be charged again, and a real PayPal order could no longer be
// re-read. This script proves the cap and the order history survive a restart.
//
// It uses the real sandbox (the charge has to be a real capture read) and a
// throwaway database. Run: npm run check:durable
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const { MAX_ATTEMPTS, aiConfig } = require(path.join(root, "server.js"));

if (aiConfig().kind === "none") {
  console.error("No AI key set in .env. This check charges the real sandbox.");
  process.exit(2);
}

// The desk has a port knob the .env file cannot clear. Each leg takes its own port,
// because a killed server may not have released the previous one yet.
const basePort = Number(process.env.DURABLE_PORT || 8791);
let portSeq = 0;
const DB = path.join(here, "durability-check.db");
let PORT = basePort;
let BASE = `http://127.0.0.1:${PORT}`;

for (const suffix of ["", "-wal", "-shm"]) {
  const f = DB + suffix;
  if (existsSync(f)) rmSync(f);
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}

function startServer() {
  PORT = basePort + portSeq++;
  BASE = `http://127.0.0.1:${PORT}`;
  const childEnv = Object.assign({}, process.env, { DESK_PORT: String(PORT), DESK_DB: DB });
  const child = spawn(process.execPath, [path.join(root, "server.js")], {
    env: childEnv,
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let server;
try {
  // ---- leg 1: two attempts on one job -------------------------------------
  server = await startServer();
  const first = await api("POST", "/api/charge", { trigger: "CCREJECT-IF", note: "Durability check, attempt 1." });
  check("charge 1 accepted", first.status < 300, `HTTP ${first.status}`);
  const jobId = first.body.job && first.body.job.id;
  const order1 = first.body.id;
  check("charge 1 created a job", Boolean(jobId), jobId || "no job id");

  const second = await api("POST", "/api/charge", { trigger: "CCREJECT-IF", job_id: jobId });
  check("charge 2 accepted", second.status < 300, `HTTP ${second.status}`);
  check("attempt count is 2 before restart",
    second.body.job && second.body.job.attempt === 2,
    `attempt=${second.body.job && second.body.job.attempt}`);

  // ---- restart ------------------------------------------------------------
  await stopServer(server);
  server = null;
  await sleep(300);
  server = await startServer();
  const health = await api("GET", "/api/health");
  check("server restarted and answering", health.status === 200, `HTTP ${health.status}`);

  // ---- leg 2: the state has to have survived ------------------------------
  const reread = await api("GET", "/api/order?id=" + encodeURIComponent(order1));
  check("a pre-restart order is still re-readable", reread.status === 200,
    reread.status === 200 ? `order ${reread.body.order_status} / capture ${reread.body.capture_status}` : `HTTP ${reread.status}`);

  const third = await api("POST", "/api/charge", { trigger: "CCREJECT-IF", job_id: jobId });
  check("charge 3 accepted after restart", third.status < 300, `HTTP ${third.status}`);
  check("attempt count is 3, not reset to 1",
    third.body.job && third.body.job.attempt === 3,
    `attempt=${third.body.job && third.body.job.attempt}`);

  // the invariant: the cap cannot be outrun by restarting
  const fourth = await api("POST", "/api/charge", { trigger: "CCREJECT-IF", job_id: jobId });
  check(`charge ${MAX_ATTEMPTS + 1} refused with 409`, fourth.status === 409,
    `HTTP ${fourth.status} ${fourth.body.error || ""}`.trim());

  // ---- the full second restart, to be sure the cap is not in-process -------
  await stopServer(server);
  server = null;
  await sleep(300);
  server = await startServer();
  const fifth = await api("POST", "/api/charge", { trigger: "CCREJECT-IF", job_id: jobId });
  check("cap still refused after a second restart", fifth.status === 409,
    `HTTP ${fifth.status} ${fifth.body.error || ""}`.trim());
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