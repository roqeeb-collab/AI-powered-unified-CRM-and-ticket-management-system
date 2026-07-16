# Ticket Queue & Communication Hub

An AI-assisted customer support desk built on **n8n + Google Sheets + Gmail + Slack + OpenAI**, designed for a fintech operation (banking-as-a-service / payments, Nigeria) where every ticket lands on a single desk and needs to be triaged, drafted, approved, and sent with a human in the loop.

> **Every draft reply is reviewed and approved by a human before it leaves the mailbox.** The AI classifies, drafts, and nudges — it never sends.

---

## What it does

- **Ingests** every email addressed to the support inbox from Gmail.
- **Classifies** each ticket into one of 13 fintech-specific categories (NIP transfers, fraud, recalls, reconciliation, KYC, compliance, etc.) with a priority (P1 / P2 / P3), an escalation team when applicable, and a confidence score.
- **Analyzes attachments** — screenshots and receipts are sent to a vision-capable model so the AI can read what the customer sees.
- **Drafts a reply** for each ticket, stores it as a real Gmail draft, and posts a Slack card with **Approve & Send** and **Decline** buttons.
- **Sends only after human approval** — the button triggers `gmail.googleapis.com/gmail/v1/users/me/drafts/send`. If declined, the draft is left in the mailbox for manual editing.
- **Logs everything** to a Google Sheet (`Tickets` + `PendingApprovals`) — the sheet is the system of record.
- **Enforces lifecycle rules** every 15 minutes: FRT breach alerts, stale ticket nudges, escalation re-pings, customer follow-up nudges, courtesy closes, quiet closes.
- **Reminds** the approver every minute if a draft has been waiting more than 5 minutes.
- **Reopens** tickets automatically when a customer replies on a closed thread.
- **Closes on keyword** — including `[CLOSED]` at the end of a sent reply closes the ticket.
- **Reports errors** — a workflow-error trigger posts a structured error card to Slack when anything fails.

---

## File layout

```
ticket-hub/
├── README.md                          ← you are here
├── LICENSE                            ← MIT
├── .gitignore                         ← standard ignores (env, credentials, node_modules)
│
├── workflows/
│   └── ticket_hub_main.json           ← the n8n workflow, import this into n8n
│
├── appscript/
│   └── Code.gs                        ← Google Sheet provisioner
│                                        creates Tickets, PendingApprovals, Dashboard tabs
│                                        with headers, dropdowns, live KPI formulas
│
├── prompts/
│   ├── classifier.txt                 ← extracted classifier system prompt
│   ├── drafter.txt                    ← extracted drafter system prompt
│   └── escalation_brief.txt           ← extracted escalation-brief system prompt
│                                        (these live inline in the workflow's Code nodes;
│                                         the files here are for readability and diffing)
│
├── sheets/
│   ├── Tickets.csv                    ← Tickets tab schema + sample row
│   └── PendingApprovals.csv           ← PendingApprovals tab schema + sample row
│
└── docs/
    ├── SETUP.md                       ← step-by-step first-time setup guide
    └── ARCHITECTURE.md                ← how the pieces fit together, trigger by trigger
```

---

## Architecture at a glance

Five triggers, one workflow, two sheet tabs, one Slack workspace.

| Trigger | Frequency | Purpose |
|---|---|---|
| `Inbound Email Trigger` | Gmail polling | Every new email → classify, log, draft, request approval |
| `Sent Email Trigger` | Gmail polling | Every email you send from support → close loop, log outbound, detect `[CLOSED]` |
| `Every 15 Minutes` | cron | Lifecycle engine (FRT breaches, nudges, courtesy / quiet closes, re-pings) |
| `Every Minute` | cron | Pending-approval reminders for drafts sitting > 5 min |
| `On Workflow Error` | error hook | Structured error card to Slack |

Full trigger-by-trigger walkthrough in `docs/ARCHITECTURE.md`.

---

## Quick start

1. Clone this repo.
2. Follow `docs/SETUP.md` (~45 minutes, first time).

Short version:
- Create a Google Sheet, paste `appscript/Code.gs` into Apps Script, run `setupSheet()`.
- Create a Slack app with `chat:write` scope, enable Interactivity.
- Create OpenAI HTTP Header Auth credential in n8n with your API key.
- Import `workflows/ticket_hub_main.json` into n8n.
- Attach credentials, replace `REPLACE_WITH_SHEET_ID` with your sheet ID,
  replace `REPLACE_WITH_*_CHANNEL_NAME` placeholders with your Slack channels.
- Activate.

---

## Categories

The classifier picks exactly one per ticket. See `prompts/classifier.txt` for full definitions.

| Category | Description |
|---|---|
| `transfers_nip` | NIP / interbank transfers stuck in pending, failed transfers, status enquiries |
| `fraud` | Fraudulent transactions, fraud recalls (ICAD), account compromise |
| `disputes` | Chargebacks and transaction disputes |
| `recall_reversal` | System-glitch recalls, non-fraud reversals |
| `reconciliation_settlement` | Settlement status, recon discrepancies |
| `statements_reports` | Statement requests, periodic reports |
| `payments` | Collections / payment-processing failures |
| `cards` | Card issuance, activation, PIN, declines, blocks |
| `account_kyc` | Onboarding, identity verification (KYC / BVN / NIN) |
| `technical_api` | API integration errors, webhooks, SDK issues |
| `compliance_legal` | Regulator (CBN) requests, subpoenas, AML / sanctions |
| `billing_fees` | Fees, invoices, pricing |
| `general` | Anything else |

Priority rubric:
- **P1** — suspected fraud, funds stuck / lost, account compromise, regulatory or legal deadline, platform outage.
- **P2** — disputes / chargebacks, recon discrepancies, system-glitch recalls, KYC blocking onboarding, degraded functionality.
- **P3** — statement / report requests, fee questions, general enquiries.

---

## Security

**Prompt injection is treated as a first-class threat.** The classifier system prompt treats all email content as untrusted data. Manipulation attempts are detected and used as a *signal* — the classifier lowers confidence when a customer tries to influence their own classification.

**The AI never sends customer replies directly.** Gmail Drafts API creates the draft; a human clicks Approve; only then does the send fire.

**All sensitive data stays inside your Google Workspace + Slack + OpenAI API.** No third-party ticketing tool. If OpenAI is not acceptable for your data, swap the HTTP node URL to a self-hosted or region-compliant endpoint — the node accepts any OpenAI-compatible API.

Full details in `docs/ARCHITECTURE.md#prompt-injection-defenses`.

---

## Lifecycle tuning

The `Lifecycle Rules` Code node inside the workflow has a `CFG` object at the top:

```js
const CFG = {
  frtMinutes: 25,       // FRT alert threshold (SLA is 30)
  staleHours: 24,       // open ticket with no activity
  repingHours: 4,       // escalated ticket with no update
  nudgeHours: 48,       // waiting_customer follow-up interval
  maxNudges: 2,
  quietCloseDays: 7,    // resolved → closed
  guardMinutes: 30,     // never act twice on the same ticket within this window
  queueChannel: '#support-queue'
};
```

Tune to your SLAs. Changes take effect on the next 15-minute run.

---

## What's not in this repo

- **Slack interactive callback handler.** The Approve & Send / Decline buttons emit an interaction payload; you'll need a separate small webhook workflow that receives those and calls `Gmail Drafts.send` or marks decline. See `docs/SETUP.md#8-slack-interactive-callback-separate-workflow` for the shape.
- **Vector search over past tickets.** For "similar ticket" retrieval when drafting, plug a Pinecone / Qdrant / pgvector node into the drafter's context. Not needed for v1.
- **Analytics BI.** The `Tickets` sheet has the data; connect Looker Studio, Metabase, or your BI tool of choice.

---

## Operational notes

- **First-week calibration.** The classifier's confidence scores are opinions. Watch the first ~30 tickets. If you see systematic misclassifications in a direction, tighten the classifier prompt.
- **Sheets rate limits.** ~60 reads and 60 writes per minute per user. Fine at 50–200 tickets/day. Retry-on-fail is enabled on every Sheets node.
- **Prompt updates.** All prompts live inline in the workflow's Code nodes. Edit in n8n, save, and the next execution uses the new prompt. No re-import needed. The `.txt` files under `prompts/` are copies for readability and version-diffing.

---

## Contributing

Not accepting external contributions. Fork freely.

## License

MIT. See `LICENSE`.
