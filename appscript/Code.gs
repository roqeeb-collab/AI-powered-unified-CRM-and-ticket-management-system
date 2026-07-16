/**
 * Ticket Hub — Google Sheet provisioner
 * =====================================
 * Creates the two tabs the workflow expects, with correct headers, dropdowns,
 * frozen header rows, and a Dashboard tab with live KPI formulas.
 *
 * Run this in Apps Script:
 *   1. Create a fresh Google Sheet.
 *   2. Extensions → Apps Script.
 *   3. Delete the boilerplate, paste this in, save.
 *   4. Run setupSheet() once and authorize.
 *   5. Reload the sheet — you'll see a "Ticket Hub" menu appear.
 *   6. Copy the spreadsheet ID from the URL and paste it into every
 *      Google Sheets node in the workflow (or set as env var).
 *
 * Safe to re-run: headers and dropdowns are refreshed, existing rows are preserved.
 */

function setupSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  const SCHEMAS = {
    Tickets: [
      'ticket_id', 'message_id', 'thread_id', 'received_at',
      'sender', 'to_address', 'subject',
      'category', 'priority', 'status',
      'needs_escalation', 'escalation_team', 'escalated_at',
      'first_reply_at', 'resolved_at', 'closed_at', 'closed_by',
      'nudge_count', 'last_action_at',
      'attachments', 'summary', 'confidence',
      'category_corrected', 'low_confidence', 'flag_queue', 'queue_note',
      'approved_by', 'approved_at'
    ],
    PendingApprovals: [
      'thread_id', 'ticket_id', 'to', 'subject',
      'pending_since', 'reminded',
      'resolved', 'resolved_at', 'resolved_by'
    ]
  };

  for (const [tab, headers] of Object.entries(SCHEMAS)) {
    let s = ss.getSheetByName(tab) || ss.insertSheet(tab);
    writeHeaders_(s, headers);
  }

  applyValidations_(ss);
  buildDashboard_(ss);

  const def = ss.getSheetByName('Sheet1');
  if (def && def.getLastRow() === 0 && ss.getSheets().length > 1) {
    ss.deleteSheet(def);
  }

  ss.setActiveSheet(ss.getSheetByName('Dashboard'));
  SpreadsheetApp.getUi().alert(
    'Sheet ready. Copy the spreadsheet ID from the URL and paste it into every ' +
    'Google Sheets node in the n8n workflow (or set the SHEET_ID env var).'
  );
}

function writeHeaders_(sheet, headers) {
  const r = sheet.getRange(1, 1, 1, headers.length);
  r.setValues([headers]);
  r.setFontWeight('bold').setBackground('#f1efe8').setHorizontalAlignment('left');
  sheet.setFrozenRows(1);
  const cols = sheet.getMaxColumns();
  if (cols > headers.length) sheet.deleteColumns(headers.length + 1, cols - headers.length);
  sheet.autoResizeColumns(1, headers.length);
}

function applyValidations_(ss) {
  const setList = (sheet, colHeader, list) => {
    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    const idx = headers.indexOf(colHeader) + 1;
    if (!idx) return;
    const rule = SpreadsheetApp.newDataValidation()
      .requireValueInList(list, true).setAllowInvalid(false).build();
    sheet.getRange(2, idx, sheet.getMaxRows() - 1, 1).setDataValidation(rule);
  };

  const CATEGORIES = [
    'transfers_nip', 'fraud', 'disputes', 'recall_reversal',
    'reconciliation_settlement', 'statements_reports', 'payments',
    'cards', 'account_kyc', 'technical_api', 'compliance_legal',
    'billing_fees', 'general'
  ];
  const PRIORITIES = ['P1', 'P2', 'P3'];
  const STATUSES = ['open', 'escalated', 'waiting_customer', 'resolved', 'closed'];
  const TEAMS = ['operations', 'engineering', 'compliance', 'legal', ''];
  const BOOLS = ['TRUE', 'FALSE'];

  const t = ss.getSheetByName('Tickets');
  setList(t, 'category', CATEGORIES);
  setList(t, 'priority', PRIORITIES);
  setList(t, 'status', STATUSES);
  setList(t, 'needs_escalation', BOOLS);
  setList(t, 'escalation_team', TEAMS);
  setList(t, 'low_confidence', BOOLS);
  setList(t, 'flag_queue', BOOLS);
  setList(t, 'category_corrected', CATEGORIES.concat(['']));

  const p = ss.getSheetByName('PendingApprovals');
  setList(p, 'reminded', BOOLS);
  setList(p, 'resolved', BOOLS);
}

function buildDashboard_(ss) {
  let d = ss.getSheetByName('Dashboard');
  if (!d) d = ss.insertSheet('Dashboard', 0);
  else { d.clear(); d.clearConditionalFormatRules(); }

  d.getRange('A1').setValue('Ticket Hub — Support Operations Dashboard')
    .setFontSize(16).setFontWeight('bold');
  d.getRange('A2').setValue('Updates live as the Tickets sheet changes.')
    .setFontColor('#666');

  const kpis = [
    ['Tickets opened today',
      '=COUNTIFS(Tickets!D:D,">="&TEXT(TODAY(),"yyyy-mm-dd"),Tickets!D:D,"<"&TEXT(TODAY()+1,"yyyy-mm-dd"))'],
    ['Open tickets (all)',
      '=COUNTIFS(Tickets!J:J,"<>closed",Tickets!J:J,"<>resolved",Tickets!A:A,"<>")'],
    ['P1 backlog',
      '=COUNTIFS(Tickets!I:I,"P1",Tickets!J:J,"<>closed",Tickets!J:J,"<>resolved")'],
    ['P2 backlog',
      '=COUNTIFS(Tickets!I:I,"P2",Tickets!J:J,"<>closed",Tickets!J:J,"<>resolved")'],
    ['Escalated tickets open',
      '=COUNTIF(Tickets!J:J,"escalated")'],
    ['Waiting on customer',
      '=COUNTIF(Tickets!J:J,"waiting_customer")'],
    ['Drafts pending approval',
      '=COUNTIF(PendingApprovals!G:G,"FALSE")'],
    ['Low-confidence classifications',
      '=COUNTIFS(Tickets!X:X,"TRUE",Tickets!J:J,"<>closed")'],
    ['Fraud tickets (last 7d)',
      '=COUNTIFS(Tickets!H:H,"fraud",Tickets!D:D,">="&TEXT(TODAY()-7,"yyyy-mm-dd"))'],
    ['Resolution rate (7d)',
      '=IFERROR(COUNTIFS(Tickets!O:O,">="&TEXT(TODAY()-7,"yyyy-mm-dd"))/COUNTIFS(Tickets!D:D,">="&TEXT(TODAY()-7,"yyyy-mm-dd")),0)']
  ];

  d.getRange(4, 1).setValue('Metric').setFontWeight('bold');
  d.getRange(4, 2).setValue('Value').setFontWeight('bold');
  d.getRange(4, 1, 1, 2).setBackground('#f1efe8');

  for (let i = 0; i < kpis.length; i++) {
    d.getRange(5 + i, 1).setValue(kpis[i][0]);
    d.getRange(5 + i, 2).setFormula(kpis[i][1]);
  }
  d.getRange(5 + kpis.length - 1, 2).setNumberFormat('0.0%');

  // Category breakdown
  const catRow = 5 + kpis.length + 2;
  d.getRange(catRow, 1).setValue('Open tickets by category').setFontWeight('bold');
  d.getRange(catRow + 1, 1).setValue('Category').setFontWeight('bold');
  d.getRange(catRow + 1, 2).setValue('Count').setFontWeight('bold');
  d.getRange(catRow + 1, 1, 1, 2).setBackground('#f1efe8');
  const cats = [
    'transfers_nip', 'fraud', 'disputes', 'recall_reversal',
    'reconciliation_settlement', 'statements_reports', 'payments',
    'cards', 'account_kyc', 'technical_api', 'compliance_legal',
    'billing_fees', 'general'
  ];
  cats.forEach((c, i) => {
    d.getRange(catRow + 2 + i, 1).setValue(c);
    d.getRange(catRow + 2 + i, 2).setFormula(
      `=COUNTIFS(Tickets!H:H,"${c}",Tickets!J:J,"<>closed",Tickets!J:J,"<>resolved")`
    );
  });

  // Priority breakdown
  const priRow = catRow + 2 + cats.length + 2;
  d.getRange(priRow, 1).setValue('Open tickets by priority').setFontWeight('bold');
  d.getRange(priRow + 1, 1).setValue('Priority').setFontWeight('bold');
  d.getRange(priRow + 1, 2).setValue('Count').setFontWeight('bold');
  d.getRange(priRow + 1, 1, 1, 2).setBackground('#f1efe8');
  ['P1', 'P2', 'P3'].forEach((p, i) => {
    d.getRange(priRow + 2 + i, 1).setValue(p);
    d.getRange(priRow + 2 + i, 2).setFormula(
      `=COUNTIFS(Tickets!I:I,"${p}",Tickets!J:J,"<>closed",Tickets!J:J,"<>resolved")`
    );
  });

  d.setColumnWidth(1, 320);
  d.setColumnWidth(2, 160);
  d.setFrozenRows(4);
}

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Ticket Hub')
    .addItem('Set up / refresh sheet', 'setupSheet')
    .addToUi();
}
