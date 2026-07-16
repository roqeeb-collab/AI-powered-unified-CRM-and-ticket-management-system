# Setup guide

Step-by-step to get from a fresh n8n instance to a running ticket hub.

## Prerequisites

- **n8n** self-hosted (v1.50+) or n8n Cloud
- A **Google Workspace** account with Gmail + Sheets access
- A **Slack workspace** where you can create an app
- An **OpenAI API key** with access to a vision-capable chat model (`gpt-4o` or newer)

Estimated time: 45–60 minutes.

## 1. Create the Google Sheet

1. Create a new Google Sheet, name it something like `Ticket Hub CRM`.
2. Extensions → Apps Script. Delete the boilerplate.
3. Copy the contents of `appscript/Code.gs` into the editor.
4. Save and click Run on the `setupSheet` function. Authorize when prompted.
5. Reload the sheet. You'll see a **Ticket Hub** menu appear.
6. Copy the sheet ID from the URL — it's the long string between `/d/` and `/edit`.
   Keep this handy; you'll paste it into every Google Sheets node in the workflow.

The script creates `Tickets`, `PendingApprovals`, and `Dashboard` tabs with correct
headers, dropdowns, and live KPI formulas.

## 2. Create the Slack app

1. Go to https://api.slack.com/apps → Create New App → From scratch.
2. **OAuth & Permissions** → Add these bot token scopes:
   - `chat:write`
   - `channels:read`
   - `groups:read`
3. Install the app to your workspace. Copy the **Bot User OAuth Token**
   (starts with `xoxb-`) — you'll paste this into the n8n Slack credential.
4. **Interactivity & Shortcuts** → Enable. Set the Request URL to a webhook you'll
   create in step 5 (or leave for now and come back).
5. Create your Slack channels and note their IDs (right-click channel → View
   channel details → scroll to the bottom for the ID):
   - Queue / triage channel (where new-ticket cards land)
   - Ops escalations channel
   - Engineering escalations channel
   - Legal / compliance escalations channel

## 3. Set up Gmail credentials in n8n

Two OAuth2 credentials pointing at the same Google account — one for inbound
polling, one for outbound sending. Follow n8n's Gmail credential setup guide;
you'll create OAuth credentials in Google Cloud Console and paste the client ID
and secret into n8n.

Both credentials can technically be one, but splitting them lets you swap
sending accounts later if you migrate to a shared inbox tool.

## 4. Set up the OpenAI credential

In n8n → Credentials → New credential → **HTTP Header Auth**.

- Name: `OpenAI API`
- Header name: `Authorization`
- Header value: `Bearer sk-...` (your OpenAI API key)

The three HTTP nodes (`AI Classifier`, `Draft Reply`, `Smart Brief`) will use this.

## 5. Import the workflow

1. n8n UI → Workflows → Import from File.
2. Select `workflows/ticket_hub_main.json`.
3. Open the imported workflow.

## 6. Wire up the workflow

For each node with a placeholder, do the following:

### Attach credentials

Every Sheets, Gmail, and Slack node has `"id": "REPLACE"` in its credential
reference. Click each node and select your actual credential from the dropdown.

Nodes needing credentials:
- All Google Sheets nodes → Google Sheets OAuth2
- `Inbound Email Trigger`, `Sent Email Trigger`, `Send Nudge Email`,
  `Send Courtesy Close`, `Create Gmail Draft` → Gmail OAuth2
- All Slack nodes (`Send Reminder`, `Post Error to Slack`, `Send Slack Alert`,
  `Notify Queue Reopen`, `Ping Review Queue`, `Post Escalation to Slack`,
  `Request Approval (Slack)1`) → Slack API
- `AI Classifier`, `Smart Brief`, `Draft Reply`, `Send Approved Draft1` →
  HTTP Header Auth (OpenAI) — actually only the AI ones use OpenAI; the
  `Send Approved Draft1` uses Gmail OAuth2 to call the Gmail API.

### Update the sheet ID

Every Google Sheets node currently references `REPLACE_WITH_SHEET_ID` as the
documentId. Search-replace it with your actual sheet ID in every node.

Alternative: change it to `={{ $env.SHEET_ID }}` and set the env var in your
n8n instance settings.

### Update Slack channel placeholders

Open the `Lifecycle Rules` Code node. Near the top there's a `CFG` object and
several `CH_*` variables:

```js
const CFG = {
  // ...
  queueChannel: 'REPLACE_WITH_QUEUE_CHANNEL_NAME'
};

const CH_OPERATIONS = 'REPLACE_WITH_OPS_CHANNEL_NAME';
const CH_LEGAL      = 'REPLACE_WITH_LEGAL_CHANNEL_NAME';
const CH_ENGINEERING = 'REPLACE_WITH_ENG_CHANNEL_NAME';
```

Replace with your actual channel names (with the `#`, e.g. `#support-queue`).

Also check the Slack nodes' `channelId` fields — some reference channel IDs directly.

## 7. Test with a real email

1. Activate the workflow.
2. Send an email to your support inbox from a different email account. Include
   a screenshot as an attachment to test the vision path.
3. Within ~60 seconds you should see:
   - A new row in the `Tickets` sheet with the AI's classification.
   - A row in `PendingApprovals`.
   - A Slack card in your queue channel with **Approve & Send** / **Decline**
     buttons.
4. Click Approve & Send. The Gmail draft is sent, the `PendingApprovals` row is
   cleared, the `Tickets` row gets `approved_by` and `approved_at` stamped.

## 8. Slack interactive callback (separate workflow)

The Approve & Send / Decline buttons emit a Slack interaction payload to
whatever URL you set in step 2.4. You need a small companion workflow (webhook
in, ~5 nodes) that:

1. Receives the Slack interaction payload
2. Parses the `actions[0].value` to figure out which draft and which action
3. If Approve: calls `POST https://gmail.googleapis.com/gmail/v1/users/me/drafts/send`
   with the draft ID (Gmail credential)
4. Updates `PendingApprovals.resolved = TRUE` and stamps the resolver
5. Updates `Tickets.approved_by` and `Tickets.approved_at`
6. Responds to Slack with 200 OK and an updated message (e.g. "Sent ✓")

This isn't included in `ticket_hub_main.json` because the exact button payload
depends on how you structure your Slack Block Kit blocks. Build it as its own
webhook workflow.

## 9. Ongoing tuning

- **Watch the first 30 tickets** — the classifier's confidence scores are
  opinions, not facts. If you see systematic misclassifications, tighten the
  classifier prompt in the `Build Classifier Prompt` node.
- **Adjust the CFG object** in `Lifecycle Rules` to match your real SLAs.
- **Watch the error channel** — the workflow-error trigger posts here when
  anything fails.

## Troubleshooting

**Nothing happens when I send an email.**
Check the Executions tab. If the Gmail trigger isn't firing, verify:
- The Gmail credential has the right permissions (readonly is not enough — needs
  `gmail.modify` scope to mark as read).
- The polling interval — Gmail triggers poll roughly every minute by default.

**Classification returns malformed JSON.**
The `Parse Classification` node catches this and falls back to `category=general`,
`priority=P2`, `confidence=0.5`. If you see many of these, check the OpenAI API
response in the execution log — the model might be returning markdown-fenced
JSON that the strip regex isn't catching.

**Approve & Send button does nothing.**
You haven't built the Slack interaction callback workflow yet (step 8).

**"Duplicate ticket" in the sheet.**
Two customer emails arrived simultaneously. The Message-ID dedupe usually
catches this, but if it slips through, delete the duplicate row manually — at
low volume (< 200 tickets/day) this is rare enough not to warrant a lock.
