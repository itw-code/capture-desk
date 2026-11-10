"use strict";

// HTTP adapter. All behavior lives in desk.js; this file only maps requests to it.
// Kept as server.js so `npm start`, `npm run check` and every doc reference keep working.
//
// Two modes:
//   local  (default)     one shared store, keys from .env, bound to 127.0.0.1.
//   hosted (DESK_HOSTED=1) no keys of its own. Each browser proves its own PayPal
//                        sandbox keys once, and every session gets a private
//                        in-memory ledger. A session's keys are held only by the
//                        desk instance that session owns: never logged, never
//                        written to disk, never returned by an endpoint.

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { URL } = require("url");
const desk = require("./desk.js");
const { openStore, defaultStoreFile } = require("./store.js");

const HOSTED = process.env.DESK_HOSTED === "1";
const INSECURE_LOCAL = process.env.DESK_INSECURE_LOCAL === "1";
const TRUST_PROXY = process.env.DESK_TRUST_PROXY === "1";
// DESK_TRUST_PROXY alone is not enough: forwarding headers are attacker-controlled
// unless the connection actually came from a proxy we trust. This is the allowlist
// of immediate peers whose headers may be believed — exact addresses, or IPv4 CIDR
// blocks. It defaults to loopback, which is the sidecar/same-host reverse-proxy case
// this deployment actually has. An address outside the list gets its forwarding
// headers ignored, so the request fails closed (no HTTPS, socket IP) rather than
// letting a direct stranger self-declare as TLS and spoof past the per-IP limits.
const TRUSTED_PROXIES = (process.env.DESK_TRUSTED_PROXIES || "127.0.0.1,::1,::ffff:127.0.0.1")
  .split(",")
  .map((entry) => entry.trim())
  .filter(Boolean);

// Session policy. Idle expiry slides while the tab is in use, so a demo does not
// die mid-sentence, but a session can never outlive SESSION_MAX_MS. It is never
// torn down while one of its PayPal/Gemini calls is still in flight: closing the
// ledger under a charge in progress is what would strand an order PayPal already
// made and cost the demo its idempotent replay.
const SESSION_IDLE_MS = 30 * 60 * 1000;
const SESSION_MAX_MS = 4 * 60 * 60 * 1000;
const SWEEP_MS = 60 * 1000;

// Resource/cost ceiling. Every number here bounds something a stranger can spend:
// sessions hold a SQLite ledger each, a connect spends one PayPal token call, and
// a decide spends one model call.
const MAX_SESSIONS = 16;
const MAX_SESSIONS_PER_IP = 3;
const MAX_SESSION_PENDING = 3;
const MAX_GLOBAL_PENDING = 12;
const SESSION_REQ_PER_MIN = 40;
const GLOBAL_REQ_PER_MIN = 240;
// Unauthenticated traffic shares no counter with authenticated work. Without this a
// stranger hammering GET /api/session (no cookie, no origin needed) could drain the
// global budget and 429 every real session holder out of the desk.
const ANON_REQ_PER_IP_MIN = 20;
const ANON_REQ_GLOBAL_MIN = 120;
const MAX_JOBS_PER_SESSION = 20;

// Session creation is the only unauthenticated path in hosted mode. Bound it per
// IP, globally, and by how many credential probes may be in flight at once.
const CONNECT_PER_IP_WINDOW_MS = 15 * 60 * 1000;
const CONNECT_PER_IP_MAX = 6;
const CONNECT_GLOBAL_WINDOW_MS = 60 * 60 * 1000;
const CONNECT_GLOBAL_MAX = 60;
const MAX_CONNECT_IN_FLIGHT = 4;
const MAX_FIELD = 512;

const MAX_BODY_BYTES = HOSTED ? 64 * 1024 : 1_000_000;
const COOKIE_SECURE_NAME = "__Host-capture_session";
const COOKIE_PLAIN_NAME = "capture_session";

const sessions = new Map(); // id -> session
const connectLog = new Map(); // ip -> [timestamps]
let connectLogGlobal = []; // [timestamps]
let connectInFlight = 0;
// Sessions being created but not yet in the map. Counted against MAX_SESSIONS so a
// burst of concurrent connects cannot each pass the capacity check.
let connectReserve = 0;
let globalPending = 0;
let globalRequests = []; // [timestamps]
const anonIp = new Map(); // ip -> [timestamps]
let anonGlobal = []; // [timestamps]

if (!HOSTED) desk.loadEnv(path.join(__dirname, ".env"));

// .env can clear PORT, so harnesses get a knob it cannot clobber.
const PORT = Number(process.env.DESK_PORT || process.env.PORT || 8790);
const HOST = HOSTED ? "0.0.0.0" : "127.0.0.1";
const PUBLIC = path.join(__dirname, "public");

// A --check run, or an import from the eval, gets an in-memory store so neither
// touches the real desk. The CLI and MCP server pass their own store in. Hosted
// mode has no desk of its own at all: the only ledgers are session ledgers.
const store = HOSTED ? null : openStore(
  process.argv.includes("--check") || require.main !== module ? ":memory:" : defaultStoreFile()
);
const D = HOSTED ? null : desk.createDesk({ store });

if (require.main === module) {
  if (process.argv.includes("--check")) {
    // Hosted mode has no global desk, so `--check` builds a throwaway one. It uses
    // only the environment, which hosted deliberately does not read — the report
    // says the keys are missing instead of crashing on a null desk.
    const checker = D || desk.createDesk({ store: openStore(":memory:") });
    checker.selfCheck()
      .then(({ code, lines }) => {
        console.log(lines.join("\n"));
        process.exit(code);
      })
      .catch((err) => {
        console.error(err.message || err);
        process.exit(1);
      });
  } else {
    startServer();
  }
}

function startServer() {
  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (res.headersSent) {
        try { res.end(); } catch {}
        return;
      }
      const status = Number.isInteger(err && err.status) ? err.status : 500;
      const message = HOSTED && status >= 500 ? "Request failed." : (err && err.message) || String(err);
      sendJson(res, status, { error: message });
    });
  });
  server.listen(PORT, HOST, () => {
    console.log(HOSTED ? `capture desk (hosted)  http://${HOST}:${PORT}` : `capture desk  http://${HOST}:${PORT}`);
  });
  if (HOSTED) {
    setInterval(sweepSessions, SWEEP_MS).unref();
    const shutdown = (signal) => {
      console.log(`capture desk: ${signal} received, finishing in-flight work then exiting`);
      server.close(() => {
        for (const [id, session] of sessions) destroySession(id, session);
        process.exit(0);
      });
      const deadline = Date.now() + 25000;
      const wait = () => {
        const busy = globalPending > 0 || [...sessions.values()].some((s) => s.pending > 0);
        if (!busy || Date.now() > deadline) {
          try { if (server.closeAllConnections) server.closeAllConnections(); } catch {}
          for (const [id, session] of sessions) destroySession(id, session);
          process.exit(0);
        }
        setTimeout(wait, 250).unref();
      };
      wait();
    };
    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("SIGINT", () => shutdown("SIGINT"));
  }
}

module.exports = { ...desk, store, D };

// ---------------------------------------------------------------------------
// Session registry (hosted only)
// ---------------------------------------------------------------------------

function createSession({ store: isolatedStore, instance, ip }) {
  const now = Date.now();
  return {
    id: crypto.randomBytes(32).toString("hex"),
    // A second, independent secret. The cookie alone is not accepted as proof of
    // intent for anything that spends money or model calls.
    csrf: crypto.randomBytes(32).toString("hex"),
    store: isolatedStore,
    desk: instance,
    ip,
    createdAt: now,
    lastSeen: now,
    hardExpires: now + SESSION_MAX_MS,
    pending: 0,
    closing: false,
    expired: false,
    closed: false,
    requests: [],
  };
}

function destroySession(id, session) {
  const current = sessions.get(id);
  if (!current) return;
  sessions.delete(id);
  if (session.closed) return;
  session.closed = true;
  // A closing session's keys have already been dropped by disposeCredentials; this
  // covers expiry and shutdown, where the session is never explicitly disconnected.
  try { session.desk.disposeCredentials(); } catch {}
  try { session.store.close(); } catch {}
}

function countSessionsForIp(ip) {
  let n = 0;
  for (const session of sessions.values()) if (session.ip === ip) n++;
  return n;
}

// Called on every hosted request and by a timer. A session with work in flight is
// never marked expired or closed: its PayPal call may still be about to answer, and
// closing the ledger under it would drop the idempotent replay for an order PayPal
// already made. It expires on the first sweep after the last call lands.
function sweepSessions() {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (session.closing || session.expired) {
      if (session.pending === 0) destroySession(id, session);
      continue;
    }
    if (session.pending > 0) continue;
    if (now >= session.hardExpires || now - session.lastSeen >= SESSION_IDLE_MS) {
      session.expired = true;
      destroySession(id, session);
    }
  }
  for (const [ip, times] of connectLog) {
    const live = times.filter((t) => t > now - CONNECT_PER_IP_WINDOW_MS);
    if (live.length) connectLog.set(ip, live);
    else connectLog.delete(ip);
  }
  connectLogGlobal = connectLogGlobal.filter((t) => t > now - CONNECT_GLOBAL_WINDOW_MS);
  globalRequests = globalRequests.filter((t) => t > now - 60000);
  anonGlobal = anonGlobal.filter((t) => t > now - 60000);
  for (const [ip, times] of anonIp) {
    const live = times.filter((t) => t > now - 60000);
    if (live.length) anonIp.set(ip, live);
    else anonIp.delete(ip);
  }
}

// The anonymous budget: cheap, unauthenticated probes only. Checked and charged in
// one synchronous block, so two racing probes cannot both read the same count.
function allowAnon(ip) {
  const now = Date.now();
  const recentGlobal = anonGlobal.filter((t) => t > now - 60000);
  if (recentGlobal.length >= ANON_REQ_GLOBAL_MIN) return false;
  const recentIp = (anonIp.get(ip) || []).filter((t) => t > now - 60000);
  if (recentIp.length >= ANON_REQ_PER_IP_MIN) return false;
  recentIp.push(now);
  anonIp.set(ip, recentIp);
  anonGlobal = recentGlobal.concat(now);
  return true;
}

function allowConnect(ip) {
  const now = Date.now();
  const recentGlobal = connectLogGlobal.filter((t) => t > now - CONNECT_GLOBAL_WINDOW_MS);
  if (recentGlobal.length >= CONNECT_GLOBAL_MAX) return false;
  const recentIp = (connectLog.get(ip) || []).filter((t) => t > now - CONNECT_PER_IP_WINDOW_MS);
  if (recentIp.length >= CONNECT_PER_IP_MAX) return false;
  recentIp.push(now);
  connectLog.set(ip, recentIp);
  connectLogGlobal = recentGlobal.concat(now);
  return true;
}

// ---------------------------------------------------------------------------
// Cookies, origin, CSRF
// ---------------------------------------------------------------------------

function cookieName() {
  return INSECURE_LOCAL || !HOSTED ? COOKIE_PLAIN_NAME : COOKIE_SECURE_NAME;
}

function cookieValue(req, name) {
  const header = req.headers.cookie || "";
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    if (trimmed.startsWith(name + "=")) return trimmed.slice(name.length + 1);
  }
  return null;
}

function sessionCookie(id, maxAgeSeconds) {
  const attrs = [`${cookieName()}=${id}`, "Path=/", "HttpOnly", "SameSite=Strict", `Max-Age=${maxAgeSeconds}`];
  if (!INSECURE_LOCAL) attrs.push("Secure");
  return attrs.join("; ");
}

function clearSessionCookie(res) {
  const attrs = [`${cookieName()}=`, "Path=/", "HttpOnly", "SameSite=Strict", "Max-Age=0"];
  if (!INSECURE_LOCAL) attrs.push("Secure");
  res.setHeader("Set-Cookie", attrs.join("; "));
}

function liveSession(req) {
  const id = cookieValue(req, cookieName());
  if (!id) return null;
  const session = sessions.get(id);
  if (!session) return null;
  const now = Date.now();
  if (session.closing || session.expired || now >= session.hardExpires || now - session.lastSeen >= SESSION_IDLE_MS) {
    // Never admit new work for a session past its life or already disconnected.
    // The ledger is only closed when nothing is in flight, so a PayPal call that is
    // still running can finish writing its order before the ledger goes away.
    session.expired = true;
    if (session.pending === 0) destroySession(id, session);
    return null;
  }
  return session;
}

function normalizeAddress(addr) {
  const text = String(addr || "").trim();
  // Node reports IPv4 connections to a dual-stack socket as ::ffff:a.b.c.d.
  return text.startsWith("::ffff:") ? text.slice(7) : text;
}

function ipv4ToLong(ip) {
  const parts = String(ip).split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = (value << 8) | octet;
  }
  return value >>> 0;
}

function matchesProxy(addr, entry) {
  const ip = normalizeAddress(addr);
  if (entry.includes("/")) {
    const [base, bitsText] = entry.split("/");
    const bits = Number(bitsText);
    const left = ipv4ToLong(ip);
    const right = ipv4ToLong(base);
    if (left == null || right == null || !Number.isInteger(bits) || bits < 0 || bits > 32) return false;
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (left & mask) === (right & mask);
  }
  return ip === normalizeAddress(entry);
}

// True only when the socket peer is an allowlisted proxy. Without TRUST_PROXY this
// is never consulted, and forwarding headers are always ignored.
function proxyTrusted(req) {
  if (!TRUST_PROXY) return false;
  const addr = (req.socket && req.socket.remoteAddress) || "";
  return TRUSTED_PROXIES.some((entry) => matchesProxy(addr, entry));
}

function requestIsSecure(req) {
  if (INSECURE_LOCAL) return true;
  if (req.socket && req.socket.encrypted) return true;
  if (proxyTrusted(req)) {
    const proto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
    if (proto === "https") return true;
  }
  return false;
}

function sameOrigin(req) {
  const host = req.headers.host;
  if (!host) return false;
  const origin = req.headers.origin;
  if (!origin) {
    // A same-origin GET may omit Origin. Anything that changes state must state it.
    if (req.method !== "GET" && req.method !== "HEAD") return false;
    const site = req.headers["sec-fetch-site"];
    return site ? site === "same-origin" || site === "none" : true;
  }
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  // Behind TLS termination the request arrives as http but the browser's origin is
  // https, so the scheme is read from the request, not from the socket.
  const secure = requestIsSecure(req);
  if (INSECURE_LOCAL) {
    // A local demo may be reached over either scheme on the same host.
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    return parsed.host === host;
  }
  return parsed.protocol === (secure ? "https:" : "http:") && parsed.host === host;
}

function isJson(req) {
  return String(req.headers["content-type"] || "").toLowerCase().includes("application/json");
}

function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || !a || !b) return false;
  const left = crypto.createHash("sha256").update(a).digest();
  const right = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(left, right);
}

function csrfOk(req, session) {
  return timingSafeEqual(req.headers["x-csrf-token"], session.csrf);
}

function clientIp(req) {
  // Only an allowlisted proxy's word counts, and only its first hop: a client can
  // always append its own forged value, but it cannot overwrite what the proxy put
  // in front of it.
  if (proxyTrusted(req)) {
    const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
    if (forwarded) return forwarded;
  }
  return (req.socket && req.socket.remoteAddress) || "unknown";
}

function applySecurityHeaders(res) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  // The desk page ships one inline script and inline styles; everything it may load
  // is same-origin. The only exception is /story's PayPal font stylesheet, which is
  // a style and font source and nothing else — no script, no connect.
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://www.paypalobjects.com; font-src 'self' https://www.paypalobjects.com data:; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'"
  );
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

async function handle(req, res) {
  let base;
  try {
    base = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);
  } catch {
    return sendJson(res, 400, { error: "Bad request." });
  }
  if (HOSTED) return handleHosted(req, res, base);
  if (base.pathname === "/api/session" && req.method === "GET") {
    return sendJson(res, 200, { hosted: false, connected: true });
  }
  return handleApi(req, res, base, D, store, { hosted: false });
}

async function handleHosted(req, res, url) {
  applySecurityHeaders(res);
  if (!requestIsSecure(req)) {
    if (HOSTED) console.error("https refused peer=" + ((req.socket && req.socket.remoteAddress) || ""));
    if (url.pathname.startsWith("/api/")) return sendJson(res, 403, { error: "HTTPS is required." });
    return sendText(res, 403, "HTTPS is required.");
  }
  if (!INSECURE_LOCAL) {
    res.setHeader("Strict-Transport-Security", "max-age=15552000");
  }
  if (!url.pathname.startsWith("/api/")) return handleApi(req, res, url, null, null, { hosted: true });

  if (!sameOrigin(req)) return sendJson(res, 403, { error: "Invalid origin." });

  sweepSessions();
  // One resolution per request: liveSession both validates and may retire the
  // session, and calling it twice would double-count those side effects.
  const session = liveSession(req);

  if (url.pathname === "/api/session") return handleSession(req, res, url, session);

  if (!session) {
    // Unauthenticated probes get their own, smaller budget. Sharing one counter
    // with authenticated work would let a stranger drain it and 429 every real
    // session holder out of the desk.
    if (!allowAnon(clientIp(req))) {
      clearSessionCookie(res);
      return sendJson(res, 429, { error: "The desk is busy. Try again shortly." });
    }
    clearSessionCookie(res);
    return sendJson(res, 401, { error: "Connect your sandbox credentials first." });
  }

  const now = Date.now();
  globalRequests = globalRequests.filter((t) => t > now - 60000);
  if (globalRequests.length >= GLOBAL_REQ_PER_MIN) return sendJson(res, 429, { error: "The desk is busy. Try again shortly." });
  globalRequests.push(now);

  // Refresh the cookie so the browser's idle window matches the server's. Without
  // this a fixed Max-Age would drop the cookie while the ledger was still alive.
  res.setHeader("Set-Cookie", sessionCookie(session.id, SESSION_IDLE_MS / 1000));
  session.lastSeen = now;

  if (req.method !== "GET" && req.method !== "HEAD" && !csrfOk(req, session)) {
    return sendJson(res, 403, { error: "Missing or invalid CSRF token." });
  }

  session.requests = session.requests.filter((t) => t > now - 60000);
  if (session.requests.length >= SESSION_REQ_PER_MIN) return sendJson(res, 429, { error: "Too many requests; try again shortly." });
  session.requests.push(now);

  if (session.pending >= MAX_SESSION_PENDING) return sendJson(res, 429, { error: "This session is busy. Try again in a moment." });
  if (globalPending >= MAX_GLOBAL_PENDING) return sendJson(res, 503, { error: "The desk is busy. Try again shortly." });

  session.pending++;
  globalPending++;
  try {
    return await handleApi(req, res, url, session.desk, session.store, { hosted: true });
  } finally {
    session.pending--;
    globalPending--;
    sweepSessions();
  }
}

async function handleSession(req, res, url, current) {
  if (req.method === "GET") {
    if (current) {
      // A liveness poll is proof the tab is still there, so it extends the idle
      // window exactly like a work call does. Without this the cookie would outlive
      // the server-side session and every later call would answer 401.
      current.lastSeen = Date.now();
      res.setHeader("Set-Cookie", sessionCookie(current.id, SESSION_IDLE_MS / 1000));
    } else {
      // Either no cookie or a dead one. A stranger polling this endpoint to learn
      // the desk's shape is bounded by the anonymous budget, not by nothing.
      if (!allowAnon(clientIp(req))) return sendJson(res, 429, { error: "The desk is busy. Try again shortly." });
      if (cookieValue(req, cookieName())) clearSessionCookie(res);
    }
    return sendJson(res, 200, {
      hosted: true,
      connected: Boolean(current),
      // The page echoes this back on every state-changing call. It is not the
      // cookie: an attacker's page cannot read it across origins.
      csrf: current ? current.csrf : null,
    });
  }

  if (req.method === "DELETE") {
    if (current) {
      if (!csrfOk(req, current)) return sendJson(res, 403, { error: "Missing or invalid CSRF token." });
      // Mark it closing and drop the cookie now, so no new work can attach. The keys
      // go with the session record: immediately when nothing is running, otherwise
      // the moment the last in-flight call lands (destroySession disposes them).
      // Disposing unconditionally here would abort a charge that PayPal has already
      // created but we have not yet recorded, stranding a real order.
      current.closing = true;
      if (current.pending === 0) destroySession(current.id, current);
    }
    clearSessionCookie(res);
    return sendJson(res, 200, { hosted: true, connected: false });
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST, DELETE");
    return sendJson(res, 405, { error: "Method not allowed." });
  }

  // POST /api/session — the one call that carries credentials.
  //
  // Every gate below that could be raced is checked AND reserved synchronously,
  // before the first await. Reading a counter, awaiting a body read and a provider
  // round-trip, then incrementing it would let N concurrent connects all observe the
  // pre-increment value and all proceed, blowing past both the in-flight cap and the
  // session cap. `connectReserve` is the placeholder for a session that has not
  // been created yet, so the capacity check counts it.
  if (current) {
    if (current.pending > 0) {
      // A charge or decision is still running against this ledger. Answering with a
      // fresh session here would hide the PayPal order that call is about to create,
      // and the page's retry would buy a second one. Wait for it to land.
      return sendJson(res, 409, { error: "The desk is still finishing your last operation. Try again in a moment." });
    }
    return sendJson(res, 409, { error: "Disconnect the current session first." });
  }
  if (connectInFlight >= MAX_CONNECT_IN_FLIGHT) return sendJson(res, 503, { error: "The desk is connecting other sessions. Try again in a moment." });
  if (sessions.size + connectReserve >= MAX_SESSIONS) return sendJson(res, 503, { error: "Session capacity reached. Try again later." });
  if (!isJson(req)) return sendJson(res, 415, { error: "Send a JSON body." });

  connectInFlight++;
  connectReserve++;
  let isolated = null;
  let handedOver = false;
  try {
    const body = await readJson(req);
    if (!body || typeof body !== "object" || Array.isArray(body)) return sendJson(res, 400, { error: "Send a JSON object." });
    const values = [body.client_id, body.client_secret, body.gemini_api_key];
    if (values.some((v) => typeof v !== "string" || !v.trim() || v.length > MAX_FIELD)) {
      return sendJson(res, 400, { error: "Enter all three sandbox credentials." });
    }

    // The IP is charged only for a well-formed attempt: a mistyped form must not burn
    // the quota of a user who is about to get it right.
    const ip = clientIp(req);
    if (!allowConnect(ip)) return sendJson(res, 429, { error: "Too many connection attempts. Try again later." });
    if (countSessionsForIp(ip) >= MAX_SESSIONS_PER_IP) return sendJson(res, 429, { error: "This address already has sessions open. Disconnect one first." });
    // A disconnect clears the cookie immediately, so `current` above is null for a
    // session that is closing with a charge still in flight. Refusing only on a live
    // cookie would let that tab open a second, empty ledger while the first order is
    // still landing — the page would lose the order and its idempotent replay. Any
    // session on this address with work in flight blocks a fresh one.
    for (const other of sessions.values()) {
      if (other.ip === ip && other.pending > 0) {
        return sendJson(res, 409, { error: "The desk is still finishing your last operation. Try again in a moment." });
      }
    }

    isolated = openStore(":memory:");
    const instance = desk.createDesk({
      store: isolated,
      credentials: {
        clientId: values[0].trim(),
        clientSecret: values[1].trim(),
        geminiApiKey: values[2].trim(),
      },
      limits: { maxJobs: MAX_JOBS_PER_SESSION },
    });
    // Prove the credentials before answering 201: a session that cannot authenticate
    // is a dead tab the user has to debug. PayPal's pair is confirmed with one token
    // call; the Gemini key with one free metadata read. Neither spends model quota.
    const probe = await instance.verifyCredentials();
    if (!probe.paypal_ok) {
      const rejected = /HTTP 401/.test(String(probe.paypal_error || ""));
      return sendJson(res, rejected ? 401 : 502, {
        error: rejected
          ? "PayPal rejected these sandbox credentials."
          : "Could not reach PayPal to verify these credentials. Try again.",
      });
    }
    if (probe.gemini_rejected) {
      return sendJson(res, 401, { error: "Gemini rejected this API key." });
    }
    const session = createSession({ store: isolated, instance, ip });
    sessions.set(session.id, session);
    // The ledger and the session record now own everything: only destroySession may
    // close them, and the reserve has become a real session.
    handedOver = true;
    res.setHeader("Set-Cookie", sessionCookie(session.id, SESSION_IDLE_MS / 1000));
    // gemini_verified: false means the key was accepted as well-formed but could not
    // be confirmed right now; the page says so instead of implying a check it did not get.
    return sendJson(res, 201, { hosted: true, connected: true, csrf: session.csrf, gemini_verified: probe.gemini_verified === true });
  } catch (err) {
    return sendJson(res, 502, { error: "Could not start a session for these credentials. Try again." });
  } finally {
    connectInFlight--;
    if (!handedOver) {
      connectReserve--;
      destroyPending(isolated);
    }
  }
}

function destroyPending(isolated) {
  if (!isolated) return;
  try { isolated.close(); } catch {}
}

async function handleApi(req, res, url, D, store, options) {
  const hosted = Boolean(options && options.hosted);
  if (req.method === "GET" && url.pathname === "/") {
    return sendFile(res, path.join(PUBLIC, "index.html"), "text/html; charset=utf-8");
  }
  if (req.method === "GET" && (url.pathname === "/story" || url.pathname === "/story.html")) {
    return sendFile(res, path.join(PUBLIC, "story.html"), "text/html; charset=utf-8");
  }
  if (req.method === "GET" && url.pathname === "/api/health") {
    return sendJson(res, 200, await D.liveHealth());
  }
  if (req.method === "GET" && url.pathname === "/api/triggers") {
    return sendJson(res, 200, desk.TRIGGERS);
  }
  if (req.method === "POST" && url.pathname === "/api/charge") {
    const body = await readJson(req);
    const out = await D.charge({
      trigger: body.trigger,
      note: body.note,
      jobId: body.job_id,
      attemptNo: Number.isInteger(body.attempt_no) ? body.attempt_no : undefined,
    });
    if (out.error) {
      // PayPal's own body is returned for local use. A hosted session gets only the
      // reduction desk.js built from inside the credential closure: the error text,
      // whitelisted and scrubbed issue descriptions, and a scrubbed debug id. No raw
      // body, because a validation description can echo payer data back.
      if (hosted) return sendJson(res, out.status, out.hostedError || { error: out.error });
      return sendJson(res, out.status, out.body || { error: out.error });
    }
    if (out.replay) return sendJson(res, 200, { ...out.order, job: out.job, replay: true });
    return sendJson(res, out.status, { ...out.order, job: out.job });
  }
  if (req.method === "GET" && url.pathname === "/api/job") {
    // What a caller needs to resume a job: attempts, per-attempt decisions, reads.
    return sendJson(res, 200, D.status(String(url.searchParams.get("id") || "")));
  }
  if (req.method === "GET" && url.pathname === "/api/jobs") {
    return sendJson(res, 200, {
      jobs: store.listJobs(Number(url.searchParams.get("limit")) || 20).map(desk.jobView),
    });
  }
  if (req.method === "GET" && url.pathname === "/api/order") {
    return sendJson(res, 200, await D.reread(String(url.searchParams.get("id") || "")));
  }
  if (req.method === "GET" && url.pathname === "/api/reconcile") {
    return sendJson(res, 200, D.reconcile(url.searchParams.get("job") || undefined));
  }
  if (req.method === "POST" && url.pathname === "/api/decide") {
    const body = await readJson(req);
    const result = await D.decide({
      jobId: body.job_id,
      orderId: body.order && body.order.id,
      refresh: body.refresh === true,
    });
    return sendJson(res, 200, result);
  }
  if (req.method === "POST" && url.pathname === "/api/close") {
    const body = await readJson(req);
    return sendJson(res, 200, D.close(body.job_id));
  }
  sendJson(res, 404, { error: "not found" });
}

// ---------------------------------------------------------------------------
// I/O
// ---------------------------------------------------------------------------

function readJson(req, maxBytes = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let overflow = false;
    let done = false;
    // A caller that opens a request and never finishes the body would otherwise hold
    // a session's pending slot forever, and with it the ledger.
    const timer = setTimeout(() => finish(reject, Object.assign(new Error("Request body timed out."), { status: 408 })), 20000);
    if (timer.unref) timer.unref();
    const finish = (fn, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      fn(value);
    };
    req.on("data", (chunk) => {
      if (done) return;
      size += chunk.length;
      if (size > maxBytes) {
        // Keep reading to the end but stop buffering: destroying the socket would
        // leave the caller with a reset instead of the 413 that explains it.
        overflow = true;
        chunks.length = 0;
        return;
      }
      if (!overflow) chunks.push(chunk);
    });
    req.on("end", () => {
      if (overflow) return finish(reject, Object.assign(new Error("Body too large."), { status: 413 }));
      if (!chunks.length) return finish(resolve, {});
      try {
        finish(resolve, JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        finish(reject, Object.assign(new Error("Invalid JSON."), { status: 400 }));
      }
    });
    req.on("error", (err) => finish(reject, Object.assign(new Error(err.message || "Request failed."), { status: 400 })));
  });
}

function sendJson(res, status, body) {
  if (res.headersSent) {
    try { res.end(); } catch {}
    return;
  }
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body, null, 2));
}

function sendText(res, status, text) {
  if (res.headersSent) {
    try { res.end(); } catch {}
    return;
  }
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
  res.end(text);
}

function sendFile(res, file, type) {
  if (res.headersSent) {
    try { res.end(); } catch {}
    return;
  }
  const stream = fs.createReadStream(file);
  // A missing or unreadable page must answer 404, not take the process down with an
  // unhandled stream error.
  stream.once("error", () => {
    if (res.headersSent) {
      try { res.end(); } catch {}
      return;
    }
    sendText(res, 404, "Not found.");
  });
  stream.once("open", () => {
    res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store" });
    stream.pipe(res);
  });
}
