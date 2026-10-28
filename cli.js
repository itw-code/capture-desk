#!/usr/bin/env node
"use strict";

// capture-desk — the command-line face of the desk.
//
// Every command calls desk.js, the same module the page's HTTP server calls, against
// the same SQLite ledger. There is no second implementation of the lock, the buyer
// lines or the attempt cap, so an agent cannot get a different answer here than a
// human gets in the browser.
//
// Exit codes: 0 ok · 1 client error (bad usage, unknown job, cap reached) · 2 PayPal or model failure.

const path = require("path");
const desk = require("./desk.js");
const { openStore, defaultStoreFile } = require("./store.js");

desk.loadEnv(path.join(__dirname, ".env"));

const USAGE = `capture-desk — guarded PayPal capture decisions for agents

  capture-desk status <job_id>                 job, attempts, decisions, reads
  capture-desk decide <job_id> [--refresh]     guarded next step for the latest attempt
  capture-desk charge --trigger <name> [--note "..."] [--job <id>] [--attempt <n>]
  capture-desk close <job_id>                  stop chasing; files stay locked
  capture-desk reconcile [<job_id>]            where PayPal's sources disagree
  capture-desk read <order_id>                 ask PayPal again for an order the desk charged
  capture-desk jobs [--limit <n>]              recent jobs
  capture-desk health                          keys, provider, sandbox, db path
  capture-desk triggers                        test-card triggers and their codes

Options: --db <path> (or DESK_DB) · --pretty · --help
Every command prints JSON on stdout. Nothing here can unlock files: only a capture
PayPal reports as COMPLETED does that.`;

function parseArgs(argv) {
  const out = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--pretty") out.flags.pretty = true;
    else if (a === "--refresh") out.flags.refresh = true;
    else if (a === "--help" || a === "-h") out.flags.help = true;
    else if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) out.flags[key] = true;
      else {
        out.flags[key] = next;
        i++;
      }
    } else out._.push(a);
  }
  return out;
}

function emit(value, pretty) {
  process.stdout.write(JSON.stringify(value, null, pretty ? 2 : 0) + "\n");
}

function clientError(message, hint) {
  emit({ error: message, ...(hint ? { hint } : {}) });
  process.exitCode = 1;
}

function fatal(err) {
  const status = err.status || 0;
  emit({ error: err.message || String(err), ...(status ? { http_status: status } : {}) });
  process.exitCode = status === 404 || status === 409 || status === 400 ? 1 : 2;
}

async function main() {
  const { _, flags } = parseArgs(process.argv.slice(2));
  const [cmd, arg] = _;

  if (flags.help || !cmd) {
    process.stdout.write(USAGE + "\n");
    process.exitCode = cmd || flags.help ? 0 : 1;
    return;
  }

  const store = openStore(typeof flags.db === "string" ? flags.db : defaultStoreFile());
  const D = desk.createDesk({ store });
  try {
    switch (cmd) {
      case "status": {
        if (!arg) return clientError("status needs a job id", "capture-desk status job_ab12cd34");
        const detail = D.status(arg);
        // The raw PayPal order body is 3 KB of noise for a caller that wants the answer.
        // Keep it behind --full; the summary carries every field a decision needs.
        if (flags.full === true) return emit(detail, flags.pretty);
        return emit(
          {
            ...detail,
            attempts: detail.attempts.map((a) => ({
              order_id: a.order_id,
              attempt_no: a.attempt_no,
              capture_status: a.capture_status,
              code: a.code,
              at: a.at,
              envelope: a.envelope,
              reads: a.reads,
            })),
          },
          flags.pretty
        );
      }
      case "decide": {
        if (!arg) return clientError("decide needs a job id", "capture-desk decide job_ab12cd34");
        return emit(await D.decide({ jobId: arg, refresh: flags.refresh === true }), flags.pretty);
      }
      case "charge": {
        const trigger = typeof flags.trigger === "string" ? flags.trigger : null;
        if (!trigger) return clientError("charge needs --trigger", "capture-desk charge --trigger CCREJECT-IF --note \"payday Friday\"");
        if (!desk.TRIGGERS[trigger]) {
          return clientError(`unknown trigger ${trigger}`, "capture-desk triggers");
        }
        const attemptNo = flags.attempt === undefined ? undefined : Number(flags.attempt);
        if (attemptNo !== undefined && !Number.isInteger(attemptNo)) return clientError("--attempt must be a whole number");
        const out = await D.charge({
          trigger,
          note: typeof flags.note === "string" ? flags.note : "",
          jobId: typeof flags.job === "string" ? flags.job : undefined,
          attemptNo,
        });
        if (out.error) {
          emit({ error: out.error, http_status: out.status, paypal: out.body }, flags.pretty);
          process.exitCode = out.status === 404 || out.status === 409 ? 1 : 2;
          return;
        }
        if (out.replay) {
          return emit(
            { replay: true, note: "this attempt was already charged; no second PayPal order was made", order_id: out.order && out.order.id, job: out.job },
            flags.pretty
          );
        }
        const capture = desk.firstCapture(out.order);
        return emit(
          {
            order_id: out.order.id,
            order_status: out.order.status,
            capture_status: capture && capture.status,
            response_code: (capture && capture.processor_response && capture.processor_response.response_code) || null,
            files_locked: !capture || String(capture.status).toUpperCase() !== "COMPLETED",
            attempt: out.attempt_no,
            max_attempts: desk.MAX_ATTEMPTS,
            job: out.job,
          },
          flags.pretty
        );
      }
      case "close": {
        if (!arg) return clientError("close needs a job id", "capture-desk close job_ab12cd34");
        return emit(D.close(arg), flags.pretty);
      }
      case "reconcile": {
        return emit(D.reconcile(arg), flags.pretty);
      }
      case "read": {
        if (!arg) return clientError("read needs an order id the desk charged", "capture-desk read 41W64025MT1899746");
        return emit(await D.reread(arg), flags.pretty);
      }
      case "jobs": {
        const limit = Number(flags.limit) || 20;
        return emit({ jobs: store.listJobs(limit).map(desk.jobView) }, flags.pretty);
      }
      case "health": {
        return emit(await D.liveHealth(), flags.pretty);
      }
      case "triggers": {
        return emit(desk.TRIGGERS, flags.pretty);
      }
      default:
        return clientError(`unknown command ${cmd}`, "capture-desk --help");
    }
  } catch (err) {
    fatal(err);
  } finally {
    store.close();
  }
}

main().catch((err) => {
  fatal(err);
});
