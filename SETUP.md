# Setting up Psychoco

Psychoco is a Google Sheet with an Apps Script project bound to it. The Sheet
holds the data and is the operator's interface; the script does the scoring and
the scheduling; a Web App shows the group a read-only board.

The source of truth for the code is this repository. The Sheet is where it runs.

---

## 1. One-time, on your machine

You need Node (for `clasp` and the tests) and a Google account.

**Enable the Apps Script API** for the account that will own the tool:
<https://script.google.com/home/usersettings> → turn on *Google Apps Script API*.
Without this, `clasp push` fails with a permissions error.

**Log in.** This opens a browser so Google can authenticate you — your
credentials, nobody else's:

```bash
npx @google/clasp login
```

---

## 2. Create the spreadsheet and its script

```bash
npx @google/clasp create --type sheets --title Psychoco --rootDir apps-script
```

That creates a new spreadsheet *and* a bound Apps Script project, and writes a
`.clasp.json` holding the script id. `.clasp.json` is gitignored — it points at
one specific deployment, so it is local rather than shared.

If you are attaching to a Sheet that already exists, copy
`.clasp.json.example` to `.clasp.json` and paste the script id in instead
(Extensions → Apps Script → Project Settings).

---

## 3. Push the code

```bash
npx @google/clasp push
```

Then open the spreadsheet. A **Psychoco** menu appears next to Help. If it does
not, reload the page — `onOpen` only runs on load.

---

## 4. Build the workbook

**Psychoco → Set up workbook…** and give it the starting year (the year of the
1 October the period begins on).

It creates every tab, sets the headers, adds dropdowns and date validation,
protects the Ledger, Escalations and Audit tabs with a warning, and seeds the
scoring config as version 1.

Then fill in, in this order:

1. **People** — name, arrival, departure (blank if they stay to the end),
   working fraction (`1` for full time, `0.5` for half), any post restrictions,
   and their email.
   - *Restrictions* is a comma-separated list of posts a person may **not**
     hold. Normally empty. Because the chain shifts up on a drop-out, a
     restriction on a heavier post also rules out the lighter ones — someone who
     cannot run a 1st cannot hold 3rd either.
   - *Email* is what the board uses as its viewer allowlist. Leave the column
     empty and any signed-in Google account with the link can read the board, so
     filling it in is worth the five minutes.
2. **Workload** — leave this empty unless somebody's hours change part-way
   through the period. One row per span: name, from, to, and the fraction that
   applies. Rows here override the People tab's `Fraction` for those dates only,
   so going half time in February does not pretend they were half time in
   October. A later row wins over an earlier one, so a correction can just be
   appended.
3. **Holidays** — every public holiday in the period, plus the protected days
   (24/25 December, 31 December, 1 January). `Kind` is `public` or `protected`.
   Nothing else in the system knows what a holiday is.
4. **Config** — the placeholder weights from README §2. **The group has to agree
   these before you generate a roster.** Changing them afterwards changes who is
   owed what.
5. **Period** — put your own name in the `Operator` column. With a shared
   editing account this is the only attribution the audit trail has.

Then **Psychoco → Check for problems**. It reports anything inconsistent before
you build a roster on top of it.

---

## 5. Deploy the board

In the Apps Script editor: **Deploy → New deployment → Web app**.

- *Execute as*: **Me**. The board has to read a Sheet its readers cannot open.
- *Who has access*: **Anyone with a Google account**. The real access control is
  the email allowlist on the People tab; this setting only ensures readers are
  signed in and therefore identified.

Copy the Web App URL. That is what the group gets.

```bash
npx @google/clasp deploy   # subsequent redeploys
```

---

## 6. Sharing — the part that matters

| What | Who | Why |
|---|---|---|
| **The Sheet** | the operator, and nobody else | Anyone with edit access can rewrite the ledger. Anyone with *view* access can read individual absence records, which README §7.1 says the group must never see. |
| **The board URL** | everyone in the pool | Read-only by construction, and it shows balances and the roster without absence detail. |

Do not share the Sheet with the group as a convenience. The board exists so you
never have to.

---

## 7. Running a period

| Task | Menu item |
|---|---|
| Build next month's roster | **Generate roster for a month…** |
| Credit a finished month | **Publish a month to the ledger…** |
| Someone calls in sick | **Record a drop-out…** |
| "Why did I get Christmas?" | **Explain an assignment…** |
| Sanity check | **Check for problems** |
| Someone goes part time | add a row to **Workload**, then check the board |

Generation is monthly on purpose: absences are not known a year ahead, and
rebalancing every month is what keeps the balance level throughout the period
rather than only at the end (README §4).

Nothing counts until it is published. Generating a roster costs nothing and can
be redone freely; publishing credits points and moves balances.

Drop-out days are settled immediately by **Record a drop-out**, which applies
the escalation chain, credits everyone for the post they actually worked, and
records the day as an absence for whoever dropped out. Publishing a month skips
days already in the ledger, so it will not overwrite them.

---

## 8. Backups

Google keeps revision history on the Sheet automatically, which is the main
reason this design is safe. Two things worth doing anyway:

- **File → Version history → Name current version** after each month is
  published. Named versions are much easier to find than a timestamp.
- **File → Make a copy** at the end of the period, named for the period. The
  new period starts from zero (README §4), so last year's workbook is the only
  record of it.

---

## 9. Handing over, each 1 October

1. Make a copy of the finished workbook, named for the period that just ended.
2. Set up the new period: **Psychoco → Set up workbook…** with the new year.
3. Clear People and refill it with the incoming cohort. Clear Absences,
   Roster and Ledger — balances reset to zero and never carry over.
4. Put the new operator's name in the Period tab.
5. Hand over the Google account credentials and the board URL.
6. Re-share the board with the new cohort's email addresses.

---

## 10. Working on the code

The scoring, fairness and scheduling logic is plain JavaScript that touches no
Apps Script API, so it runs under Node:

```bash
node --test test/
```

Everything worth testing lives in `00_schema.gs` through `30_scheduler.gs`.
Anything that touches `SpreadsheetApp` lives in `40_sheet.gs` and above and is
deliberately thin, because Apps Script has no test runner.

```bash
npx @google/clasp push     # upload
npx @google/clasp pull     # if someone edited in the browser
npx @google/clasp deploy   # publish a new Web App version
```

If you edit in the browser, `clasp pull` before you push, or you will overwrite
it.
