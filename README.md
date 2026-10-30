# Capture Desk

A freelancer takes a card payment. PayPal's checkout response can show the order as `COMPLETED` while the capture is `DECLINED`. A later read of the same order says `CREATED`. A normal payments screen stops at approved or a generic failure. It does not block the work, and it does not say whether the buyer should retry that card. The problem, the sandbox record, and the rejected alternatives are in [PROBLEM.md](PROBLEM.md).

This app does not start from "explain money already received." The money did not clear. The first call is a live sandbox charge. The model then reads that capture.

## Get your own credentials (judges)

Do not use anyone else's keys. Create your own:

1. **PayPal sandbox US merchant app**
   - Sign in at [developer.paypal.com](https://developer.paypal.com/) with a PayPal account.
   - Open the **sandbox** business account (or create one) and set the account country to **US**.
   - Create a new **merchant** app. Copy its **Client ID** and **Secret** into `.env` as `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET`.
   - Card checkout needs a US merchant app. There is no expanded-card-payments checkbox to enable. If PayPal returns `PAYEE_NOT_ENABLED_FOR_CARD_PROCESSING`, the app shows that error and does not invent a decline.
   - Card testing docs: [PayPal card testing](https://developer.paypal.com/credit-card-number-generator).

2. **Gemma / Google AI key**
   - Create an API key in [Google AI Studio](https://aistudio.google.com/apikey) (or your Google AI / Gemini developer console).
   - Put it in `.env` as `GEMINI_API_KEY`. The default model is `gemma-4-31b-it` (`AI_MODEL`).

## Run

Needs **Node 22.13 or newer**: the server uses built-in `fetch`, and job state lives in `node:sqlite` without an experimental flag. There is nothing to install; the app has no npm dependencies.

From the repo folder:

```bash
# Windows
copy .env.example .env

# Mac / Linux
cp .env.example .env
```

Fill `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, and `GEMINI_API_KEY`. Leave Ihsan's keys out of any commit.

```bash
npm run check
npm start
```

Open http://127.0.0.1:8790. Run **New checkout**. The desk page is one file; http://127.0.0.1:8790/story is a separate read-only explainer page.

The charge uses PayPal's card-testing trigger on a sandbox Visa (`4012888888881881`). Pick a **Test card** such as Insufficient funds (5120), Suspected fraud (9500), or Sandbox Buyer · clears. Live records from 5 Oct 2026 are in PROBLEM.md.

The model cannot mark a `DECLINED` capture as safe to fulfill, and only a `COMPLETED` capture unlocks the files. For the eight mapped codes, the desk writes the buyer line; Gemma never writes buyer copy.

## What Gemma decides

On a declined capture, Gemma picks the freelancer's next step: retry the same card later (1 to 168 hours), send a new checkout link, or stop chasing. It reads the order, the response code, the **About this buyer (only you see this)** note, and the earlier attempts on the job (3 attempts max). The guards can veto its pick: no same-card retry on 9500, 9520, 5180, 5400, or 1330, and at 3 attempts only stop chasing. If the pick is vetoed, or the model output is unusable, the page asks you to choose. Nothing runs until you press Approve. In the sandbox, Approve runs the next checkout on the same job right away with the Test card you picked. A capture that is `COMPLETED` skips Gemma, unlocks the files, and shows which attempt paid.

```bash
npm run check          # guard self-test (offline), PayPal token, Gemma ping
npm run check:durable  # charges the real sandbox twice, restarts, proves the cap holds
npm run check:recon    # offline: the source-disagreement log and its counts
npm run check:tool     # offline-ish: one order per attempt, atomic cap, CLI/MCP parity
npm run eval           # 29 cases through the real model, plus the code-only baseline; writes eval/results-latest.json
npm run eval -- --judgment --reps 5   # the 8 note-driven cases, five reps, reports unstable cases
```

`npm run eval` is one temperature-0 sample, not a rate. `--judgment --reps N` re-runs only the
cases where the note is supposed to change the move and reports which cases flip; a case that
passes in some reps and fails in others is reported as unstable rather than counted as a pass.
Partial runs do not overwrite `results-latest.json` unless you pass `--out`.

`npm run check:durable` is the guard invariant as an executable test. It charges a job twice, kills the server, starts it again, and asserts the third charge is still accepted and the fourth is refused with `409`. It also re-reads an order created before the restart. Against the code before `store.js` existed, five of its ten checks fail: a restart forgot every job, so a real PayPal order could no longer be re-read and a job that had used all three attempts looked unused.

## Use it as a tool (agents)

The page is one face of the desk. The CLI and an MCP server are the other two, and all
three call the same guards against the same SQLite ledger, so an agent cannot get a
different answer than the page — or an unguarded one.

```bash
node cli.js charge --trigger CCREJECT-IF --note "payday Friday"   # one live sandbox attempt
node cli.js decide <job_id>                                       # guarded next step
node cli.js status <job_id>                                       # attempts, decisions, every claim
node cli.js charge --trigger "Sandbox Buyer" --job <job_id> --attempt 2
node cli.js close <job_id>                                        # stop chasing; files stay locked
node cli.js reconcile [<job_id>]
```

MCP (stdio, zero dependencies):

```json
{ "mcpServers": { "capture-desk": { "command": "node", "args": ["<repo>/mcp.js"] } } }
```

Tools: `capture_desk_status`, `capture_desk_decide`, `capture_desk_charge`,
`capture_desk_read`, `capture_desk_reconcile`, `capture_desk_close`. There is no tool that
unlocks files, writes buyer copy, or overrides a veto. `AGENTS.md` carries the rules an
agent must follow.

Two properties make it safe to hand to several callers: one attempt is one PayPal order
(a deterministic `PayPal-Request-Id` per attempt slot, claimed in the ledger before the
call, so a repeat or a double click replays instead of charging again), and the guarded
decision is stored per attempt, so a refresh, a second process, or a different agent reads
the same envelope. `npm run check:tool` proves both, including two callers racing the same
attempt and three racing the attempt cap.

## The disagreement, as data

The premise of this app is that sources contradict each other about one order. That used to be a paragraph in this README. Now every claim is a row.

Each time a source states what happened to an order, the desk appends it to `read_events`: the checkout response is source `checkout`, and each later read is source `reread`. Rows are never updated or deleted, so the contradiction stays legible instead of the last write winning.

```
GET /api/reconcile
```

returns a count of reads, orders and sources, plus every order whose sources disagreed, with each claim in the order it was made. A live re-read on 7 Oct 2026 (order `9RY84897P4146544J`, recorded in [PROBLEM.md](PROBLEM.md)) produced exactly the case the app exists for:

| source | order_status | capture_status | code |
| --- | --- | --- | --- |
| checkout | `COMPLETED` | `DECLINED` | `5120` |
| reread | `CREATED` | `DECLINED` | `5120` |

Two distinct versions of the same order, read a moment apart. `eval/recon-check.mjs` writes the same pair into a throwaway ledger five minutes apart and asserts both claims survive. The desk never averages them: the file lock reads the capture, and the reconciliation view reports the disagreement rather than resolving it.

This is a reconciliation view, not a reporting surface. It answers "do our sources agree" and says nothing about money flow, which the product deliberately does not do.

`npm run eval` prints per-case proposed and final moves next to a code-only baseline, and reports both. The baseline reads no note: stop chasing at attempt 3 and on 9500, 9520 and 5180; a new checkout link on 5400 and 1330, where the same card can never work; otherwise retry the same card after a fixed 72 hours. Cases are in `eval/cases.json`. 8 of the 29 are "judgment" cases, where the note, not only the code, should decide the move; the rest are code cases where a fixed rule is enough. The 6 Oct set is kept as `eval/cases-frozen-2026-10-06.json`, but the live set is no longer identical to it: on 29 Oct the expected answer for 11 cases on 9500, 9520 and 5180 was changed to "stop chasing or ask the freelancer, never a new checkout link", to match the guard rule. Gemma is given the current time and weekday in UTC+7 so a day named in the note becomes a real wait.

Latest full run (`eval/results-latest.json`, gemma-4-31b-it, 29 cases, one run at temperature 0, 29 Oct): all cases Gemma 26/29, baseline 25/29; the 21 code cases 21/21 for both, so they cannot separate the two; judgment cases Gemma 5/8, baseline 4/8. There were no vetoes, one fallback to the freelancer, and no model errors. The three misses are `j-other-card`, `j-cold-dm-files-first` and `j-pushy-bank-blame`. In `j-other-card` Gemma's reason named the buyer's other card, the reason scrub refused it, and the desk handed the choice back to the freelancer: a lost point, not an unsafe step. The other two picked a new checkout link where stopping was expected.

Read that 5/8 carefully. Three of the five judgment passes (`j-stranger-pay-double`, `j-stranger-files-today`, `j-company-card-restricted`) are on 9500, 9520 and 5180, which the guard rule now decides, so the baseline passes them too. The other two are `j-card-replaced` and `j-payday-friday-pinned`; the pinned Friday case passes for the baseline as well, because its fixed 72 hours falls inside the 60-to-84-hour window. Gemma's only judgment pass the baseline misses is therefore `j-card-replaced`. Three repeat runs of the 8 judgment cases (`eval/results-2026-10-29-judgment-3rep.json`) gave the same result each time: 5 passed in all 3, the same 3 failed in all 3, none flipped. The 6 Oct run, kept in `eval/results-2026-10-28-previous.json` (the file is named for when it was archived; its `ran_at` is 6 Oct) and scored against the pre-change expectations, was 26/29 against 23/29 and 5/8 against 2/8. Those are historical and not comparable to the numbers above.

## Why a small model, and what it costs

The decision is narrow: pick one of three moves (plus a wait and a one-line reason) from a response code, a short note, an attempt count and a clock. Gemma (`gemma-4-31b-it`) is an open-weights language model, chosen because it is cheap; on the eval it passes 26 of 29 cases and 5 of 8 judgment cases, but three of those five are codes the guard rule decides, so read the caveats above rather than the headline number. It is not special: the model sits behind one function (`askGemma`), and `aiConfig` in `desk.js` already accepts a Gemini model (`GEMINI_API_KEY`), OpenAI (`OPENAI_API_KEY`), or a Kenari-style OpenAI-compatible endpoint (`KENARI_API_KEY`, with `AI_BASE_URL` and `AI_MODEL`) through env vars. Any model that returns the three-field JSON can replace it. The guards, not the model, own the lock and the buyer lines, so a weaker or different model can change the next step but cannot unlock files.

Cost per decision (estimate, not a measurement of billed usage): the prompt is about 440 tokens (1,181 characters of instructions plus about 577 of case JSON, at roughly 4 characters per token) and the reply is about 60 tokens, assumed. At public per-million-token prices seen on 6 Oct 2026 for Gemma 4 31B, that is between about $0.00006 (OpenRouter, about $0.08 to $0.09 in and $0.34 to $0.35 out) and $0.00008 (DeepInfra via Requesty, $0.13 in and $0.38 out) per decision. So 1,000 declined captures cost roughly $0.06 to $0.08 in model calls, and even ten times the tokens stays under a dollar. Gemma is only called on a declined capture; a `COMPLETED` capture needs no model call.

Scale scenario (illustrative, not measured): 1,000 declined captures at the demo's USD 25.00 is USD 25,000 of work that Capture Desk keeps locked until a capture is `COMPLETED`. How many of those would otherwise be delivered unpaid, or retried the wrong way, is not known and is not claimed here. The model cost for the whole batch is under USD 0.10.
