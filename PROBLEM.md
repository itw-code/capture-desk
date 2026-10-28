# Problem

A freelancer takes a card payment for work not yet delivered. PayPal's checkout response returns the order as `COMPLETED` while the capture inside it is `DECLINED`. A later read of the same order says `CREATED`, not `COMPLETED`. A normal payments screen collapses that into one word, approved or a generic failure. The freelancer either sends the files for money that did not clear, or asks the buyer to retry a card PayPal has already said not to retry.

This does not start from explaining money already received. The capture did not clear.

## Who

A freelancer or small business that takes card checkout through PayPal Orders v2 and treats "order completed" as permission to start or deliver the work. Card declines are ordinary. The dangerous part is specific to this API: the order status and the capture status disagree.

## What breaks today

The checkout screen reads one status. If that status is the order, the work starts unpaid. If that status is a generic decline, the freelancer still has to guess the next step. Guessing wrong on a lost, stolen, fraudulent, or invalid card means asking the buyer to run the same card again.

The screen does not lock the files, and it does not say which of those two mistakes this capture is.

## Sandbox records that prove it

PayPal's sandbox creates this record. It is not a header mock and not a canned test id.

Call `POST https://api-m.sandbox.paypal.com/v2/checkout/orders` with `intent: CAPTURE`, Visa test card `4012888888881881`, and a rejection trigger in the card name or `address_line_1`. PayPal's card-testing page documents the response: the order is created, `status` is `COMPLETED`, and `purchase_units[].payments.captures[].status` is `DECLINED`. On 5 Oct 2026 the checkout response matched that. A later GET on the same order returned `CREATED`. The capture includes `processor_response.response_code`, plus GET links for both the order (`/v2/checkout/orders/{id}`) and the capture (`/v2/payments/captures/{id}`).

Documented triggers and codes:

| Card name | `response_code` | PayPal's instruction |
| --- | --- | --- |
| `CCREJECT-REFUSED` | `0500` | Do not honor |
| `CCREJECT-EC` | `5400` | Expired card |
| `CCREJECT-IF` | `5120` | Insufficient funds |
| `CCREJECT-IA` | `1330` | Invalid account |
| `CCREJECT-BANK_ERROR` | `5100` | Generic decline |
| `CCREJECT-SF` | `9500` | Suspected fraud. Do not retry the same card. |
| `CCREJECT-LS` | `9520` | Lost or stolen. Do not retry the same card. |
| `CCREJECT-IRC` | `5180` | Invalid or restricted. Do not retry the same card. |

On 5 Oct 2026 the sandbox app Features page had no expanded-card-payments checkbox. Card charges worked after signing into the sandbox business account, setting the country to US, creating a new merchant app, and using that app's client id and secret. An earlier app returned PayPal's own `PAYEE_NOT_ENABLED_FOR_CARD_PROCESSING`. The app must show that error. It must not invent a decline.

Sources: [Card testing](https://developer.paypal.com/credit-card-number-generator), [Orders v2](https://developer.paypal.com/api/orders/v2).


## Captured live records

These sandbox charges ran on 5 Oct 2026. Each order has two reads. The checkout response is the body PayPal returns from the order post, and that is the status the desk shows. The later read is a fresh `GET /v2/checkout/orders/{id}` on 5 Oct 2026. On every declined charge the checkout response said `COMPLETED` and the later read says `CREATED`. The capture is `DECLINED` in both. The cleared charge reads `COMPLETED` both times. `fulfill` was false on every decline and the files stayed locked. The cleared charge used the `Sandbox Buyer` card, response code `0000`, so the page says work can start and the files unlock, with no buyer sentence. Rows from the first `CCREJECT-IF`, Gemma run onward ran on `gemma-4-31b-it`. The desk writes the buyer sentence for all eight mapped codes. Gemma proposed fulfill and retry for the older rows, and the guard overwrote them. After 6 Oct 2026 the desk writes the buyer line and the files lock, and Gemma proposes the next step instead (see below).

| Trigger | Order | Checkout response | Later read | Capture | Files | Buyer line |
| --- | --- | --- | --- | --- | --- | --- |
| `CCREJECT-IF` | `3FK67831G02184341` | `COMPLETED` | `CREATED` | `DECLINED` `5120` | locked | The charge didn't clear. PayPal response code 5120. |
| `CCREJECT-SF` | `6Y858092VR126273V` | `COMPLETED` | `CREATED` | `DECLINED` `9500` | locked, do not retry | Do not retry this card. PayPal response code 9500. |
| `Sandbox Buyer` | `6N134559D3574884F` | `COMPLETED` | `COMPLETED` | `COMPLETED` `0000` | unlocked | The page shows no buyer sentence. |
| `CCREJECT-IF`, Gemma run | `8CY432076M0578305` | `COMPLETED` | `CREATED` | `DECLINED` `5120` | locked | The charge didn't clear. PayPal response code 5120. |
| `CCREJECT-IF`, Gemma run | `30H062608H215800X` | `COMPLETED` | `CREATED` | `DECLINED` `5120` | locked | The charge didn't clear. PayPal response code 5120. |
| `CCREJECT-SF`, Gemma run | `6LK53744K7566424Y` | `COMPLETED` | `CREATED` | `DECLINED` `9500` | locked, do not retry | Do not retry this card. PayPal response code 9500. |
| `Sandbox Buyer`, Gemma run | `37T25890DV953782E` | `COMPLETED` | `COMPLETED` | `COMPLETED` `0000` | unlocked | The page shows no buyer sentence. |

Next-step records, 6 Oct 2026. These are checkout responses only; no later GET was made. Gemma picks the next step and the guards may veto it. These ran before Gemma was given the WIB clock, so the 72 h wait is Gemma's guess, not computed. Full rows are in `eval/live-smoke-2026-10-06.json`.

| Job · attempt | Trigger | Order | Capture | Files | Gemma's next step | Vetoed |
| --- | --- | --- | --- | --- | --- | --- |
| A · 1, note "Repeat client, paid me 6 times. Said payday is Friday." | `CCREJECT-IF` | `5AP15224TN9010405` | `DECLINED` `5120` | locked | retry this card in 72 h | no |
| B · 1, note "First contact. Paid nothing yet." | `CCREJECT-SF` | `8E888807AR306884H` | `DECLINED` `9500` | locked | send a new checkout link | no |
| A · 2, approved | `Sandbox Buyer` | `3X3581419F543231V` | `COMPLETED` `0000` | unlocked, paid on attempt 2 | none (Gemma not called) | n/a |

## What the AI does with those records

The model reads the live order JSON after the charge. It does not see a status label the screen already chose.

Updated 6 Oct 2026: on a `DECLINED` capture Gemma now makes a real decision, the freelancer's next step, and the guards can veto it instead of overwriting it. A `COMPLETED` capture skips Gemma: the files unlock and there is no next step. A `PENDING`, `FAILED`, or missing capture stays locked with no Gemma move.

A job carries a short freelancer note (`About this buyer (only you see this)`, up to 280 characters) and an attempt history, up to 3 attempts. Gemma gets the slim order, the response code, the note, the earlier attempts, the attempt number, the cap, and the moves allowed for that code. It returns `next_step`, `wait_hours`, and one `reason` sentence of at most 140 characters:

- `retry_same_card_later`, with `wait_hours` from 1 to 168, for example insufficient funds before a payday the note mentions.
- `new_checkout_link`: the buyer pays again on a fresh link and may choose another method.
- `stop_chasing`: release the slot. The files stay locked.

The guards veto, they do not overwrite:

- `retry_same_card_later` is vetoed on `9500`, `9520`, and `5180`, because PayPal's Orders v2 text says to try another card and not retry the same one, and on `5400` and `1330`, because the same card cannot succeed later.
- At 3 attempts only `stop_chasing` is allowed.
- Unparseable output, an unknown move, a wait outside 1 to 168, or a reason that claims the payment arrived or uses the word dispute falls back to `ask_freelancer`: no automatic move, never a guess.
- When a move is vetoed the final step is `ask_freelancer`, unless exactly one allowed move is left. The guard never silently picks a different move for Gemma. The decision keeps `proposed`, `final`, `vetoed`, `veto_reason`, `attempt`, `max_attempts`, and `decided_by` (`gemma`, `guard`, or `fallback`).
- The files lock and the eight buyer lines are the guards', not the model's. Gemma never writes buyer copy. A buyer message that says the money was already received cannot appear.

Only an approved step runs. In the sandbox, approving a retry or a new link runs the next checkout on the same job at once with the card the judge picks. Approving `stop_chasing` closes the job. `npm run check` tests the guards offline. `npm run eval` runs 21 cases through the real model and reports pass, veto, and fallback rates.

That is the step a payments screen does not take: it keeps the two statuses apart, blocks the work, and says what to do next with this buyer. For `9500`, `9520`, and `5180` the buyer line says not to retry that card. For `0500`, `5400`, `5120`, `1330`, and `5100` it shows the code and says the charge didn't clear.

## What the user can do after

Do not send the files. Send the buyer the message from the decision. If it is `do_not_retry`, do not ask them to run that card again. For `0500`, `5400`, `5120`, `1330`, and `5100`, show the code and say the charge didn't clear. Do not ask for a different card. Then read the Next step block: approve it, or stop chasing. The job stays unstarted until a later capture is `COMPLETED`. A later capture means a new checkout. Looking again at the same declined capture does not unlock the files.

## Run

The working build is this repo. Judges need the US sandbox merchant app, plus `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, and one AI key.

```bash
cd Projects/Side-projects/paypal-dispute-desk
copy .env.example .env
npm run check
npm start
```

Open http://127.0.0.1:8790. Charge in sandbox, then Decide.

## Why this record, not a nearby one

Dispute creation is a real sandbox API, `POST /v1/customer/disputes`, but PayPal requires a buyer access token, a `PayPal-Auth-Assertion` JWT, and a `buyer_transaction_id` copied from a sandbox personal account after Send Money. A judge with only the merchant client id and secret cannot produce that record in one run. Source: [Test disputes](https://developer.paypal.com/disputes/test-go-live).

`PayPal-Mock-Response` forces an error on the call that sends the header. Those docs do not document a created order with a declined capture and GET links. Source: [Negative testing request headers](https://developer.paypal.com/negative-testing/request-headers).

`GET /v1/payments/payouts/ERRPYO015` is a simulated body for a test value in the URI, not a payout the app created. Source: [Test payouts](https://developer.paypal.com/api/payouts/test-go-live).

Re-read check, 7 Oct 2026 (new `GET /api/order?id=` and the "Ask PayPal again" button, which read an order this desk charged, fresh from PayPal): `CCREJECT-IF` order `9RY84897P4146544J`. Checkout response: order `COMPLETED`, capture `DECLINED` `5120`. Read through the desk a moment later: order `CREATED`, capture `DECLINED` `5120`. An id the desk did not charge is refused with 404.
