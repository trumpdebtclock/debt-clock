// Fetches the U.S. Treasury "Debt to the Penny" series and writes data.json.
// Run by .github/workflows/refresh.yml on a weekday schedule.
// No dependencies. Needs Node 18 or newer (for built-in fetch).
//
// On any problem it exits with code 1 WITHOUT writing, so a Treasury outage
// leaves the previous good data.json in place rather than corrupting it.

import { writeFile, readFile } from "node:fs/promises";

const API =
  "https://api.fiscaldata.treasury.gov/services/api/fiscal_service/v2/accounting/od/debt_to_penny";

const die = (msg) => {
  console.error("FAILED: " + msg);
  console.error("data.json was NOT changed.");
  process.exit(1);
};

async function pull(query) {
  const res = await fetch(`${API}?${query}`, {
    headers: { "User-Agent": "debt-accrual-monitor (static site build)" }
  });
  if (!res.ok) die(`Treasury returned HTTP ${res.status}`);
  const json = await res.json();
  return (json.data || [])
    .map((r) => ({ date: r.record_date, amt: Number(r.tot_pub_debt_out_amt) }))
    .filter((r) => r.date && Number.isFinite(r.amt));
}

const t = (d) => Date.parse(d + "T22:00:00Z");

/* ---- 1. Term boundaries. Frozen history, but fetched so they are exact. ----
   For each boundary we list candidate dates newest-first. Inauguration Day
   sometimes falls on a weekend or the MLK holiday, when Treasury publishes
   nothing, so we take the most recent date that actually has a record. */
const BOUNDS = [
  { key: "m1997", probes: ["1997-01-20", "1997-01-17", "1997-01-16"] },
  { key: "m2001", probes: ["2001-01-19", "2001-01-18", "2001-01-17"] },
  { key: "m2005", probes: ["2005-01-20", "2005-01-19", "2005-01-18"] },
  { key: "m2009", probes: ["2009-01-20", "2009-01-16", "2009-01-15"] },
  { key: "m2013", probes: ["2013-01-18", "2013-01-17", "2013-01-16"] },
  { key: "m2017", probes: ["2017-01-20", "2017-01-19", "2017-01-18"] },
  { key: "m2021", probes: ["2021-01-20", "2021-01-19", "2021-01-15"] }
];

const allProbes = BOUNDS.flatMap((b) => b.probes).join(",");
const history = await pull(
  `fields=record_date,tot_pub_debt_out_amt&filter=record_date:in:(${allProbes})&page[size]=100`
);

const byDate = Object.fromEntries(history.map((r) => [r.date, r.amt]));
const marks = {};
for (const b of BOUNDS) {
  const hit = b.probes.find((d) => byDate[d] != null);
  if (!hit) die(`no Treasury record near boundary ${b.key}`);
  marks[b.key] = { date: hit, amount: byDate[hit] };
}

/* ---- 2. The live window: baseline, newest record, and trailing pace ---- */
const rows = await pull(
  "fields=record_date,tot_pub_debt_out_amt" +
    "&filter=record_date:gte:2025-01-10&sort=record_date&page[size]=10000"
);
if (rows.length < 100) die(`series looks too short (${rows.length} rows)`);

const latest = rows[rows.length - 1];

// Baseline: last record published before the 20 Jan 2025 inauguration.
const baseline = [...rows].reverse().find((r) => r.date < "2025-01-20");
if (!baseline) die("could not find the pre-inauguration baseline record");

// Pace over the trailing 90 days of published records.
const cut = t(latest.date) - 90 * 86400000;
const back = [...rows].reverse().find((r) => t(r.date) <= cut) || rows[0];
const spanDays = (t(latest.date) - t(back.date)) / 86400000;
if (spanDays <= 0) die("could not compute a trailing pace");

const pace = (latest.amt - back.amt) / spanDays;
const termDays = (t(latest.date) - t(baseline.date)) / 86400000;
const longRun = (latest.amt - baseline.amt) / termDays;

// Clamp against the average pace since the baseline so one unusual quarter
// cannot send the projection off course.
const ratePerDay = Math.min(Math.max(pace, longRun * 0.35), longRun * 2.5);

if (!Number.isFinite(ratePerDay) || ratePerDay <= 0) die("computed a nonsense rate");
if (latest.amt < 30e12 || latest.amt > 100e12) die(`latest figure looks wrong: ${latest.amt}`);

/* ---- 3. Refuse to move backwards ---- */
try {
  const prev = JSON.parse(await readFile("data.json", "utf8"));
  if (prev.recordDate > latest.date) {
    die(`Treasury returned ${latest.date}, older than the stored ${prev.recordDate}`);
  }
} catch (e) {
  if (e?.code !== "ENOENT") console.warn("note: could not read existing data.json");
}

/* ---- 4. Write ---- */
const out = {
  recordDate: latest.date,
  recordAmount: latest.amt,
  ratePerDay,
  paceObservedDays: Math.round(spanDays),
  baselineDate: baseline.date,
  baselineAmount: baseline.amt,
  marks,
  fetchedAt: new Date().toISOString(),
  source: "U.S. Treasury Fiscal Data, Debt to the Penny"
};

await writeFile("data.json", JSON.stringify(out, null, 2) + "\n");

console.log(`OK  record ${latest.date}  $${latest.amt.toLocaleString("en-US")}`);
console.log(`    pace $${(ratePerDay / 1e9).toFixed(2)}B/day over ${Math.round(spanDays)} days`);
console.log(`    baseline ${baseline.date}  $${baseline.amt.toLocaleString("en-US")}`);
