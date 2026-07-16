# Architecture

## The whole thing on one page

The Ticket Hub is a single n8n workflow that ingests Gmail, classifies with
OpenAI, stores state in Google Sheets, and routes approval decisions through
Slack. Nothing in the customer path is asynchronous or eventually-consistent
beyond n8n's own execution model.

```
Customer email arrives at support@yourcompany.com
        │
        ▼
┌─────────────────────────────────────────────────────────────┐
│  n8n workflow "Ticket Queue & Communication Hub - Main"     │
│                                                             │
│  5 triggers                                                 │
│    ├─ Inbound Email Trigger (Gmail push)                    │
│    ├─ Sent Email Trigger (Gmail push)                       │
│    ├─ Every 15 Minutes (cron)                               │
│    ├─ Every Minute (cron)                                   │
│    └─ On Workflow Error                                     │
│                                                             │
│  Shared state                                               │
│    ├─ Google Sheet · Tickets tab                            │
│    └─ Google Sheet · PendingApprovals tab                   │
│                                                             │
│  External services                                          │
│    ├─ OpenAI Chat Completions API (3 call sites)            │
│    ├─ Slack Block Kit + Interactivity                       │
│    └─ Gmail API (read, draft, send)                         │
└─────────────────────────────────────────────────────────────┘
```

## Trigger by trigger

### Inbound Email Trigger — the main path

Every new email addressed to `support@yourcompany.com` becomes a ticket. The
pipeline is:

1. **Normalize** — parse Gmail's payload, strip quoted history and email
   signatures, cap body at 8000 characters, extract attached images as base64
   data URIs (max 3 images, 4.5 MB each).
2. **Dedupe by Message-ID** — the Gmail trigger occasionally re-emits messages
   during rebalance events. Idempotent guard.
3. **Reopen check** — if this is a reply on a closed thread, flip the existing
   ticket back to `open` and notify Slack. (The classifier still runs on the
   new message so the reopened ticket gets updated context.)
4. **Classify** — build the classifier prompt, call OpenAI Chat Completions
   with the message body plus any attached images. Model receives the fintech-
   specific system prompt with prompt-injection defenses.
5. **Parse and validate** — parse the JSON, validate the category is one of
   the 13 allowed values, validate the priority is P1/P2/P3, coerce confidence
   into a 0–1 range, generate a ticket ID.
6. **Append to Tickets sheet.**
7. **Escalation check** — if `needs_escalation === true`, build a smart brief
   (a second OpenAI call summarizing the message for the escalation team) and
   post it to the team-specific Slack channel (ops / eng / legal).
8. **Review-queue flag** — if confidence < 0.75 or category is fraud, ping the
   review queue for a human sanity check on the classification itself.
9. **Draft** — build the drafter prompt, call OpenAI again for the reply body.
10. **Create Gmail draft** — the real draft, In-Reply-To header set for
    proper threading, stored in the mailbox.
11. **Request approval** — post a Slack Block Kit card with the draft body
    and Approve & Send / Decline buttons.
12. **Log to PendingApprovals** — so the reminder cron knows to nudge if this
    sits too long.

### Sent Email Trigger — closing the loop

Every email that leaves your support inbox flows through here:

1. **Normalize sent** — parse the Gmail payload.
2. **Find ticket** — match by thread_id to the ticket that spawned it.
3. **Ticket found?**
   - No → probably an unrelated outbound. Ignore.
   - Yes → continue.
4. **Closed keyword check** — if the sent reply contains `[CLOSED]`, mark the
   ticket closed. Otherwise, set status to `waiting_customer`, reset
   `nudge_count`, stamp `first_reply_at` if empty.

The `[CLOSED]` keyword is deliberately terse so agents can add it from any
mail client without needing to open n8n or the sheet.

### Every 15 Minutes — lifecycle engine

Reads every open ticket and applies rules in priority order (first matching
rule wins):

| Condition | Action |
|---|---|
| `status=open`, no `first_reply_at`, > 25 min old | Post FRT breach alert to queue |
| `status=open`, no activity > 24 h | Post stale-ticket alert to queue |
| `status=escalated`, no update > 4 h | Re-ping the team channel |
| `status=waiting_customer`, > 48 h since last touch, `nudge_count < 2` | Send nudge email, increment `nudge_count`, stamp `last_action_at` |
| `status=waiting_customer`, > 48 h, `nudge_count >= 2` | Send courtesy close email, set `status=closed`, set `closed_by=auto-nudge` |
| `status=resolved`, > 7 days | Set `status=closed`, set `closed_by=auto-quiet` |

A `guardMinutes: 30` throttle prevents the cron from double-acting on a ticket
that just changed state within the last 30 minutes.

### Every Minute — approval reminders

Reads `PendingApprovals`, finds rows where `resolved=FALSE`, `reminded=FALSE`,
and `pending_since` is > 5 minutes ago. Sends one reminder to the queue
channel and sets `reminded=TRUE` so we don't spam.

If nobody responds after the reminder, that ticket just sits — deliberate.
Escalating an approval reminder to a phone call is a human decision, not an
automation.

### On Workflow Error — error hook

Catches any node failure in the main workflow, formats a structured Slack
card with the failing node's name, the error message, the execution ID (with
a deep link), and the input data snapshot. Posts to the error channel.

Without this, silent failures during off-hours are the worst kind of bug in
a support system.

## Sheet as source of truth

Every state-changing decision reads from and writes to the sheet. There is no
in-memory ticket state, no caching layer, no separate database. The tradeoff:

**Pros**
- The sheet is human-inspectable. You can filter, sort, add notes, correct
  categories inline. All those changes are respected by the next lifecycle run.
- No sync problems between two stores.
- Cheap. No database to operate.

**Cons**
- Google Sheets API has quotas (~60 reads and 60 writes per minute per user).
  Fine at 50–200 tickets/day, will need migration to Postgres somewhere north
  of 1000/day.
- No transactions. Race conditions on burst inbound are handled by retry-on-fail
  settings on every Sheets node (5 tries, 1s backoff).

## Why HTTP nodes for OpenAI

Rather than n8n's built-in OpenAI or langchain nodes, this workflow uses raw
HTTP Request nodes to `api.openai.com/v1/chat/completions`. Reasons:

1. **Multimodal control.** The vision message format (`content: [{ type: "text", ... }, { type: "image_url", ... }]`) is easier to construct explicitly than through node parameters.
2. **Portability.** Any OpenAI-compatible endpoint (Azure OpenAI, self-hosted
   vLLM, Groq, OpenRouter) works by changing one URL. If your compliance
   posture shifts, you don't rebuild.
3. **Import stability.** The built-in OpenAI node's schema has changed between
   n8n versions and broken imports. Raw HTTP nodes are boring and stable.

The cost is a bit more code in the `Parse Classification` and `Parse Draft`
nodes to unwrap the response.

## Prompt injection defenses

The classifier system prompt explicitly:

- Declares all email content untrusted data
- Refuses to obey manipulation attempts embedded in customer text
- Treats manipulation attempts as a *signal* — lowers confidence when detected

The drafter system prompt has a `_secguard` clause that:

- Always drafts a reply (never refuses — refusals from the AI would confuse the
  approval flow)
- Never promises refunds, reversals, or specific timelines
- Uses `[AGENT: ...]` placeholders where internal verification is needed

The human approval step is the ultimate safeguard. Even if a prompt injection
managed to produce a bad draft, no message reaches the customer without a
person clicking Approve & Send.
