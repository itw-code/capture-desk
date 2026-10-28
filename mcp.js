#!/usr/bin/env node
"use strict";

// capture-desk MCP server (stdio, JSON-RPC 2.0, zero dependencies).
//
// Same desk.js as the CLI and the page, same SQLite ledger, same guards. It exists so
// an MCP-speaking agent (Claude Code, Codex, Hermes, a custom agent) can ask the desk
// for a payment decision instead of re-deriving capture status itself.
//
// Transport: newline-delimited JSON-RPC over stdin/stdout. Nothing is written to stdout
// except protocol messages; diagnostics go to stderr.
//
// There is deliberately no tool that unlocks files, writes buyer copy, or overrides a
// veto. The only thing that unlocks files is a capture PayPal reports as COMPLETED.

const path = require("path");
const desk = require("./desk.js");
const { openStore, defaultStoreFile, MAX_ATTEMPTS } = require("./store.js");

desk.loadEnv(path.join(__dirname, ".env"));

const SERVER_INFO = { name: "capture-desk", version: "2.0.0" };
const PROTOCOL = "2025-06-18";

const INSTRUCTIONS = [
  "Capture Desk is the payment gate for one freelancer job.",
  "Use capture_desk_decision before telling a user whether work can start.",
  "Files unlock only when PayPal reports the capture as COMPLETED; never infer that from an order status.",
  "Never write buyer copy yourself: the desk returns the exact buyer_message for the response code.",
  "Never override a veto, and never skip the three-attempt cap.",
].join(" ");

const TOOLS = [
  {
    name: "capture_desk_status",
    description:
      "Read one job: attempts, each attempt's guarded decision, and every PayPal claim recorded for it. Use this to answer 'can I send the files?' or to resume a job by id. Returns files_locked, buyer_message, the proposed and final next step, and the attempt count.",
    inputSchema: {
      type: "object",
      properties: { job_id: { type: "string", description: "Job id, e.g. job_ab12cd34." } },
      required: ["job_id"],
    },
    handler: async (a) => D.status(a.job_id),
  },
  {
    name: "capture_desk_decide",
    description:
      "Get the guarded decision for a job's latest attempt. Runs the model once on a declined capture and caches the result, so repeat calls return the same answer without another model call. Returns fulfill, files_locked, buyer_message, proposed, final, vetoed, veto_reason, decided_by, not_before.",
    inputSchema: {
      type: "object",
      properties: {
        job_id: { type: "string" },
        refresh: { type: "boolean", description: "Ask the model again instead of returning the stored decision. Costs one call." },
      },
      required: ["job_id"],
    },
    handler: async (a) => D.decide({ jobId: a.job_id, refresh: a.refresh === true }),
  },
  {
    name: "capture_desk_charge",
    description:
      "Run one live PayPal sandbox card charge and record it as an attempt on a job. Omit job_id to start a new job. Pass job_id and attempt_no to approve the next step; repeating the same attempt_no replays that attempt and does not create a second PayPal order. Returns the order id, capture status, response code and whether files are locked.",
    inputSchema: {
      type: "object",
      properties: {
        trigger: {
          type: "string",
          description: "Test-card trigger. CCREJECT-IF 5120, CCREJECT-REFUSED 0500, CCREJECT-EC 5400, CCREJECT-SF 9500, CCREJECT-LS 9520, CCREJECT-IRC 5180, CCREJECT-BANK_ERROR 5100, CCREJECT-IA 1330, 'Sandbox Buyer' clears.",
        },
        note: { type: "string", description: "Freelancer note about this buyer, up to 280 characters. Only used when starting a job." },
        job_id: { type: "string", description: "Existing job to add an attempt to." },
        attempt_no: { type: "integer", description: "Attempt slot to charge. Equal to the job's current attempt count plus one." },
      },
      required: ["trigger"],
    },
    handler: async (a) => {
      const out = await D.charge({ trigger: a.trigger, note: a.note, jobId: a.job_id, attemptNo: a.attempt_no });
      if (out.error) {
        const err = new Error(out.error);
        err.status = out.status;
        err.data = out.body;
        throw err;
      }
      if (out.replay) {
        return {
          replay: true,
          order_id: out.order && out.order.id,
          note: "this attempt was already charged; no second PayPal order was made",
          job: out.job,
        };
      }
      const capture = desk.firstCapture(out.order);
      const status = capture ? String(capture.status || "").toUpperCase() : "";
      return {
        order_id: out.order.id,
        order_status: out.order.status,
        capture_status: capture ? capture.status : null,
        response_code: (capture && capture.processor_response && capture.processor_response.response_code) || null,
        files_locked: status !== "COMPLETED",
        attempt: out.attempt_no,
        max_attempts: MAX_ATTEMPTS,
        job: out.job,
      };
    },
  },
  {
    name: "capture_desk_read",
    description:
      "Ask PayPal again for an order this desk charged, and record the answer next to the checkout claim. Use it to show that sources disagree: checkout may say the order COMPLETED while this later read says CREATED, with the capture DECLINED in both.",
    inputSchema: {
      type: "object",
      properties: { order_id: { type: "string" } },
      required: ["order_id"],
    },
    handler: async (a) => D.reread(a.order_id),
  },
  {
    name: "capture_desk_reconcile",
    description:
      "Read-only. Counts what each source claimed about every order and lists the orders whose sources disagreed. Pass job_id to restrict it to one job.",
    inputSchema: {
      type: "object",
      properties: { job_id: { type: "string" } },
    },
    handler: async (a) => D.reconcile(a.job_id),
  },
  {
    name: "capture_desk_close",
    description:
      "Approve stop_chasing for a job: release the slot. The files stay locked. Refuses when the job is already paid.",
    inputSchema: {
      type: "object",
      properties: { job_id: { type: "string" } },
      required: ["job_id"],
    },
    handler: async (a) => D.close(a.job_id),
  },
];

// ---------------------------------------------------------------------------
// One ledger for the process: the cap, the decision cache and the read log must be
// the same for every tool call in a session.
// ---------------------------------------------------------------------------

const STORE = openStore(defaultStoreFile());
const D = desk.createDesk({ store: STORE });

// ---------------------------------------------------------------------------
// JSON-RPC
// ---------------------------------------------------------------------------

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\n");
}

function reply(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function replyError(id, code, message, data) {
  send({ jsonrpc: "2.0", id, error: { code, message, ...(data === undefined ? {} : { data }) } });
}

async function handleOne(msg) {
  const { id, method, params } = msg;
  if (method === "initialize") {
    return reply(id, {
      protocolVersion: PROTOCOL,
      capabilities: { tools: { listChanged: false } },
      serverInfo: SERVER_INFO,
      instructions: INSTRUCTIONS,
    });
  }
  if (method === "notifications/initialized" || method === "initialized") return;
  if (method === "ping") return reply(id, {});
  if (method === "tools/list") {
    return reply(id, {
      tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
    });
  }
  if (method === "tools/call") {
    const name = params && params.name;
    const args = (params && params.arguments) || {};
    const tool = TOOLS.find((t) => t.name === name);
    if (!tool) return replyError(id, -32602, `unknown tool ${name}`);
    const missing = (tool.inputSchema.required || []).filter((k) => args[k] === undefined);
    if (missing.length) return replyError(id, -32602, `${name} needs ${missing.join(", ")}`);
    try {
      const value = await tool.handler(args);
      return reply(id, {
        content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
        structuredContent: value,
        isError: false,
      });
    } catch (err) {
      // A guard refusal is information, not a protocol failure: return it as a tool
      // error so the calling agent can read the reason instead of retrying blindly.
      return reply(id, {
        content: [{ type: "text", text: JSON.stringify({ error: err.message || String(err), ...(err.data ? { paypal: err.data } : {}) }, null, 2) }],
        isError: true,
      });
    }
  }
  if (id === undefined || id === null) return; // a notification we do not implement
  return replyError(id, -32601, `method not found: ${method}`);
}

let buffer = "";
// Requests still in flight. A client may close stdin right after writing a call
// (one-shot `printf | node mcp.js` does exactly that), and closing the ledger while a
// model call is still running finalizes statements under it. Drain, then close.
const pending = new Set();
let closing = false;

function track(promise) {
  pending.add(promise);
  promise.finally(() => {
    pending.delete(promise);
    if (closing && pending.size === 0) {
      try { STORE.close(); } catch {}
    }
  });
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
      continue;
    }
    const one = Array.isArray(msg) ? msg : [msg];
    for (const m of one) {
      track(
        handleOne(m).catch((err) => {
          if (m && m.id !== undefined) replyError(m.id, -32603, err.message || String(err));
        })
      );
    }
  }
});

process.stdin.on("end", () => {
  closing = true;
  if (pending.size === 0) {
    try { STORE.close(); } catch {}
  }
});
