// src/B2CDialer.jsx
//
// B2C Dialer — "the pot": only leads that are DUE for a call right now.
// Sections: Opt-Ins · Confirmations (booked appts) · 30-Min Prior.
// MASTER leads (b2c_master_leads / b2c_master_bookings, from the live
// funnel) flow into the SAME three pots — same cadence, same mechanics.
// Master opt-in cards keep the per-client booking calendar; Show / No Show
// on a master booking writes b2c_master_bookings.status, which the
// B2C Campaign Metrics tracker reads — setter outcomes feed ad stats.
// Every card shows the call stage ("Day 2 · 1:00 PM call") and the SAST time
// that slot corresponds to. Click a card open for full details: client,
// booking calendar link + name, timezone, phone/email, GHL contact link.
//
//   ☎ Called — no answer  -> clears the lead until its next slot
//   ✓ Called — picked up  -> lead never reappears in that pot (reached)
// Missed slots self-heal: the card always shows the FRESHEST due slot.
//
// Cadence (lead-local): days 1-3 → 9a/1p/5p · days 4-6 → 9a/3p · day 7+ → 12p.
// Requires 28_b2c.sql + 29_b2c_calendar.sql and the b2c webhooks + b2c-cron.

import { useEffect, useMemo, useState } from "react";
import { supabase } from "./supabaseClient";

const C = {
  bg: "#0f1115", panel: "#171a21", panel2: "#1d212b", border: "#262b36",
  text: "#e7e9ee", dim: "#8b909e", faint: "#5b606e",
  accent: "#5b8def", green: "#3ecf8e", amber: "#e9b949", violet: "#a78bfa", red: "#f0616d",
};

// ---- MASTER ROUTER (state-based routing across all clients) ----
// Booking goes through the agency-ops Netlify functions (shared engine with
// the master landing page): eligibility, weekly limits, weighted assignment.
const MASTER_API = "https://buildflowtracking.netlify.app/.netlify/functions";

// Dominant timezone per state — slot times are shown in the LEAD's local time.
const STATE_TZ = {
  CT:"America/New_York", DE:"America/New_York", FL:"America/New_York", GA:"America/New_York",
  IN:"America/New_York", KY:"America/New_York", ME:"America/New_York", MD:"America/New_York",
  MA:"America/New_York", MI:"America/New_York", NH:"America/New_York", NJ:"America/New_York",
  NY:"America/New_York", NC:"America/New_York", OH:"America/New_York", PA:"America/New_York",
  RI:"America/New_York", SC:"America/New_York", VT:"America/New_York", VA:"America/New_York",
  WV:"America/New_York", DC:"America/New_York",
  AL:"America/Chicago", AR:"America/Chicago", IL:"America/Chicago", IA:"America/Chicago",
  KS:"America/Chicago", LA:"America/Chicago", MN:"America/Chicago", MS:"America/Chicago",
  MO:"America/Chicago", NE:"America/Chicago", ND:"America/Chicago", OK:"America/Chicago",
  SD:"America/Chicago", TN:"America/Chicago", TX:"America/Chicago", WI:"America/Chicago",
  AZ:"America/Phoenix", CO:"America/Denver", ID:"America/Denver", MT:"America/Denver",
  NM:"America/Denver", UT:"America/Denver", WY:"America/Denver",
  CA:"America/Los_Angeles", NV:"America/Los_Angeles", OR:"America/Los_Angeles", WA:"America/Los_Angeles",
  AK:"America/Anchorage", HI:"Pacific/Honolulu",
};
const mLeadTz = (st) => STATE_TZ[st] || "America/New_York";

// Master-lead call cadence — same rules as b2c-cron.js and the old pots.
// Keys match the cron's keys exactly, so ticking a call here stops that
// lead's Slack reminder (and vice versa).
function mNowParts(iana) {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: iana, hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  const o = {};
  for (const p of f.formatToParts(new Date())) if (p.type !== "literal") o[p.type] = p.value;
  let hh = parseInt(o.hour, 10); if (hh === 24) hh = 0;
  return { y: +o.year, m: +o.month, d: +o.day, hh, mm: +o.minute };
}
function mDateParts(iso, iana) {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: iana, year: "numeric", month: "2-digit", day: "2-digit" });
  const [y, m, d] = f.format(new Date(iso)).split("-").map(Number);
  return { y, m, d };
}
const mDayKey = (p) => `${p.y}-${pad(p.m)}-${pad(p.d)}`;
const mDayDiff = (a, b) => Math.round((Date.UTC(b.y, b.m - 1, b.d) - Date.UTC(a.y, a.m - 1, a.d)) / 86400e3);
const mReached = (l, prefix) =>
  Object.entries(l.setter_calls || {}).some(([k, v]) => v === "picked_up" && k.startsWith(prefix));

// The freshest DUE, untouched slot today — or null.
function mDueSlot(lead, baseIso, prefix) {
  const iana = mLeadTz(lead.state);
  if (!baseIso) return null;
  const nowP = mNowParts(iana);
  const idx = mDayDiff(mDateParts(baseIso, iana), nowP);
  if (idx < 0) return null;
  const calls = lead.setter_calls || {};
  const nowMin = nowP.hh * 60 + nowP.mm;
  let current = null;
  for (const [hh, label] of timesForDay(idx)) {
    const key = `${prefix}|${mDayKey(nowP)}|${pad(hh)}00`;
    if (hh * 60 > nowMin || calls[key]) continue;
    const dueUTC = zonedWallToUTC(nowP.y, nowP.m, nowP.d, hh, 0, iana);
    current = { key, label, stage: `Day ${idx + 1} · ${label} call`, sast: sastTime(dueUTC), due: dueUTC };
  }
  return current;
}
// The next slot still ahead today (for "next: …" on non-due cards).
function mNextSlot(lead, baseIso) {
  const iana = mLeadTz(lead.state);
  if (!baseIso) return null;
  const nowP = mNowParts(iana);
  const idx = mDayDiff(mDateParts(baseIso, iana), nowP);
  if (idx < 0) return null;
  const nowMin = nowP.hh * 60 + nowP.mm;
  for (const [hh, label] of timesForDay(idx)) {
    if (hh * 60 > nowMin) return { label, stage: `Day ${idx + 1} · ${label}`, due: zonedWallToUTC(nowP.y, nowP.m, nowP.d, hh, 0, iana) };
  }
  return null;
}
// What the card header shows: fresh arrival, a due slot, or the next one up.
function mCallState(lead) {
  if (!lead.setter_calls || !lead.setter_calls["mopt|arrival"]) {
    return { kind: "fresh", key: "mopt|arrival", stage: "NEW OPT-IN · call now" };
  }
  if (mReached(lead, "mopt")) return { kind: "reached", stage: "✓ Reached" };
  const due = mDueSlot(lead, lead.created_at, "mopt");
  if (due) return { kind: "due", key: due.key, stage: due.stage, sast: due.sast };
  const next = mNextSlot(lead, lead.created_at);
  if (next) return { kind: "next", stage: `next: ${next.stage}`, due: next.due };
  return { kind: "idle", stage: "no calls due today" };
}
const mFmt = (iso, tz, opts) => new Date(iso).toLocaleString("en-US", { timeZone: tz, ...opts });
const mTzShort = (iso, tz) => {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "short" }).formatToParts(new Date(iso));
  return (parts.find((p) => p.type === "timeZoneName") || {}).value || "";
};

const TZ_ORDER = ["ET", "CT", "MT", "PT"];
const TZ_IANA = { ET: "America/New_York", CT: "America/Chicago", MT: "America/Denver", PT: "America/Los_Angeles" };
const SAST = "Africa/Johannesburg";

/* ---- time helpers ---- */
const pad = (n) => String(n).padStart(2, "0");
function nowPartsIn(iana) {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: iana, hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  const o = {};
  for (const p of f.formatToParts(new Date())) if (p.type !== "literal") o[p.type] = p.value;
  let hh = parseInt(o.hour, 10); if (hh === 24) hh = 0;
  return { y: +o.year, m: +o.month, d: +o.day, hh, mm: +o.minute };
}
function datePartsIn(iso, iana) {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: iana, year: "numeric", month: "2-digit", day: "2-digit" });
  const [y, m, d] = f.format(new Date(iso)).split("-").map(Number);
  return { y, m, d };
}
const dayKey = (p) => `${p.y}-${pad(p.m)}-${pad(p.d)}`;
const dayDiff = (a, b) => Math.round((Date.UTC(b.y, b.m - 1, b.d) - Date.UTC(a.y, a.m - 1, a.d)) / 86400e3);
// wall time in a tz -> real UTC Date (DST-correct)
function zonedWallToUTC(y, m, d, hh, mm, iana) {
  const guess = Date.UTC(y, m - 1, d, hh, mm, 0);
  const f = new Intl.DateTimeFormat("en-US", { timeZone: iana, hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const o = {};
  for (const p of f.formatToParts(new Date(guess))) if (p.type !== "literal") o[p.type] = p.value;
  let sh = parseInt(o.hour, 10); if (sh === 24) sh = 0;
  const seenUTC = Date.UTC(+o.year, +o.month - 1, +o.day, sh, +o.minute, +o.second);
  return new Date(guess + (guess - seenUTC));
}
function sastTime(dt) {
  return new Intl.DateTimeFormat("en-GB", { timeZone: SAST, hour: "2-digit", minute: "2-digit" }).format(dt);
}
function timesForDay(idx) {
  if (idx <= 2) return [[9, "9:00 AM"], [13, "1:00 PM"], [17, "5:00 PM"]];
  if (idx <= 5) return [[9, "9:00 AM"], [15, "3:00 PM"]];
  return [[12, "12:00 PM"]];
}

// reached = picked up at least once within this pipeline (prefix)
function reached(lead, prefix) {
  const c = lead.setter_calls || {};
  return Object.entries(c).some(([k, v]) => v === "picked_up" && k.startsWith(prefix));
}
// The FRESHEST due, unhandled slot today for this lead — or null.
function dueSlot(lead, baseIso, prefix) {
  const iana = TZ_IANA[lead.timezone];
  if (!iana || !baseIso) return null;
  const nowP = nowPartsIn(iana);
  const base = datePartsIn(baseIso, iana);
  const idx = dayDiff(base, nowP);
  if (idx < 0) return null;
  const calls = lead.setter_calls || {};
  const nowMin = nowP.hh * 60 + nowP.mm;
  let current = null;
  for (const [hh, label] of timesForDay(idx)) {
    const key = `${prefix}|${dayKey(nowP)}|${pad(hh)}00`;
    if (hh * 60 <= nowMin && !calls[key]) {
      const dueUTC = zonedWallToUTC(nowP.y, nowP.m, nowP.d, hh, 0, iana);
      current = { key, label, stage: `Day ${idx + 1} · ${label} call`, sast: sastTime(dueUTC) };
    }
  }
  return current;
}
function minsToAppt(lead) {
  const m = String(lead.appt_at || "").match(/(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/);
  const iana = TZ_IANA[lead.timezone];
  if (!m || !iana) return null;
  const inst = zonedWallToUTC(+m[1], +m[2], +m[3], +m[4], +m[5], iana);
  return Math.round((inst.getTime() - Date.now()) / 60000);
}
const fmtAppt = (l) => l.appt_at ? String(l.appt_at).slice(0, 16).replace("T", " ") + ` ${l.timezone || ""}` : "—";
const ghlLink = (l) => (l.ghl_location_id && l.ghl_contact_id)
  ? `https://app.gohighlevel.com/v2/location/${l.ghl_location_id}/contacts/detail/${l.ghl_contact_id}` : null;

export default function B2CDialer() {
  const [leads, setLeads] = useState([]);
  const [mLeads, setMLeads] = useState([]);           // b2c_master_leads
  const [mBookings, setMBookings] = useState({});     // lead_id -> latest booking
  const [mClients, setMClients] = useState({});       // client_id -> name
  const [loading, setLoading] = useState(true);
  const [section, setSection] = useState("optins");
  const [client, setClient] = useState("All");
  const [q, setQ] = useState("");
  const [, setTick] = useState(0);

  async function load() {
    setLoading(true);
    const [{ data }, ml, mb, mc] = await Promise.all([
      supabase.from("b2c_leads").select("*").is("archived_at", null).order("opt_in_at", { ascending: false, nullsFirst: false }).limit(300),
      supabase.from("b2c_master_leads").select("*").is("archived_at", null).order("created_at", { ascending: false }).limit(100),
      supabase.from("b2c_master_bookings").select("id, lead_id, client_id, slot_start, booked_by, booked_at, status").order("booked_at", { ascending: false }).limit(400),
      supabase.from("b2c_clients").select("id, name"),
    ]);
    setLeads(data || []);
    setMLeads(ml.data || []);
    const bm = {};
    (mb.data || []).forEach((r) => { if (!bm[r.lead_id]) bm[r.lead_id] = r; });
    setMBookings(bm);
    const cm = {};
    (mc.data || []).forEach((c) => { cm[c.id] = c.name; });
    setMClients(cm);
    setLoading(false);
  }
  useEffect(() => { load(); }, []);
  useEffect(() => { const t = setInterval(() => setTick((x) => x + 1), 60000); return () => clearInterval(t); }, []);

  const clients = useMemo(() => ["All", ...Array.from(new Set(leads.map((l) => l.client).filter(Boolean))).sort()], [leads]);
  const visible = client === "All" ? leads : leads.filter((l) => l.client === client);

  async function record(lead, slotKey, outcome) {
    const calls = { ...(lead.setter_calls || {}), [slotKey]: outcome };
    await supabase.from("b2c_leads").update({ setter_calls: calls }).eq("id", lead.id);
    load();
  }
  async function setStage(lead, stage) {
    await supabase.from("b2c_leads").update({ stage }).eq("id", lead.id);
    load();
  }
  // Show / No Show on a master booking — writes the same status field the
  // B2C Campaign Metrics tracker reads, so setter outcomes feed ad stats.
  async function setMasterStatus(booking, status) {
    await supabase.from("b2c_master_bookings").update({ status }).eq("id", booking.id);
    load();
  }
  // Master leads keep their call ticks on b2c_master_leads.setter_calls.
  async function recordMaster(lead, slotKey, outcome) {
    const calls = { ...(lead.setter_calls || {}) };
    if (calls[slotKey] === outcome) delete calls[slotKey]; else calls[slotKey] = outcome;
    await supabase.from("b2c_master_leads").update({ setter_calls: calls }).eq("id", lead.id);
    load();
  }

  // build the pots — only leads DUE right now
  const optPot = [];
  for (const l of visible) {
    if (l.stage === "Opt-In" && !reached(l, "b2copt")) {
      const s = dueSlot(l, l.opt_in_at, "b2copt");
      if (s) optPot.push({ l, s });
    } else if (l.stage === "No Show" && !reached(l, "b2cns")) {
      const iana = TZ_IANA[l.timezone];
      if (iana) {
        const nowP = nowPartsIn(iana);
        const key = `b2cns|${dayKey(nowP)}|1200`;
        if (nowP.hh >= 12 && !(l.setter_calls || {})[key]) {
          const dueUTC = zonedWallToUTC(nowP.y, nowP.m, nowP.d, 12, 0, iana);
          optPot.push({ l, s: { key, label: "12:00 PM", stage: "No-show nurture · 12:00 PM call", sast: sastTime(dueUTC) } });
        }
      }
    }
  }
  const confPot = [];
  for (const l of visible) {
    if (l.stage !== "Booked" || reached(l, "b2cconf")) continue;
    const m = minsToAppt(l);
    if (m == null || m <= 0) continue;
    const s = dueSlot(l, l.booked_at || l.opt_in_at, "b2cconf");
    if (s) confPot.push({ l, s });
  }
  const priorPot = visible.filter((l) => l.stage === "Booked").map((l) => ({ l, m: minsToAppt(l) }))
    .filter(({ m }) => m != null && m <= 30 && m > -15);

  const tzSort = (a, b) => TZ_ORDER.indexOf(a.l.timezone) - TZ_ORDER.indexOf(b.l.timezone);
  optPot.sort(tzSort); confPot.sort(tzSort);

  // ---- MASTER leads folded into the same pots ----
  // Opt-Ins: unbooked master leads that are fresh or due (their cards keep
  // the per-client booking calendar), plus no-show nurture at 12pm local.
  const mUnbooked = mLeads.filter((l) => !mBookings[l.id]);
  const mOptDue = mUnbooked
    .filter((l) => ["fresh", "due"].includes(mCallState(l).kind))
    .sort((a, b) => (mCallState(a).kind === "fresh" ? 0 : 1) - (mCallState(b).kind === "fresh" ? 0 : 1));
  const mNurture = [];
  for (const l of mLeads) {
    const bk = mBookings[l.id];
    if (!bk || bk.status !== "no_show" || mReached(l, "mns")) continue;
    const iana = mLeadTz(l.state);
    const nowP = mNowParts(iana);
    const key = `mns|${mDayKey(nowP)}|1200`;
    if (nowP.hh >= 12 && !(l.setter_calls || {})[key]) {
      const dueUTC = zonedWallToUTC(nowP.y, nowP.m, nowP.d, 12, 0, iana);
      mNurture.push({ l, force: { kind: "due", key, stage: "No-show nurture · 12:00 PM call", sast: sastTime(dueUTC) } });
    }
  }
  // Confirmations: master bookings with a future appt, on the same cadence.
  const mConf = [];
  for (const l of mLeads) {
    const bk = mBookings[l.id];
    if (!bk || ["cancelled", "showed", "no_show"].includes(bk.status || "")) continue;
    if (new Date(bk.slot_start).getTime() <= Date.now()) continue;
    if (mReached(l, "mconf")) continue;
    const due = mDueSlot(l, bk.booked_at || l.created_at, "mconf");
    if (due) mConf.push({ l, bk, s: due });
  }
  // 30-Min Prior: master appts starting within 30 minutes.
  const mPrior = [];
  for (const l of mLeads) {
    const bk = mBookings[l.id];
    if (!bk || (bk.status || "") === "cancelled") continue;
    const m = Math.round((new Date(bk.slot_start).getTime() - Date.now()) / 60000);
    if (m <= 30 && m > -15) mPrior.push({ l, bk, m });
  }

  // ---- ALL LEADS: both pipelines, newest first, statuses editable ----
  const allRows = useMemo(() => {
    const rows = [
      ...mLeads.map((l) => ({ kind: "m", l, bk: mBookings[l.id] || null, at: l.created_at })),
      ...leads.map((l) => ({ kind: "o", l, at: l.opt_in_at || l.created_at })),
    ].sort((a, b) => new Date(b.at || 0) - new Date(a.at || 0));
    const needle = q.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter(({ l }) =>
      [l.full_name, l.phone, l.email, l.state, l.client].some((f) => String(f || "").toLowerCase().includes(needle)));
  }, [mLeads, leads, mBookings, q]);

  // SAST legend: what each tz's call hours are in SAST today
  const legend = TZ_ORDER.map((tz) => {
    const iana = TZ_IANA[tz];
    const nowP = nowPartsIn(iana);
    const times = [9, 13, 17].map((hh) => sastTime(zonedWallToUTC(nowP.y, nowP.m, nowP.d, hh, 0, iana)));
    return `${tz} 9a/1p/5p → ${times.join(" / ")}`;
  });

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 14, flexWrap: "wrap" }}>
        <div>
          <h1 style={{ fontSize: 26, fontWeight: 600, margin: 0 }}>B2C Dialer</h1>
          <p style={{ color: C.dim, marginTop: 6, marginBottom: 0, fontSize: 13.5 }}>
            Only leads due for a call show here. It's <b>{sastTime(new Date())} SAST</b> now.
          </p>
          <p style={{ color: C.faint, marginTop: 4, marginBottom: 0, fontSize: 11.5 }}>
            Appropriate times to call, in SAST: {legend.join(" · ")}
          </p>
        </div>
        <select value={client} onChange={(e) => setClient(e.target.value)} style={sel}>
          {clients.map((c) => <option key={c} value={c}>{c === "All" ? "All clients" : c}</option>)}
        </select>
      </div>

      <div style={{ display: "flex", gap: 8, marginTop: 16, flexWrap: "wrap" }}>
        <SectionBtn on={section === "optins"} onClick={() => setSection("optins")} label={`Opt-Ins (${optPot.length + mOptDue.length + mNurture.length})`} />
        <SectionBtn on={section === "conf"} onClick={() => setSection("conf")} label={`Confirmations (${confPot.length + mConf.length})`} />
        <SectionBtn on={section === "prior"} onClick={() => setSection("prior")} label={`⏰ 30-Min Prior (${priorPot.length + mPrior.length})`} tone={(priorPot.length + mPrior.length) ? C.red : null} />
        <SectionBtn on={section === "all"} onClick={() => setSection("all")} label={`All Leads (${mLeads.length + leads.length})`} />
      </div>

      {loading ? <p style={{ color: C.dim, marginTop: 20 }}>Loading…</p> : (
        <div style={{ marginTop: 18, display: "flex", flexDirection: "column", gap: 10, maxWidth: 680 }}>
          {section === "optins" && ((optPot.length + mOptDue.length + mNurture.length)
            ? <>
                {mOptDue.map((l) => <MasterLeadCard key={l.id} l={l} onBooked={load} onCall={recordMaster} />)}
                {mNurture.map(({ l, force }) => <MasterLeadCard key={l.id + "-ns"} l={l} onBooked={load} onCall={recordMaster} forceCall={force} />)}
                {optPot.map(({ l, s }) => <PotCard key={l.id} l={l} s={s} record={record} />)}
              </>
            : <Empty>No opt-in calls due right now. 🎉</Empty>)}
          {section === "conf" && ((confPot.length + mConf.length)
            ? <>
                {mConf.map(({ l, bk, s }) => <MasterConfCard key={l.id} l={l} bk={bk} s={s} clientName={mClients[bk.client_id] || "—"} onCall={recordMaster} onStatus={setMasterStatus} />)}
                {confPot.map(({ l, s }) => <PotCard key={l.id} l={l} s={s} record={record} conf setStage={setStage} />)}
              </>
            : <Empty>No confirmation calls due right now. 🎉</Empty>)}
          {section === "prior" && ((priorPot.length + mPrior.length)
            ? <>
                {mPrior.map(({ l, bk, m }) => <MasterPriorCard key={l.id} l={l} bk={bk} m={m} clientName={mClients[bk.client_id] || "—"} onStatus={setMasterStatus} />)}
                {priorPot.map(({ l, m }) => <PriorCard key={l.id} l={l} m={m} setStage={setStage} />)}
              </>
            : <Empty>No appointments starting within 30 minutes.</Empty>)}
          {section === "all" && (
            <>
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name / phone / email / state…"
                style={{ ...sel, width: "100%", boxSizing: "border-box" }} />
              {allRows.length === 0 && <Empty>No leads match.</Empty>}
              {allRows.map((r) => r.kind === "m"
                ? <AllRowMaster key={"m" + r.l.id} l={r.l} bk={r.bk} clientName={r.bk ? (mClients[r.bk.client_id] || "—") : ""} onStatus={setMasterStatus} />
                : <AllRowOld key={"o" + r.l.id} l={r.l} setStage={setStage} />)}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function PotCard({ l, s, record, conf, setStage }) {
  const ghl = ghlLink(l);
  return (
    <details style={{ background: C.panel, border: `1px solid ${C.amber}44`, borderRadius: 12 }}>
      <summary style={{ listStyle: "none", cursor: "pointer", padding: "12px 15px", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <span style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
          <span style={{ fontWeight: 700, fontSize: 14 }}>{l.full_name || "—"}</span>
          <span style={{ fontFamily: "monospace", fontSize: 12, color: C.dim }}>{l.phone || "—"}</span>
          <span style={{ fontSize: 11, color: C.violet }}>{l.timezone || "?"}</span>
        </span>
        <span style={{ textAlign: "right" }}>
          <span style={{ fontSize: 12, fontWeight: 700, color: C.amber }}>{s.stage}</span>
          <span style={{ fontSize: 11, color: C.faint, marginLeft: 8 }}>= {s.sast} SAST</span>
        </span>
      </summary>
      <div style={{ padding: "0 15px 13px", borderTop: `1px solid ${C.border}` }}>
        <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "5px 14px", fontSize: 12.5, marginTop: 10 }}>
          <span style={{ color: C.dim }}>Client</span><span>{l.client || "—"}</span>
          <span style={{ color: C.dim }}>Email</span><span>{l.email || "—"}</span>
          <span style={{ color: C.dim }}>Stage</span><span>{s.stage} <span style={{ color: C.faint }}>({s.sast} SAST)</span></span>
          {conf && <><span style={{ color: C.dim }}>Appt</span><span>{fmtAppt(l)}</span></>}
          {l.calendar_name && <><span style={{ color: C.dim }}>Calendar</span>
            <span>{l.calendar_url
              ? <a href={l.calendar_url} target="_blank" rel="noreferrer" style={{ color: C.accent }}>{l.calendar_name} ↗</a>
              : l.calendar_name}</span></>}
          {!l.calendar_name && l.calendar_url && <><span style={{ color: C.dim }}>Calendar</span>
            <span><a href={l.calendar_url} target="_blank" rel="noreferrer" style={{ color: C.accent }}>Book here ↗</a></span></>}
          {ghl && <><span style={{ color: C.dim }}>GHL</span>
            <span><a href={ghl} target="_blank" rel="noreferrer" style={{ color: C.accent }}>Open contact ↗</a></span></>}
        </div>
        <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
          <button style={btn(C.green)} onClick={() => record(l, s.key, "picked_up")}>✓ Called — picked up</button>
          <button style={btn(C.faint)} onClick={() => record(l, s.key, "no_pickup")}>☎ Called — no answer</button>
          {conf && (
            <>
              <button style={btn(C.accent)} onClick={() => setStage(l, "Show")}>Show</button>
              <button style={btn(C.red)} onClick={() => setStage(l, "No Show")}>No Show</button>
            </>
          )}
        </div>
      </div>
    </details>
  );
}

function PriorCard({ l, m, setStage }) {
  const ghl = ghlLink(l);
  return (
    <div style={{ background: C.panel, border: `1px solid ${C.red}66`, borderRadius: 12, padding: 14 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
        <div>
          <span style={{ fontWeight: 700, fontSize: 14.5 }}>{l.full_name || "—"}</span>
          <div style={{ fontFamily: "monospace", fontSize: 12, color: C.dim, marginTop: 2 }}>{l.phone || "—"}{l.client ? `  ·  [${l.client}]` : ""}</div>
          {ghl && <a href={ghl} target="_blank" rel="noreferrer" style={{ color: C.accent, fontSize: 12 }}>Open in GHL ↗</a>}
        </div>
        <div style={{ textAlign: "right" }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: m <= 0 ? C.red : C.amber }}>{m <= 0 ? "starting now" : `in ${m} min`}</div>
          <div style={{ fontSize: 11.5, color: C.dim }}>{fmtAppt(l)}</div>
        </div>
      </div>
      <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
        <button style={btn(C.accent)} onClick={() => setStage(l, "Show")}>Show</button>
        <button style={btn(C.red)} onClick={() => setStage(l, "No Show")}>No Show</button>
      </div>
    </div>
  );
}

/* ---- MASTER ROUTER cards ---- */
// Opt-in card: expand -> day tabs -> PER-CLIENT availability for the lead's
// state (only clients under their weekly cap), times in the lead's local tz.
// One click on a time -> confirm popup -> books onto that client's calendar.
function MasterLeadCard({ l, onBooked, onCall, forceCall }) {
  const call = forceCall || mCallState(l);
  const [day, setDay] = useState(-1);       // -1 = not loaded yet
  const [detail, setDetail] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const tz = mLeadTz(l.state);

  const dayDate = (offset) => { const d = new Date(); d.setDate(d.getDate() + offset); return d; };

  async function loadDetail(offset) {
    setDay(offset); setDetail(null); setMsg("");
    const target = dayDate(offset); target.setHours(0, 0, 0, 0);
    const end = new Date(target); end.setHours(23, 59, 59, 999);
    try {
      const r = await fetch(`${MASTER_API}/master-slots`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ state: l.state, startMs: target.getTime(), endMs: end.getTime(), timezone: tz, detail: true }),
      });
      const data = await r.json();
      if (data.no_coverage) { setMsg("No coverage / all clients at their weekly limit for this state."); setDetail([]); return; }
      const now = Date.now();
      setDetail((data.clients || []).map((c) => ({ ...c, slots: (c.slots || []).filter((iso) => new Date(iso).getTime() > now) })));
    } catch (e) { setMsg("Failed to load availability."); setDetail([]); }
  }

  async function book(clientEntry, iso) {
    const when = mFmt(iso, tz, { weekday: "long", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    const ok = window.confirm(
      `Book ${l.full_name} with ${clientEntry.name}?\n\n${when} ${mTzShort(iso, tz)} (lead's local time)\n\nClick OK to confirm the booking.`
    );
    if (!ok) return;
    setBusy(true); setMsg("");
    try {
      const r = await fetch(`${MASTER_API}/master-book`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lead_id: l.id, slot: iso, timezone: tz, booked_by: "setter", client_id: clientEntry.client_id }),
      });
      const data = await r.json();
      if (data.booked) { setMsg(`Booked → ${data.client.name} ✓`); setTimeout(onBooked, 900); }
      else if (data.error === "client_unavailable") { setMsg("That client just lost the slot or hit their limit — refreshing."); loadDetail(day); }
      else if (data.error === "slot_taken") { setMsg("Slot just taken — refreshing."); loadDetail(day); }
      else setMsg(data.error || "Booking failed.");
    } catch (e) { setMsg("Booking failed."); }
    setBusy(false);
  }

  return (
    <details style={{ background: C.panel, border: `1px solid ${C.accent}44`, borderRadius: 12 }}
      onToggle={(e) => { if (e.target.open && day === -1) loadDetail(0); }}>
      <summary style={{ listStyle: "none", cursor: "pointer", padding: "12px 15px", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <span style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
          <span style={{ fontWeight: 700, fontSize: 14 }}>{l.full_name || "—"}</span>
          <span style={{ fontFamily: "monospace", fontSize: 12, color: C.dim }}>{l.phone || "—"}</span>
          <span style={{ fontSize: 11, color: C.violet }}>{l.state}</span>
        </span>
        <span style={{ textAlign: "right" }}>
          <span style={{
            fontSize: 12, fontWeight: 700,
            color: call.kind === "fresh" ? C.green : call.kind === "due" ? C.amber : call.kind === "reached" ? C.green : C.faint,
          }}>{call.stage}</span>
          <span style={{ fontSize: 11, color: C.faint, marginLeft: 8 }}>
            {call.kind === "due" ? `= ${call.sast} SAST` : `opted in ${new Date(l.created_at).toLocaleDateString()}`}
          </span>
        </span>
      </summary>
      <div style={{ padding: "0 15px 13px", borderTop: `1px solid ${C.border}` }}>
        <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "5px 14px", fontSize: 12.5, marginTop: 10 }}>
          <span style={{ color: C.dim }}>Email</span><span>{l.email || "—"}</span>
          <span style={{ color: C.dim }}>Income</span><span>{l.household_income || "—"}</span>
          <span style={{ color: C.dim }}>Local time</span><span>{mFmt(new Date().toISOString(), tz, { hour: "numeric", minute: "2-digit" })} {mTzShort(new Date().toISOString(), tz)}</span>
        </div>
        {onCall && (call.kind === "fresh" || call.kind === "due") && (
          <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
            <button style={btn(C.green)} onClick={() => onCall(l, call.key, "picked_up")}>✓ Called — picked up</button>
            <button style={btn(C.faint)} onClick={() => onCall(l, call.key, "no_pickup")}>☎ Called — no answer</button>
          </div>
        )}
        <div style={{ display: "flex", gap: 5, marginTop: 12, flexWrap: "wrap", alignItems: "center" }}>
          {[0, 1, 2, 3, 4].map((i) => (
            <button key={i} onClick={() => loadDetail(i)} style={{
              ...btn(day === i ? C.accent : C.faint),
              background: day === i ? C.accent : "transparent", color: day === i ? "#fff" : C.dim,
            }}>{dayDate(i).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })}</button>
          ))}
          <span style={{ fontSize: 11, color: C.faint, marginLeft: 6 }}>times in {l.state} local</span>
        </div>
        {detail === null && day !== -1 && <p style={{ color: C.dim, fontSize: 12, marginTop: 10 }}>Loading availability…</p>}
        {detail !== null && (
          <div style={{ display: "grid", gap: 10, marginTop: 12 }}>
            {detail.length === 0 && !msg && <span style={{ color: C.dim, fontSize: 12 }}>No eligible clients.</span>}
            {detail.map((c) => (
              <div key={c.client_id} style={{ borderTop: `1px solid ${C.border}`, paddingTop: 8 }}>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, marginBottom: 6 }}>
                  <strong>{c.name}</strong>
                  <span style={{ color: c.booked >= c.weekly_limit ? C.red : C.dim }}>{c.booked} / {c.weekly_limit} this week</span>
                </div>
                {c.slots.length === 0 ? (
                  <span style={{ color: C.faint, fontSize: 12 }}>No times this day.</span>
                ) : (
                  <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                    {c.slots.map((iso) => (
                      <button key={iso} disabled={busy} style={btn(C.green)} onClick={() => book(c, iso)}>
                        {mFmt(iso, tz, { hour: "numeric", minute: "2-digit" })}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
        {msg && <p style={{ color: msg.includes("✓") ? C.green : C.red, fontSize: 12, marginTop: 8 }}>{msg}</p>}
      </div>
    </details>
  );
}

// Confirmation card for a master booking: same cadence + call buttons as the
// old pots, plus Show / No Show writing b2c_master_bookings.status.
function MasterConfCard({ l, bk, s, clientName, onCall, onStatus }) {
  const tz = mLeadTz(l.state);
  return (
    <details style={{ background: C.panel, border: `1px solid ${C.amber}44`, borderRadius: 12 }}>
      <summary style={{ listStyle: "none", cursor: "pointer", padding: "12px 15px", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <span style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
          <span style={{ fontWeight: 700, fontSize: 14 }}>{l.full_name || "—"}</span>
          <span style={{ fontFamily: "monospace", fontSize: 12, color: C.dim }}>{l.phone || "—"}</span>
          <span style={{ fontSize: 11, color: C.violet }}>{l.state}</span>
        </span>
        <span style={{ textAlign: "right" }}>
          <span style={{ fontSize: 12, fontWeight: 700, color: C.amber }}>{s.stage}</span>
          <span style={{ fontSize: 11, color: C.faint, marginLeft: 8 }}>= {s.sast} SAST</span>
        </span>
      </summary>
      <div style={{ padding: "0 15px 13px", borderTop: `1px solid ${C.border}` }}>
        <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "5px 14px", fontSize: 12.5, marginTop: 10 }}>
          <span style={{ color: C.dim }}>Client</span><span style={{ color: C.green, fontWeight: 600 }}>{clientName}</span>
          <span style={{ color: C.dim }}>Email</span><span>{l.email || "—"}</span>
          <span style={{ color: C.dim }}>Appt</span>
          <span>{mFmt(bk.slot_start, tz, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })} {mTzShort(bk.slot_start, tz)} <span style={{ color: C.faint }}>(lead local) · by {bk.booked_by}</span></span>
        </div>
        <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
          <button style={btn(C.green)} onClick={() => onCall(l, s.key, "picked_up")}>✓ Called — picked up</button>
          <button style={btn(C.faint)} onClick={() => onCall(l, s.key, "no_pickup")}>☎ Called — no answer</button>
          <button style={btn(C.accent)} onClick={() => onStatus(bk, "showed")}>Show</button>
          <button style={btn(C.red)} onClick={() => onStatus(bk, "no_show")}>No Show</button>
        </div>
      </div>
    </details>
  );
}

// 30-min-prior card for a master booking.
function MasterPriorCard({ l, bk, m, clientName, onStatus }) {
  const tz = mLeadTz(l.state);
  return (
    <div style={{ background: C.panel, border: `1px solid ${C.red}66`, borderRadius: 12, padding: 14 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
        <div>
          <span style={{ fontWeight: 700, fontSize: 14.5 }}>{l.full_name || "—"}</span>
          <div style={{ fontFamily: "monospace", fontSize: 12, color: C.dim, marginTop: 2 }}>{l.phone || "—"}  ·  [{clientName}]</div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: m <= 0 ? C.red : C.amber }}>{m <= 0 ? "starting now" : `in ${m} min`}</div>
          <div style={{ fontSize: 11.5, color: C.dim }}>{mFmt(bk.slot_start, tz, { weekday: "short", hour: "numeric", minute: "2-digit" })} {mTzShort(bk.slot_start, tz)}</div>
        </div>
      </div>
      <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
        <button style={btn(C.accent)} onClick={() => onStatus(bk, "showed")}>Show</button>
        <button style={btn(C.red)} onClick={() => onStatus(bk, "no_show")}>No Show</button>
      </div>
    </div>
  );
}

// ---- All Leads rows ----
const M_STATUS = [["unconfirmed", "Unconfirmed"], ["confirmed", "Confirmed"], ["showed", "Showed"], ["no_show", "No Show"], ["cancelled", "Cancelled"]];
const statusTone = (v) => v === "showed" ? C.green : v === "confirmed" ? C.accent : v === "no_show" ? C.red : v === "cancelled" ? C.faint : C.amber;

function AllRowMaster({ l, bk, clientName, onStatus }) {
  const tz = mLeadTz(l.state);
  return (
    <div style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 12, padding: "11px 15px", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
      <span style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0, flexWrap: "wrap" }}>
        <span style={{ fontWeight: 700, fontSize: 13.5 }}>{l.full_name || "—"}</span>
        <span style={{ fontFamily: "monospace", fontSize: 12, color: C.dim }}>{l.phone || "—"}</span>
        <span style={{ fontSize: 11, color: C.violet }}>{l.state}</span>
        <span style={{ fontSize: 11, color: C.faint }}>{new Date(l.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}</span>
      </span>
      <span style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", justifyContent: "flex-end" }}>
        {!bk ? (
          <span style={{ fontSize: 11.5, color: C.dim, border: `1px solid ${C.border}`, borderRadius: 20, padding: "3px 10px" }}>Opt-in</span>
        ) : (
          <>
            <span style={{ fontSize: 11.5, color: C.dim, textAlign: "right" }}>
              📅 {mFmt(bk.slot_start, tz, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })} {mTzShort(bk.slot_start, tz)}
              <span style={{ color: C.green, marginLeft: 6 }}>{clientName}</span>
            </span>
            <select value={bk.status || "unconfirmed"} onChange={(e) => onStatus(bk, e.target.value)}
              style={{ ...sel, padding: "5px 8px", fontSize: 12, fontWeight: 700, color: statusTone(bk.status || "unconfirmed") }}>
              {M_STATUS.map(([v, lab]) => <option key={v} value={v}>{lab}</option>)}
            </select>
          </>
        )}
      </span>
    </div>
  );
}

const O_STAGES = ["Opt-In", "Booked", "Show", "No Show"];
function AllRowOld({ l, setStage }) {
  return (
    <div style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 12, padding: "11px 15px", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
      <span style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0, flexWrap: "wrap" }}>
        <span style={{ fontWeight: 700, fontSize: 13.5 }}>{l.full_name || "—"}</span>
        <span style={{ fontFamily: "monospace", fontSize: 12, color: C.dim }}>{l.phone || "—"}</span>
        <span style={{ fontSize: 11, color: C.violet }}>{l.timezone || "?"}</span>
        {l.client && <span style={{ fontSize: 11, color: C.faint }}>[{l.client}]</span>}
      </span>
      <span style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", justifyContent: "flex-end" }}>
        {l.stage === "Booked" && <span style={{ fontSize: 11.5, color: C.dim }}>📅 {fmtAppt(l)}</span>}
        <select value={l.stage || "Opt-In"} onChange={(e) => setStage(l, e.target.value)}
          style={{ ...sel, padding: "5px 8px", fontSize: 12, fontWeight: 700, color: l.stage === "Show" ? C.green : l.stage === "No Show" ? C.red : l.stage === "Booked" ? C.accent : C.amber }}>
          {O_STAGES.map((v) => <option key={v} value={v}>{v}</option>)}
        </select>
      </span>
    </div>
  );
}

const Empty = ({ children }) => <p style={{ color: C.faint, fontSize: 13.5 }}>{children}</p>;
function SectionBtn({ on, onClick, label, tone }) {
  return (
    <button onClick={onClick} style={{
      padding: "9px 16px", borderRadius: 9, fontSize: 13.5, fontWeight: 600, fontFamily: "inherit", cursor: "pointer",
      background: on ? C.accent : C.panel, color: on ? "#fff" : (tone || C.text),
      border: `1px solid ${on ? C.accent : C.border}`,
    }}>{label}</button>
  );
}
const btn = (tone) => ({
  padding: "7px 12px", borderRadius: 8, fontSize: 12.5, fontWeight: 600, fontFamily: "inherit", cursor: "pointer",
  background: "transparent", color: tone, border: `1px solid ${tone}66`,
});
const sel = { padding: "8px 12px", borderRadius: 9, border: `1px solid ${C.border}`, background: C.panel, color: C.text, fontSize: 13.5, fontFamily: "inherit" };
