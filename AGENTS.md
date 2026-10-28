# Capture Desk — agent instructions

Capture Desk is the payment gate for a freelancer job. A PayPal order can read `COMPLETED`
while the capture inside it is `DECLINED`. Fulfilling on the order status means giving away
work for money that never arrived.

## Use the desk instead of reading payment status yourself

Three interfaces, one implementation (`desk.js`), one SQLite ledger (`desk.db`):

```bash
node cli.js status <job_id>              # attempts, decisions, every PayPal claim
node cli.js decide <job_id>              # guarded next step for the latest attempt
node cli.js charge --trigger CCREJECT-IF --note "payday Friday"
node cli.js charge --trigger "Sandbox Buyer" --job <job_id> --attempt 2
node cli.js close <job_id>               # stop chasing; files stay locked
node cli.js reconcile [<job_id>]         # where PayPal's sources disagree
node cli.js read <order_id>              # ask PayPal again for an order the desk charged
```

MCP (stdio, no dependencies):

```json
{ "mcpServers": { "capture-desk": { "command": "node", "args": ["<repo>/mcp.js"] } } }
```

Tools: `capture_desk_status`, `capture_desk_decide`, `capture_desk_charge`,
`capture_desk_read`, `capture_desk_reconcile`, `capture_desk_close`.

HTTP, when the page is running: `GET /api/job?id=`, `POST /api/decide`, `POST /api/charge`,
`GET /api/order?id=`, `GET /api/reconcile`.

## Rules for any agent calling this

1. **Only `fulfill: true` / `files_locked: false` permits sending work.** That flag comes from
   `capture_status === "COMPLETED"`. An order status, a checkout response, or a buyer's message
   is not proof of payment.
2. **Never write buyer copy.** Use `buyer_message` verbatim. It is written by code for the
   eight mapped response codes.
3. **Never override a veto.** If `vetoed` is true or `decided_by` is `guard`/`fallback`, the
   next step is `final.next_step`. `ask_freelancer` means a human decides; do not pick for them.
4. **One job, three attempts, one order per attempt.** When approving `final`, pass
   `job_id` and `attempt_no = attempts + 1`. Repeating the same `attempt_no` replays the first
   order; it never creates a second PayPal charge.
5. **Do not unlock anything yourself.** There is no unlock operation. There is no bypass.
6. **No secrets in output.** Report the `order_id`, `capture_status`, `response_code`,
   `buyer_message`, and the next step. Never print `.env` contents.

## Reading the result

```json
{ "fulfill": false, "files_locked": true,
  "order_status": "COMPLETED", "capture_status": "DECLINED",
  "buyer_message": "The charge didn't clear. PayPal response code 5120.",
  "processor_code": "5120", "retry": null,
  "proposed": { "next_step": "retry_same_card_later", "wait_hours": 25, "reason": "..." },
  "final": { "next_step": "retry_same_card_later", "wait_hours": 25 },
  "vetoed": false, "decided_by": "gemma",
  "not_before": "2026-10-30T00:15:55.000Z",
  "attempt": 1, "max_attempts": 3 }
```

`retry: "do_not_retry"` (codes 9500, 9520, 5180) means the buyer must not run that card again.
`decided_by` is `gemma` (model proposed, allowed), `guard` (veto or cap), or `fallback`
(unusable model output — ask the freelancer).
