// Runs eval/cases.json through the real model and the same prompt + guard code the desk uses.
// Needs the same .env as the app. No server is started.
//
// Usage:
//   node eval/run.mjs                    all 29 cases, one rep, writes eval/results-latest.json
//   node eval/run.mjs --judgment --reps 5  the 8 note-driven cases, five reps
//
// A single temperature-0 run is one sample, not a rate. `--reps` exists so the submission can
// say "passed N of 8 in k of 5 runs" instead of quoting one lucky number. Partial runs never
// overwrite results-latest.json unless --out says so.
import { createRequire } from "node:module";
import { readFileSync, writeFileSync, existsSync, copyFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const { buildDecision, askGemma, syntheticOrder, aiConfig, MAX_ATTEMPTS } = require("../server.js");

const argv = process.argv.slice(2);
const flag = (name) => argv.includes("--" + name);
const value = (name, fallback) => {
  const i = argv.indexOf("--" + name);
  if (i < 0 || i === argv.length - 1) return fallback;
  const n = Number(argv[i + 1]);
  return Number.isFinite(n) ? n : fallback;
};

const judgmentOnly = flag("judgment");
const reps = Math.max(1, value("reps", 1));
const pauseMs = value("pause", 4000);
const outFile = (() => {
  const i = argv.indexOf("--out");
  if (i >= 0 && argv[i + 1]) return path.resolve(argv[i + 1]);
  return judgmentOnly || reps > 1 ? null : path.join(here, "results-latest.json");
})();

const allCases = JSON.parse(readFileSync(path.join(here, "cases.json"), "utf8")).cases;
const cases = judgmentOnly ? allCases.filter((c) => c.judgment) : allCases;
if (aiConfig().kind === "none") {
  console.error("No AI key set in .env. The eval calls the real model.");
  process.exit(2);
}

// Code-only baseline: no note, no model. Retry the same card later unless the code can't be retried,
// then a new link; stop at the attempt cap. Its wait is a fixed 72 hours (the middle of the
// 1..168 range), so it can still pass a wait_window case if 72 happens to fall inside.
// It is always reported next to Gemma's result.
const BASELINE_NO_RETRY = ["9500", "9520", "5180", "5400", "1330"];
const BASELINE_WAIT_HOURS = 72;
function baselineMove(code, attempt) {
  if (attempt >= MAX_ATTEMPTS) return { next_step: "stop_chasing", wait_hours: null };
  if (["9500", "9520", "5180"].includes(code)) return { next_step: "stop_chasing", wait_hours: null };
  if (BASELINE_NO_RETRY.includes(code)) return { next_step: "new_checkout_link", wait_hours: null };
  return { next_step: "retry_same_card_later", wait_hours: BASELINE_WAIT_HOURS };
}
function passes(c, move) {
  if (!move || !c.expected.includes(move.next_step)) return false;
  if (c.wait_window) {
    const h = move.wait_hours;
    if (!Number.isInteger(h) || h < c.wait_window[0] || h > c.wait_window[1]) return false;
  }
  return true;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One model call for one case. Two tries: a transient 429 should not be scored as a wrong answer.
async function runCaseOnce(c) {
  const order = syntheticOrder(c.code);
  const earlier = Array.from({ length: c.attempt - 1 }, () => ({ capture_status: "DECLINED", code: c.code }));
  let raw = null;
  let aiError = null;
  let model = null;
  for (let tries = 0; tries < 2; tries++) {
    try {
      const ai = await askGemma({ order, code: c.code, note: c.note, earlier, attempt: c.attempt, now: c.now });
      model = ai.model;
      raw = ai.raw;
      aiError = raw ? null : ai.parse_error;
      break;
    } catch (err) {
      aiError = err.message || String(err);
      await sleep(pauseMs);
    }
  }
  const d = buildDecision({ order, raw, attempt: c.attempt, aiError });
  return { d, raw, aiError, model };
}

console.log(`running ${cases.length} case(s) × ${reps} rep(s)${judgmentOnly ? " — judgment only" : ""}\n`);

const rows = [];
for (const c of cases) {
  const row = {
    id: c.id,
    judgment: !!c.judgment,
    code: c.code,
    attempt: c.attempt,
    note: c.note,
    now: c.now || null,
    expected: c.expected,
    wait_window: c.wait_window || null,
    baseline: baselineMove(c.code, c.attempt),
    baseline_pass: passes(c, baselineMove(c.code, c.attempt)),
    runs: [],
  };
  for (let r = 1; r <= reps; r++) {
    const { d, raw, aiError, model } = await runCaseOnce(c);
    const run = {
      rep: r,
      model,
      proposed: d.proposed,
      final: d.final,
      vetoed: d.vetoed,
      veto_reason: d.veto_reason,
      decided_by: d.decided_by,
      fallback_reason: d.fallback_reason,
      ai_error: aiError,
      pass: passes(c, d.final),
    };
    row.runs.push(run);
    const prop = run.proposed ? run.proposed.next_step + (run.proposed.wait_hours ? " " + run.proposed.wait_hours + "h" : "") : "none";
    console.log(
      `rep ${r}/${reps}  ${run.pass ? "PASS" : "FAIL"}  ${c.id.padEnd(26)} ${c.code} #${c.attempt}  ` +
        `proposed=${prop}  final=${d.final.next_step}  vetoed=${d.vetoed}  by=${d.decided_by}`
    );
    if (r < reps) await sleep(pauseMs);
  }
  const passCount = row.runs.filter((x) => x.pass).length;
  row.pass_count = passCount;
  row.pass_rate = passCount / reps;
  row.stable = passCount === reps ? "pass" : passCount === 0 ? "fail" : "unstable";
  // The representative run for prose: the last one, which is as arbitrary as any single run.
  const last = row.runs[row.runs.length - 1];
  row.proposed = last.proposed;
  row.final = last.final;
  row.vetoed = last.vetoed;
  row.veto_reason = last.veto_reason;
  row.decided_by = last.decided_by;
  row.fallback_reason = last.fallback_reason;
  row.ai_error = last.ai_error;
  row.gemma_pass = last.pass;
  rows.push(row);
  if (reps > 1) console.log(`   → ${passCount}/${reps} passes (${row.stable})\n`);
}

const count = (list, f) => list.filter(f).length;
function block(list) {
  const totalRuns = list.length * reps;
  const totalPasses = list.reduce((n, r) => n + r.pass_count, 0);
  return {
    cases: list.length,
    gemma_pass: count(list, (r) => r.gemma_pass),
    baseline_pass: count(list, (r) => r.baseline_pass),
    reps,
    runs: totalRuns,
    passes: totalPasses,
    pass_rate: totalRuns ? Number((totalPasses / totalRuns).toFixed(3)) : null,
    cases_passed_in_every_rep: count(list, (r) => r.stable === "pass"),
    cases_failed_in_every_rep: count(list, (r) => r.stable === "fail"),
    cases_unstable: count(list, (r) => r.stable === "unstable"),
    baseline_pass_single_run: count(list, (r) => r.baseline_pass),
    vetoed: count(list, (r) => r.runs.some((x) => x.vetoed)),
    fallbacks: count(list, (r) => r.runs.some((x) => x.decided_by === "fallback")),
    ai_errors: count(list, (r) => r.runs.some((x) => x.ai_error)),
  };
}

const windowRows = rows.filter((r) => r.wait_window);
const summary = {
  ran_at: new Date().toISOString(),
  model: rows.flatMap((r) => r.runs.map((x) => x.model)).find(Boolean) || null,
  mode: judgmentOnly ? "judgment" : "all",
  reps,
  all: block(rows),
  judgment_only: block(rows.filter((r) => r.judgment)),
  non_judgment: block(rows.filter((r) => !r.judgment)),
  wait_window: block(windowRows),
  unstable_cases: rows.filter((r) => r.stable === "unstable").map((r) => ({
    id: r.id,
    pass_count: r.pass_count,
    reps,
    finals: r.runs.map((x) => x.final && x.final.next_step),
  })),
};

console.log("\n" + JSON.stringify(summary, null, 2));
if (outFile) {
  if (outFile === path.join(here, "results-latest.json") && existsSync(outFile)) {
    // Keep the previous run rather than losing the comparison it supports.
    const stamp = new Date().toISOString().slice(0, 10);
    const keep = path.join(here, `results-${stamp}-previous.json`);
    if (!existsSync(keep)) copyFileSync(outFile, keep);
  }
  writeFileSync(outFile, JSON.stringify({ summary, results: rows }, null, 2));
  console.log(`\nwrote ${path.relative(process.cwd(), outFile)}`);
} else {
  console.log("\npartial run: results not written (pass --out <file> to keep them)");
}
