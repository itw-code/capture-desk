"use strict";

// The desk itself: guards, PayPal client, model client, and the job operations.
//
// Every interface is a thin adapter over this file — the HTTP server, the CLI, and the
// MCP server all call the same functions against the same SQLite ledger. That is the
// point of the agent-tool step: an agent that calls the CLI cannot get a different
// answer than the page, and cannot get an unguarded one, because there is only one
// implementation of the lock, the buyer lines and the attempt cap.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { openStore, defaultStoreFile, MAX_ATTEMPTS } = require("./store.js");

const PAYPAL = "https://api-m.sandbox.paypal.com";
const CARD = "4012888888881881";

const TRIGGERS = {
  "CCREJECT-IF": { code: "5120", meaning: "INSUFFICIENT_FUNDS" },
  "CCREJECT-REFUSED": { code: "0500", meaning: "DO_NOT_HONOR" },
  "CCREJECT-EC": { code: "5400", meaning: "EXPIRED_CARD" },
  "CCREJECT-SF": { code: "9500", meaning: "SUSPECTED_FRAUD", retry: "do_not_retry" },
  "CCREJECT-LS": { code: "9520", meaning: "LOST_OR_STOLEN", retry: "do_not_retry" },
  "CCREJECT-IRC": { code: "5180", meaning: "INVALID_OR_RESTRICTED_CARD", retry: "do_not_retry" },
  "CCREJECT-BANK_ERROR": { code: "5100", meaning: "GENERIC_DECLINE" },
  "CCREJECT-IA": { code: "1330", meaning: "INVALID_ACCOUNT" },
  "Sandbox Buyer": { meaning: "NO_REJECTION_TRIGGER" },
};

// The freelancer's next step after a declined capture. Gemma proposes one of these;
// the guards below can veto it. A veto never silently swaps in a move Gemma did not pick.
const MOVES = ["retry_same_card_later", "new_checkout_link", "stop_chasing"];
const NOTE_MAX = 280;
// The freelancer works in WIB (UTC+7, no daylight saving). Gemma gets the time and weekday in this zone
// so "payday is Friday" can be turned into a real wait_hours instead of a guess.
const DESK_TZ_OFFSET_HOURS = 7;
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

// now: a Date or anything Date accepts; defaults to the current time. Pure, so it can be tested offline.
function deskClock(now = new Date()) {
  const d = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(d.getTime())) throw new Error("deskClock needs a valid time");
  const local = new Date(d.getTime() + DESK_TZ_OFFSET_HOURS * 3600 * 1000);
  return {
    now_utc: d.toISOString(),
    now_local: local.toISOString().slice(0, 19) + "+0" + DESK_TZ_OFFSET_HOURS + ":00",
    weekday: WEEKDAYS[local.getUTCDay()],
    tz: "UTC+" + DESK_TZ_OFFSET_HOURS + " (WIB)",
  };
}
// PayPal's Orders v2 text says "Try using another card. Do not retry the same card." for these.
const PAYPAL_NO_RETRY = ["9500", "9520", "5180"];
// Same card cannot succeed later: expired card, invalid account.
const SAME_CARD_DEAD = ["5400", "1330"];
const MEANINGS = Object.fromEntries(Object.values(TRIGGERS).filter((t) => t.code).map((t) => [t.code, t.meaning]));

// A reason that says the money arrived is refused: the capture did not clear.
const PAID_CLAIM = /already received|payment (was|has been|is) received|we received your payment|(you|they|he|she|buyer)(?:'ve| has| have)? (been )?paid in full|money (has |have )?(arrived|landed|cleared)|funds (have |has |were )?(arrived|cleared|received|credited)|payment (cleared|went through|succeeded|is complete)/i;

// A reason that tells the buyer to switch cards is refused: the desk never says use a different card.
const DIFFERENT_CARD = /\b(?:different|another|other|new|second|backup|alternate|alternative|separate)\s+(?:credit\s+|debit\s+|payment\s+|bank\s+)?cards?\b|\bswitch(?:es|ed|ing)?\s+(?:to\s+)?(?:a\s+|their\s+|your\s+|the\s+)?cards?\b|\bchange\s+(?:the\s+|their\s+|your\s+|of\s+)?cards?\b|\bcard\s+swap\b/i;

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

function aiConfig() {
  if (process.env.KENARI_API_KEY) {
    return {
      kind: "kenari",
      provider: "kenari",
      model: process.env.AI_MODEL || "step-3-7-flash:free",
      url: (process.env.AI_BASE_URL || "https://kenari.id/v1") + "/chat/completions",
      key: process.env.KENARI_API_KEY,
    };
  }
  if (process.env.OPENAI_API_KEY) {
    return {
      kind: "openai",
      provider: "openai",
      model: process.env.AI_MODEL || "gpt-4o-mini",
      url: "https://api.openai.com/v1/chat/completions",
      key: process.env.OPENAI_API_KEY,
    };
  }
  if (process.env.GEMINI_API_KEY) {
    const model = process.env.AI_MODEL || "gemma-4-31b-it";
    return {
      kind: "gemini",
      provider: model.startsWith("gemma") ? "gemma" : "gemini",
      model,
      key: process.env.GEMINI_API_KEY,
    };
  }
  return { kind: "none" };
}

async function complete(user, system) {
  const cfg = aiConfig();
  if (cfg.kind === "none") throw new Error("no AI key set");
  if (cfg.kind === "gemini") return completeGemini(cfg, user, system);
  const res = await fetch(cfg.url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${cfg.key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: cfg.model,
      temperature: 0,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${cfg.provider} ${res.status}: ${body.error?.message || JSON.stringify(body).slice(0, 300)}`);
  const text = body.choices?.[0]?.message?.content;
  if (!text) throw new Error(`${cfg.provider} returned no content`);
  return { provider: cfg.provider, model: body.model || cfg.model, text };
}

async function completeGemini(cfg, user, system) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${cfg.model}:generateContent`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": cfg.key },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts: [{ text: user }] }],
      generationConfig: { temperature: 0 },
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`gemini ${res.status}: ${body.error?.message || JSON.stringify(body).slice(0, 300)}`);
  const parts = body.candidates?.[0]?.content?.parts || [];
  const text = parts.filter((p) => !p.thought).map((p) => p.text || "").join("");
  if (!text) throw new Error("gemini returned no content");
  return { provider: cfg.provider, model: cfg.model, text };
}

function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced ? fenced[1] : text;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("model did not return JSON");
  return JSON.parse(raw.slice(start, end + 1));
}

// ---------------------------------------------------------------------------
// PayPal
// ---------------------------------------------------------------------------

let tokenCache = null;

async function accessToken() {
  const now = Date.now();
  if (tokenCache && tokenCache.exp > now + 15000) return tokenCache;
  const id = process.env.PAYPAL_CLIENT_ID;
  const secret = process.env.PAYPAL_CLIENT_SECRET;
  if (!id || !secret) throw new Error("PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET are required");
  const res = await fetch(`${PAYPAL}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`PayPal auth ${res.status}: ${body.error_description || body.error || "rejected"}`);
  tokenCache = { ...body, exp: now + (body.expires_in || 300) * 1000 };
  return tokenCache;
}

// requestId: the idempotency key for this attempt. One attempt, one id — a repeat
// call with the same id returns the order PayPal already made instead of making a
// second one. Callers that are not charging an attempt may omit it.
async function paypal(method, pathname, json, requestId) {
  const token = await accessToken();
  const res = await fetch(PAYPAL + pathname, {
    method,
    headers: {
      Authorization: `Bearer ${token.access_token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      Prefer: "return=representation",
      ...(method === "POST" ? { "PayPal-Request-Id": requestId || crypto.randomUUID() } : {}),
    },
    body: json === undefined ? undefined : JSON.stringify(json),
  });
  const text = await res.text();
  let body = {};
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = { raw: text.slice(0, 500) };
    }
  }
  if (res.status === 401) tokenCache = null;
  return { status: res.status, body };
}

function chargeBody(trigger) {
  return {
    intent: "CAPTURE",
    purchase_units: [
      {
        description: "Freelance delivery: final files",
        amount: { currency_code: "USD", value: "25.00" },
      },
    ],
    payment_source: {
      card: {
        number: CARD,
        expiry: "2030-12",
        security_code: "123",
        name: trigger,
        billing_address: {
          address_line_1: "2211 N First Street",
          admin_area_2: "San Jose",
          admin_area_1: "CA",
          postal_code: "95131",
          country_code: "US",
        },
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Order shape
// ---------------------------------------------------------------------------

function firstCapture(order) {
  const units = order.purchase_units || [];
  for (const unit of units) {
    const captures = unit.payments && unit.payments.captures;
    if (captures && captures.length) return captures[0];
  }
  return null;
}

function slim(order) {
  return {
    id: order.id,
    status: order.status,
    captures: (order.purchase_units || []).flatMap((unit) => (unit.payments && unit.payments.captures) || []).map(slimCapture),
  };
}

function slimCapture(capture) {
  return {
    id: capture.id,
    status: capture.status,
    amount: capture.amount,
    processor_response: capture.processor_response || null,
  };
}

// ---------------------------------------------------------------------------
// Guards and the decision
// ---------------------------------------------------------------------------

function allowedMoves(code, attempt) {
  if (attempt >= MAX_ATTEMPTS) return ["stop_chasing"];
  // Suspected fraud, lost or stolen, restricted: the desk stops or the freelancer decides. No new link either,
  // because a fresh checkout on these codes is just "try another card" by another route.
  if (PAYPAL_NO_RETRY.includes(code)) return ["stop_chasing"];
  const noRetry = SAME_CARD_DEAD.includes(code);
  return MOVES.filter((m) => !(noRetry && m === "retry_same_card_later"));
}

function cleanNote(note) {
  return String(note || "").replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, NOTE_MAX);
}

function parseProposal(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { why: "Gemma's answer was not a JSON object." };
  const move = typeof raw.next_step === "string" ? raw.next_step.trim() : "";
  if (!MOVES.includes(move)) return { why: "Gemma named a move the desk does not offer." };
  let hours = null;
  if (move === "retry_same_card_later") {
    hours = Number(raw.wait_hours);
    if (!Number.isInteger(hours) || hours < 1 || hours > 168) return { why: "Gemma gave a retry wait outside 1 to 168 hours." };
  }
  const reason = typeof raw.reason === "string" ? raw.reason.trim() : "";
  if (!reason) return { why: "Gemma gave no reason." };
  if (reason.length > 140) return { why: "Gemma's reason ran past 140 characters." };
  if (/dispute/i.test(reason)) return { why: "Gemma's reason used a word the desk does not use." };
  if (PAID_CLAIM.test(reason)) return { why: "Gemma's reason claimed the payment arrived." };
  if (DIFFERENT_CARD.test(reason)) return { why: "Gemma's reason told the buyer to use a different card." };
  return { proposed: { next_step: move, wait_hours: hours, reason } };
}

function vetoReason(code, attempt, move) {
  if (move === "retry_same_card_later") {
    if (PAYPAL_NO_RETRY.includes(code)) return `PayPal says don't retry the same card on ${code}.`;
    if (code === "5400") return "That card is expired, so retrying it later can't work (5400).";
    if (code === "1330") return "PayPal flagged an invalid account, so retrying the same card can't work (1330).";
  }
  if (move === "new_checkout_link" && PAYPAL_NO_RETRY.includes(code) && attempt < MAX_ATTEMPTS) {
    return `PayPal flagged this card on ${code}, so the desk won't invite another payment. Stop, or decide yourself.`;
  }
  return `This job has used ${attempt} of ${MAX_ATTEMPTS} attempts, so only stopping is allowed.`;
}

// Decision rules, in one place:
// - Only a COMPLETED capture unlocks the files. Everything else stays locked.
// - Buyer lines are the desk's, never the model's.
// - Gemma proposes the next step on a DECLINED capture only. The guard can veto it.
// - A veto never picks for Gemma: final is ask_freelancer unless exactly one allowed move is left.
// - Unusable model output is never guessed at: final is ask_freelancer, decided_by fallback.
function buildDecision({ order, raw, attempt, aiError }) {
  const capture = firstCapture(order);
  const status = capture ? String(capture.status || "").toUpperCase() : "";
  const declined = status === "DECLINED";
  const cleared = status === "COMPLETED";
  const code = capture && capture.processor_response ? String(capture.processor_response.response_code || "") : "";
  const doNotRetry = PAYPAL_NO_RETRY.includes(code);
  let buyer = null;
  if (declined) {
    buyer = doNotRetry
      ? "Do not retry this card. PayPal response code " + code + "."
      : "The charge didn't clear." + (code ? " PayPal response code " + code + "." : "");
  }
  const decision = {
    fulfill: cleared,
    files_locked: !cleared,
    order_status: order.status || null,
    capture_status: capture ? capture.status : null,
    retry: cleared ? "none" : declined && doNotRetry ? "do_not_retry" : null,
    buyer_line: "shown",
    buyer_message: buyer,
    processor_code: code || null,
    attempt,
    max_attempts: MAX_ATTEMPTS,
    paid_on_attempt: cleared ? attempt : null,
    proposed: null,
    final: null,
    vetoed: false,
    veto_reason: null,
    fallback_reason: null,
    allowed: [],
    decided_by: "guard",
  };
  if (!declined) return decision;
  const allowed = allowedMoves(code, attempt);
  decision.allowed = allowed;
  const ask = { next_step: "ask_freelancer", wait_hours: null };
  const parsed = aiError ? { why: "Gemma could not be reached: " + aiError } : parseProposal(raw);
  if (!parsed.proposed) {
    decision.final = ask;
    decision.fallback_reason = parsed.why;
    decision.decided_by = "fallback";
    return decision;
  }
  const p = parsed.proposed;
  decision.proposed = p;
  if (allowed.includes(p.next_step)) {
    decision.final = { next_step: p.next_step, wait_hours: p.wait_hours };
    decision.decided_by = "gemma";
    return decision;
  }
  decision.vetoed = true;
  decision.veto_reason = vetoReason(code, attempt, p.next_step);
  // Only the attempt cap picks for Gemma. Any other veto hands the call back to the freelancer.
  decision.final = attempt >= MAX_ATTEMPTS ? { next_step: "stop_chasing", wait_hours: null } : ask;
  decision.decided_by = "guard";
  return decision;
}

async function askGemma({ order, code, note, earlier, attempt, now }) {
  const allowed = allowedMoves(code, attempt);
  const system = [
    "You are the step after a declined card capture. You choose the freelancer's next step for one job.",
    "The money did not arrive. Never say or imply that it did.",
    "Pick exactly one move from allowed_moves. Moves:",
    "retry_same_card_later = run the same card again after wait_hours (a whole number from 1 to 168). Use it when time can fix the decline, for example insufficient funds before a payday the note mentions.",
    "new_checkout_link = the buyer pays again on a fresh checkout link and may choose another payment method.",
    "stop_chasing = release the slot. The files stay locked.",
    "Use the freelancer note, the earlier attempts, and the attempt number. Do not pick a move that is not in allowed_moves.",
    "current_time gives the time right now in the freelancer's zone and the weekday. When the note names a day, for example payday is Friday, compute wait_hours as whole hours from current_time until the morning of that day, instead of guessing.",
    "reason is ONE sentence for the freelancer, at most 140 characters, plain words. Do not use the word dispute. Never tell the buyer to use a different card.",
    "Return JSON only: next_step, wait_hours (null unless next_step is retry_same_card_later), reason.",
  ].join(" ");
  const user = JSON.stringify({
    order: slim(order),
    response_code: code,
    meaning: MEANINGS[code] || null,
    freelancer_note: cleanNote(note) || null,
    earlier_attempts: (earlier || []).map((a) => ({ capture_status: a.capture_status, code: a.code })),
    attempt,
    max_attempts: MAX_ATTEMPTS,
    current_time: deskClock(now),
    allowed_moves: allowed,
  });
  const ai = await complete(user, system);
  let raw = null;
  let parse_error = null;
  try {
    raw = extractJson(ai.text);
  } catch (err) {
    parse_error = "Gemma did not return JSON.";
  }
  return { provider: ai.provider, model: ai.model, raw, parse_error, text: ai.text, allowed };
}

function syntheticOrder(code, status = "DECLINED") {
  const capture = { id: "CAP", status, amount: { currency_code: "USD", value: "25.00" } };
  if (code) capture.processor_response = { response_code: code };
  return { id: "ORDER", status: "COMPLETED", purchase_units: [{ payments: { captures: [capture] } }] };
}

function assertGuards() {
  const must = (ok, msg) => {
    if (!ok) throw new Error(msg);
  };
  const good = (move, hours, reason = "Repeat client who said payday is Friday.") => ({ next_step: move, wait_hours: hours, reason });
  const run = (code, status, raw, attempt = 1) => buildDecision({ order: syntheticOrder(code, status), raw, attempt });

  // Statuses and locks.
  const declined = run("5120", "DECLINED", good("retry_same_card_later", 72));
  must(declined.files_locked === true && declined.fulfill === false, "declined capture did not lock the files");
  must(declined.order_status === "COMPLETED" && declined.capture_status === "DECLINED", "the two statuses were collapsed");
  const pending = run(null, "PENDING", good("retry_same_card_later", 72));
  must(pending.files_locked === true && pending.fulfill === false, "pending capture was allowed to unlock the files");
  must(pending.final === null && pending.proposed === null && pending.buyer_message === null, "pending capture got a Gemma move or a buyer line");
  const cleared = run("0000", "COMPLETED", good("stop_chasing", null), 2);
  must(cleared.files_locked === false && cleared.fulfill === true, "completed capture did not unlock");
  must(cleared.final === null && cleared.proposed === null && cleared.buyer_message === null, "completed capture got a next step or a buyer line");
  must(cleared.paid_on_attempt === 2, "completed capture did not record the paying attempt");

  // Buyer lines stay exact for all eight codes, whatever the model says.
  for (const code of ["5120", "5400", "0500", "5100", "1330"]) {
    const d = run(code, "DECLINED", good("new_checkout_link", null));
    must(d.buyer_message === "The charge didn't clear. PayPal response code " + code + ".", "buyer line changed for " + code);
    must(d.retry === null, "retry was set for " + code);
  }
  for (const code of ["9500", "9520", "5180"]) {
    const d = run(code, "DECLINED", good("new_checkout_link", null));
    must(d.buyer_message === "Do not retry this card. PayPal response code " + code + ".", "buyer line changed for " + code);
    must(d.retry === "do_not_retry", "do-not-retry code was not held back for " + code);
    must(d.files_locked === true, "files unlocked on " + code);
  }

  // Veto table.
  for (const code of ["9500", "9520", "5180", "5400", "1330"]) {
    const d = run(code, "DECLINED", good("retry_same_card_later", 72));
    must(d.vetoed === true && d.proposed.next_step === "retry_same_card_later", "retry on " + code + " was not vetoed");
    must(d.final.next_step === "ask_freelancer" && d.decided_by === "guard", "veto on " + code + " picked a move for Gemma");
    must(d.veto_reason && d.veto_reason.includes(code), "veto on " + code + " did not cite the rule");
  }
  must(run("9500", "DECLINED", good("retry_same_card_later", 72)).veto_reason === "PayPal says don't retry the same card on 9500.", "9500 veto sentence changed");
  const ok = run("5120", "DECLINED", good("retry_same_card_later", 72));
  must(ok.vetoed === false && ok.final.next_step === "retry_same_card_later" && ok.final.wait_hours === 72 && ok.decided_by === "gemma", "5120 retry 72 was not allowed");
  for (const code of ["9500", "9520", "5180"]) {
    const d = run(code, "DECLINED", good("new_checkout_link", null));
    must(d.vetoed === true && d.final.next_step === "ask_freelancer" && d.decided_by === "guard", "new checkout link on " + code + " was not vetoed to the freelancer");
    must(d.veto_reason.includes(code), "new-link veto on " + code + " did not cite the code");
    must(JSON.stringify(d.allowed) === JSON.stringify(["stop_chasing"]), "allowed moves on " + code + " were not stop only");
    const s = run(code, "DECLINED", good("stop_chasing", null));
    must(s.vetoed === false && s.final.next_step === "stop_chasing", "stop_chasing on " + code + " was vetoed");
  }
  must(run("5400", "DECLINED", good("new_checkout_link", null)).vetoed === false, "new checkout link on 5400 was vetoed");

  // Attempt cap: only stop_chasing.
  for (const move of ["retry_same_card_later", "new_checkout_link"]) {
    const d = run("5120", "DECLINED", good(move, move === "retry_same_card_later" ? 24 : null), 3);
    must(d.vetoed === true && d.final.next_step === "stop_chasing" && d.decided_by === "guard", "attempt 3 allowed " + move);
  }
  const stop = run("5120", "DECLINED", good("stop_chasing", null), 3);
  must(stop.vetoed === false && stop.final.next_step === "stop_chasing", "stop_chasing at the cap was vetoed");

  // Unusable output falls back to ask_freelancer, never a guess.
  const garbage = [
    null,
    "nonsense",
    { next_step: "refund_buyer", wait_hours: null, reason: "Refund them." },
    { next_step: "retry_same_card_later", wait_hours: 500, reason: "Wait a while." },
    { next_step: "retry_same_card_later", wait_hours: "soon", reason: "Wait a while." },
    { next_step: "stop_chasing", wait_hours: null, reason: "" },
    { next_step: "stop_chasing", wait_hours: null, reason: "x".repeat(141) },
    { next_step: "stop_chasing", wait_hours: null, reason: "We already received your payment." },
    { next_step: "stop_chasing", wait_hours: null, reason: "This looks like a dispute." },
    { next_step: "new_checkout_link", wait_hours: null, reason: "Send a fresh link so the buyer can use a different card." },
    { next_step: "new_checkout_link", wait_hours: null, reason: "Ask them to try another credit card." },
    { next_step: "stop_chasing", wait_hours: null, reason: "Buyer should switch to a new card." },
  ];
  for (const raw of garbage) {
    const d = run("5120", "DECLINED", raw);
    must(d.final.next_step === "ask_freelancer" && d.decided_by === "fallback" && d.vetoed === false, "unusable model output was not a fallback: " + JSON.stringify(raw));
  }
  // Date grounding is offline-testable: 2026-10-06 03:00Z is Tuesday 10:00 in WIB.
  const clock = deskClock("2026-10-06T03:00:00Z");
  must(clock.weekday === "Tuesday" && clock.now_local === "2026-10-06T10:00:00+07:00", "deskClock gave the wrong WIB time: " + JSON.stringify(clock));
  must(deskClock("2026-10-06T18:00:00Z").weekday === "Wednesday", "deskClock did not roll the weekday over in WIB");
  const unreachable = buildDecision({ order: syntheticOrder("5120"), raw: null, attempt: 1, aiError: "timeout" });
  must(unreachable.decided_by === "fallback", "unreachable model was not a fallback");
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

function notBeforeFor(decidedAt, waitHours) {
  if (!Number.isInteger(waitHours)) return null;
  return new Date(new Date(decidedAt).getTime() + waitHours * 3600 * 1000).toISOString();
}

function jobView(job) {
  return {
    id: job.id,
    note: job.note,
    attempts: job.attempts.slice(),
    attempt: job.attempts.length,
    max_attempts: MAX_ATTEMPTS,
    closed: job.closed,
    paid_on: job.paid_on,
  };
}

// Rebuild the decision envelope a caller would have received, from the ledger alone.
// The guard fields (lock, buyer line, allowed moves) are recomputed so a stored row can
// never drift into a weaker claim than the current guards would make.
function decisionFromRow(store, row) {
  const order = store.getOrder(row.order_id);
  const capture = order ? firstCapture(order) : null;
  const base = capture
    ? buildDecision({ order, raw: row.proposed, attempt: row.attempt_no, aiError: row.decided_by === "fallback" ? row.fallback_reason : null })
    : {};
  return {
    ...base,
    proposed: row.proposed,
    final: row.final,
    vetoed: row.vetoed,
    veto_reason: row.veto_reason,
    fallback_reason: row.fallback_reason,
    decided_by: row.decided_by,
    not_before: row.not_before,
    decided_at: row.decided_at,
    attempt: row.attempt_no,
  };
}

// The deterministic part of a decision: everything the guards decide from the capture
// alone. No model, no stored row, nothing invented — the same code path that writes a
// real decision, so a caller can never see a weaker lock than the guards enforce.
function guardFields(order, attempt) {
  return buildDecision({ order, raw: null, attempt });
}

// The envelope for one attempt, from the ledger alone.
//
// Always returns the guard fields, decided or not. An undecided declined attempt is a
// real state — the CLI charges, the page opens later, `status` runs before `decide` —
// and it must still report `files_locked: true` and the exact buyer line. What it must
// not do is pretend a model answer exists, so `proposed`, `final` and `decided_by` stay
// null and `decided` is false. A COMPLETED capture needs no model, so `decided_by` is
// "guard" there and the files are unlocked.
function envelopeFor(store, attempt, decisionRow) {
  if (decisionRow) return { ...decisionFromRow(store, decisionRow), decided: true };
  const order = store.getOrder(attempt.order_id);
  const capture = order ? firstCapture(order) : null;
  if (!order || !capture) return null;
  const status = String(capture.status || "").toUpperCase();
  const base = guardFields(order, attempt.attempt_no);
  if (status === "COMPLETED") {
    return { ...base, proposed: null, final: null, vetoed: false, veto_reason: null, fallback_reason: null, decided_by: "guard", not_before: null, decided_at: attempt.at, attempt: attempt.attempt_no, decided: true };
  }
  // DECLINED / PENDING / FAILED and not yet decided: the lock and the buyer line are
  // already facts; the next step is not.
  return { ...base, proposed: null, final: null, vetoed: false, veto_reason: null, fallback_reason: null, decided_by: null, not_before: null, decided_at: null, attempt: attempt.attempt_no, decided: false };
}

// The full job: what the page needs after a refresh, and what an agent gets from
// `capture-desk status`. Decisions are per attempt, oldest first.
function jobDetail(store, jobId) {
  const job = store.getJob(jobId);
  if (!job || !job.attempts.length) return null;
  const decisions = store.decisionsForJob(job.id);
  const byOrder = new Map(decisions.map((d) => [d.order_id, d]));
  const attempts = job.attempts.map((a) => {
    const d = byOrder.get(a.order_id) || null;
    return {
      order_id: a.order_id,
      attempt_no: a.attempt_no,
      capture_status: a.capture_status,
      code: a.code,
      at: a.at,
      order: store.getOrder(a.order_id),
      decision: d ? { ...d } : null,
      // The same envelope /api/decide would return, rebuilt from the ledger. A page
      // refresh or an agent that never saw the original response gets identical data.
      envelope: envelopeFor(store, a, d),
      reads: store.readsFor(a.order_id).map((r) => ({
        source: r.source,
        order_status: r.order_status,
        capture_status: r.capture_status,
        code: r.code,
        read_at: r.read_at,
      })),
    };
  });
  // The job's current answer is the newest attempt that has one. A cleared attempt
  // always does, so a paid job never reports "no decision".
  let latest = null;
  for (let i = attempts.length - 1; i >= 0; i--) {
    if (attempts[i].envelope) {
      latest = { ...attempts[i].envelope, order_id: attempts[i].order_id, attempt: attempts[i].attempt_no };
      break;
    }
  }
  return { ...jobView(job), attempts, latest };
}

// ---------------------------------------------------------------------------
// Desk operations — the only implementation of charge/decide/close.
// ---------------------------------------------------------------------------

function createDesk({ store, storeFile } = {}) {
  if (!store) store = openStore(storeFile || defaultStoreFile());

  function fail(message, status, extra) {
    return Object.assign(new Error(message), { status: status || 500, ...(extra || {}) });
  }

  // Wait for a slot another caller is charging. Returns the charged attempt, or the
  // still-claimed one when the wait runs out. Polling the ledger is what keeps two
  // simultaneous Approves down to one PayPal order without holding a lock across a
  // 30-second network call.
  async function settleSlot(jobId, attemptNo, timeoutMs = 45000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const slot = store.slot(jobId, attemptNo);
      if (!slot || slot.state === "charged") return slot;
      if (Date.now() > deadline) return slot;
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  function replayOut(slot, jobId) {
    // The same attempt was already charged: hand back the first order instead of
    // asking PayPal to make a second one for one attempt.
    return {
      status: 200,
      replay: true,
      order: store.getOrder(slot.order_id),
      job: jobView(store.getJob(jobId)),
      attempt_no: slot.attempt_no,
      request_id: slot.request_id,
    };
  }

  async function charge({ trigger, note, jobId, attemptNo } = {}) {
    const name = TRIGGERS[trigger] ? trigger : "CCREJECT-IF";
    const now = new Date().toISOString();
    let job = null;
    let created = false;
    if (jobId) {
      job = store.getJob(String(jobId));
      if (!job) throw fail("unknown job", 404);
      // Idempotency first. A retried request for an attempt that already happened is a
      // read of that attempt, so it answers even when the job has since been paid or
      // closed. Only new work is subject to those guards.
      if (attemptNo != null) {
        const settled = await settleSlot(job.id, attemptNo);
        if (settled && settled.state === "charged") return replayOut(settled, job.id);
        if (settled) throw fail("That attempt is already being charged. Try again in a moment.", 409);
      }
      if (job.closed) throw fail("This job is closed. Start a new checkout.", 409);
      if (job.paid_on) throw fail("This job is already paid. Files are unlocked.", 409);
    } else {
      job = store.ensureJob("job_" + crypto.randomUUID().slice(0, 8), cleanNote(note), now);
      created = true;
    }

    const claim = store.claimAttempt(job.id, { desiredAttempt: attemptNo });
    if (claim.refused === "cap") {
      if (created) store.dropEmptyJob(job.id);
      throw fail(`This job has used all ${MAX_ATTEMPTS} attempts.`, 409);
    }
    if (claim.refused === "stale") {
      if (created) store.dropEmptyJob(job.id);
      throw fail(`This job is on attempt ${claim.active}; attempt ${attemptNo} was already decided.`, 409);
    }
    if (claim.busy) {
      // Another caller won the race between the check above and this claim. Wait for
      // its PayPal call to land, then hand back the same order.
      const settled = await settleSlot(job.id, claim.busy.attempt_no, 60000);
      if (settled && settled.state === "charged") return replayOut(settled, job.id);
      throw fail("That attempt is already being charged. Try again in a moment.", 409);
    }
    if (claim.replay) return replayOut(claim.replay, job.id);
    let charged;
    try {
      charged = await paypal("POST", "/v2/checkout/orders", chargeBody(name), claim.requestId);
    } catch (err) {
      store.releaseAttempt(claim.attemptId);
      if (created) store.dropEmptyJob(job.id);
      throw Object.assign(err, { status: 502 });
    }

    const order = charged.body;
    const capture = charged.status < 300 ? firstCapture(order) : null;
    if (!capture) {
      store.releaseAttempt(claim.attemptId);
      if (created) store.dropEmptyJob(job.id);
      const text = (order && (order.message || order.name)) || `PayPal returned no capture (HTTP ${charged.status}).`;
      return { status: charged.status < 300 ? 502 : charged.status, error: text, body: order };
    }

    const code = (capture.processor_response && capture.processor_response.response_code) || null;
    const at = new Date().toISOString();
    store.putOrder(order.id, job.id, order, at);
    store.finishAttempt(claim.attemptId, { orderId: order.id, captureStatus: capture.status, code, at });
    if (String(capture.status).toUpperCase() === "COMPLETED") store.markPaid(job.id, claim.attemptNo);
    // The checkout response is the first source to state what happened. Keep its claim.
    store.recordRead({
      orderId: order.id,
      jobId: job.id,
      source: "checkout",
      orderStatus: order.status,
      captureStatus: capture.status,
      code,
      readAt: at,
    });
    return {
      status: charged.status,
      order,
      job: jobView(store.getJob(job.id)),
      attempt_no: claim.attemptNo,
      request_id: claim.requestId,
    };
  }

  // Runs (or returns) the guarded decision for a job's latest attempt. Cached per
  // order: calling it twice must not spend a second model call, and every caller
  // (page, CLI, MCP, another agent) must see the same numbers.
  async function decide({ jobId, orderId, refresh = false } = {}) {
    const job = store.getJob(String(jobId || ""));
    if (!job || !job.attempts.length) throw fail("unknown job. Charge first, then decide.", 404);
    const last = job.attempts[job.attempts.length - 1];
    if (orderId && orderId !== last.order_id) throw fail("this order is not the latest attempt on the job", 409);
    const order = store.getOrder(last.order_id);
    if (!order) throw fail("this desk has no stored PayPal order for that attempt", 409);
    const capture = firstCapture(order);
    if (!capture) throw fail("PayPal returned no capture. There is nothing to decide.", 409);

    const cached = store.decisionFor(last.order_id);
    if (cached && !refresh) {
      return {
        cached: true,
        provider: cached.provider,
        model: cached.model,
        decision: decisionFromRowCached(cached),
        capture: slimCapture(capture),
        job: jobView(store.getJob(job.id)),
      };
    }

    const attempt = last.attempt_no;
    const status = String(capture.status || "").toUpperCase();
    let ai = { provider: null, model: null };
    let raw = null;
    let aiError = null;
    // Gemma only runs for a declined capture. A cleared or pending capture has no next step to choose.
    if (status === "DECLINED") {
      const code = String((capture.processor_response && capture.processor_response.response_code) || "");
      try {
        ai = await askGemma({ order, code, note: job.note, earlier: job.attempts.slice(0, -1), attempt });
        raw = ai.raw;
        if (!raw) aiError = ai.parse_error || "Gemma returned no usable JSON.";
      } catch (err) {
        aiError = err.message || String(err);
      }
    }
    const decision = buildDecision({ order, raw, attempt, aiError });
    const decidedAt = new Date().toISOString();
    const notBefore = decision.final && decision.final.next_step === "retry_same_card_later"
      ? notBeforeFor(decidedAt, decision.final.wait_hours)
      : null;
    store.putDecision({
      orderId: last.order_id,
      jobId: job.id,
      attemptNo: attempt,
      provider: ai.provider,
      model: ai.model,
      proposed: decision.proposed,
      final: decision.final,
      vetoed: decision.vetoed,
      vetoReason: decision.veto_reason,
      fallbackReason: decision.fallback_reason,
      decidedBy: decision.decided_by,
      notBefore,
      decidedAt,
    });
    return {
      cached: false,
      provider: ai.provider,
      model: ai.model,
      decision: { ...decision, not_before: notBefore, decided_at: decidedAt },
      capture: slimCapture(capture),
      job: jobView(store.getJob(job.id)),
    };
  }

  function decisionFromRowCached(row) {
    return decisionFromRow(store, row);
  }

  async function reread(orderId) {
    // A fresh read of an order this desk charged, straight from PayPal. Other ids are refused.
    if (!store.ownsOrder(orderId)) throw fail("unknown order", 404);
    const read = await paypal("GET", "/v2/checkout/orders/" + encodeURIComponent(orderId));
    if (read.status >= 300) throw fail("PayPal could not read this order.", read.status);
    const capture = firstCapture(read.body);
    const readAt = new Date().toISOString();
    const code = (capture && capture.processor_response && capture.processor_response.response_code) || null;
    // A later read is a second source. It is allowed to contradict the checkout.
    store.recordRead({
      orderId: read.body.id,
      jobId: store.jobIdForOrder(read.body.id),
      source: "reread",
      orderStatus: read.body.status,
      captureStatus: capture ? capture.status : null,
      code,
      readAt,
    });
    return {
      order_id: read.body.id,
      order_status: read.body.status,
      capture_status: capture ? capture.status : null,
      response_code: code,
      read_at: readAt,
    };
  }

  function status(jobId) {
    const detail = jobDetail(store, jobId);
    if (!detail) throw fail("unknown job", 404);
    return detail;
  }

  function close(jobId) {
    const job = store.getJob(String(jobId || ""));
    if (!job) throw fail("unknown job", 404);
    if (job.paid_on) throw fail("This job is already paid.", 409);
    store.markClosed(job.id);
    return { job: jobView(store.getJob(job.id)) };
  }

  // Read-only. Counts what the sources claimed and where they disagreed. This is a
  // reconciliation view, not a reporting surface: it answers "do our sources agree"
  // and nothing about money flow, which the product does not do.
  function reconcile(jobId) {
    const summary = store.readSummary();
    let orders = store.disagreements();
    if (jobId) {
      const job = store.getJob(String(jobId));
      if (!job) throw fail("unknown job", 404);
      const mine = new Set(job.attempts.map((a) => a.order_id));
      orders = orders.filter((d) => mine.has(d.order_id));
      const reads = job.attempts.reduce((n, a) => n + store.readsFor(a.order_id).length, 0);
      return {
        job_id: job.id,
        summary: { ...summary, job_reads: reads },
        disagreeing_orders: orders.map((d) => ({
          order_id: d.order_id,
          distinct_versions: d.versions,
          reads: d.reads,
          claims: store.readsFor(d.order_id).map(claim),
        })),
      };
    }
    return {
      summary,
      disagreeing_orders: orders.map((d) => ({
        order_id: d.order_id,
        distinct_versions: d.versions,
        reads: d.reads,
        claims: store.readsFor(d.order_id).map(claim),
      })),
    };
  }

  function claim(r) {
    return {
      source: r.source,
      order_status: r.order_status,
      capture_status: r.capture_status,
      code: r.code,
      read_at: r.read_at,
    };
  }

  function health() {
    return {
      paypal: Boolean(process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET),
      ai: aiConfig().provider || aiConfig().kind,
      sandbox: PAYPAL,
      db: store.file,
    };
  }

  async function liveHealth() {
    const base = health();
    if (!base.paypal) return { ...base, paypal_ok: false };
    try {
      await accessToken();
      return { ...base, paypal_ok: true };
    } catch (err) {
      return { ...base, paypal_ok: false, paypal_error: err.message };
    }
  }

  async function selfCheck() {
    const lines = [];
    let code = 0;
    try {
      assertGuards();
      lines.push("guards: ok  only a COMPLETED capture unlocks; Gemma proposes the next step, guards veto");
    } catch (err) {
      lines.push(`guards: failed  ${err.message}`);
      code = 1;
    }
    if (!health().paypal) {
      lines.push("paypal: missing PAYPAL_CLIENT_ID or PAYPAL_CLIENT_SECRET");
      code = code || 2;
    } else {
      try {
        const token = await accessToken();
        lines.push(`paypal: ok  token=${token.token_type}`);
      } catch (err) {
        lines.push(`paypal: failed  ${err.message}`);
        code = code || 1;
      }
    }
    if (aiConfig().kind === "none") {
      lines.push("ai: missing KENARI_API_KEY, GEMINI_API_KEY, or OPENAI_API_KEY");
      code = code || 2;
    } else {
      try {
        const ping = await complete("Reply with the single word ok. No punctuation.", "You answer with exactly one word.");
        lines.push(`ai: ok  provider=${ping.provider}  model=${ping.model}  reply=${JSON.stringify(ping.text.trim())}`);
      } catch (err) {
        lines.push(`ai: failed  ${err.message}`);
        code = code || 1;
      }
    }
    return { code, lines };
  }

  return { store, charge, decide, reread, status, close, reconcile, health, liveHealth, selfCheck };
}

// .env can clear PORT, so harnesses get a knob it cannot clobber.
function loadEnv(file) {
  const seen = new Set();
  if (fs.existsSync(file)) {
    let text = fs.readFileSync(file, "utf8");
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq < 1) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      seen.add(key);
      if (value === "") delete process.env[key];
      else process.env[key] = value;
    }
  }
  for (const key of ["KENARI_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY"]) {
    if (!seen.has(key)) delete process.env[key];
  }
}

module.exports = {
  PAYPAL, CARD, TRIGGERS, MOVES, MAX_ATTEMPTS, MEANINGS, PAYPAL_NO_RETRY, SAME_CARD_DEAD, NOTE_MAX,
  deskClock, loadEnv, createDesk,
  aiConfig, complete, accessToken, paypal, chargeBody,
  firstCapture, slim, slimCapture, extractJson,
  allowedMoves, parseProposal, vetoReason, buildDecision, askGemma, syntheticOrder, assertGuards,
  cleanNote, jobView, jobDetail, notBeforeFor, defaultStoreFile,
};
