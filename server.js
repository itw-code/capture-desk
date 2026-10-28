"use strict";

// HTTP adapter. All behavior lives in desk.js; this file only maps requests to it.
// Kept as server.js so `npm start`, `npm run check` and every doc reference keep working.

const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");
const desk = require("./desk.js");
const { openStore, defaultStoreFile } = require("./store.js");

desk.loadEnv(path.join(__dirname, ".env"));

// .env can clear PORT, so harnesses get a knob it cannot clobber.
const PORT = Number(process.env.DESK_PORT || process.env.PORT || 8790);
const HOST = "127.0.0.1";
const PUBLIC = path.join(__dirname, "public");

// A --check run, or an import from the eval, gets an in-memory store so neither
// touches the real desk. The CLI and MCP server pass their own store in.
const store = openStore(
  process.argv.includes("--check") || require.main !== module ? ":memory:" : defaultStoreFile()
);
const D = desk.createDesk({ store });

if (require.main === module) {
  if (process.argv.includes("--check")) {
    D.selfCheck()
      .then(({ code, lines }) => {
        console.log(lines.join("\n"));
        process.exit(code);
      })
      .catch((err) => {
        console.error(err.message || err);
        process.exit(1);
      });
  } else {
    http.createServer((req, res) => {
      handle(req, res).catch((err) => sendJson(res, err.status || 500, { error: err.message || String(err) }));
    }).listen(PORT, HOST, () => {
      console.log(`capture desk  http://${HOST}:${PORT}`);
    });
  }
}

module.exports = { ...desk, store, D };

async function handle(req, res) {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
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
    if (out.error) return sendJson(res, out.status, out.body || { error: out.error });
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

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 1_000_000) reject(new Error("body too large"));
      else chunks.push(chunk);
    });
    req.on("end", () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body, null, 2));
}

function sendFile(res, file, type) {
  res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store" });
  fs.createReadStream(file).pipe(res);
}
