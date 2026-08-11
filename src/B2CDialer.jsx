// src/B2CDialer.jsx
//
// B2C Dialer — "the pot": only leads that are DUE for a call right now.
// Sections: Opt-Ins · Confirmations (booked appts) · 30-Min Prior.
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
  const [loading, setLoading] = useState(true);
  const [section, setSection] = useState("optins");
  const [client, setClient] = useState("All");
  const [, setTick] = useState(0);

  async function load() {
    setLoading(true);
    const { data } = await supabase.from("b2c_leads").select("*").in("stage", ["Opt-In", "Booked", "No Show"]);
    setLeads(data || []);
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

  // build the pots — only leads DUE right now
  const optPot = [];
  for (const l of visible) {
    if (l.stage === "Opt-In" && !reached(l, "b2copt")) {
      // Brand-new opt-in: show a "call now" card immediately on arrival,
      // regardless of the clock, until it's been called once.
      const calls = l.setter_calls || {};
      if (!calls["b2copt|arrival"]) {
        optPot.push({ l, s: { key: "b2copt|arrival", label: "arrival", stage: "NEW OPT-IN · call now", sast: sastTime(new Date()), fresh: true } });
      } else {
        const s = dueSlot(l, l.opt_in_at, "b2copt");
        if (s) optPot.push({ l, s });
        else if (!TZ_ORDER.includes(l.timezone)) {
          // No usable timezone -> can't schedule slots. Keep it visible rather
          // than silently dropping it, so it never gets lost.
          optPot.push({ l, s: { key: `b2copt|notz|${dayKey(nowPartsIn(SAST))}`, label: "no timezone", stage: "⚠ No timezone — call when you can", sast: sastTime(new Date()), fresh: true } });
        }
      }
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
    const calls = l.setter_calls || {};
    if (!calls["b2cconf|arrival"]) {
      confPot.push({ l, s: { key: "b2cconf|arrival", label: "arrival", stage: "NEW BOOKING · confirm now", sast: sastTime(new Date()), fresh: true } });
      continue;
    }
    const s = dueSlot(l, l.booked_at || l.opt_in_at, "b2cconf");
    if (s) confPot.push({ l, s });
  }
  const priorPot = visible.filter((l) => l.stage === "Booked").map((l) => ({ l, m: minsToAppt(l) }))
    .filter(({ m }) => m != null && m <= 30 && m > -15);

  const tzSort = (a, b) => TZ_ORDER.indexOf(a.l.timezone) - TZ_ORDER.indexOf(b.l.timezone);
  optPot.sort(tzSort); confPot.sort(tzSort);

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
        <SectionBtn on={section === "optins"} onClick={() => setSection("optins")} label={`Opt-Ins (${optPot.length})`} />
        <SectionBtn on={section === "conf"} onClick={() => setSection("conf")} label={`Confirmations (${confPot.length})`} />
        <SectionBtn on={section === "prior"} onClick={() => setSection("prior")} label={`⏰ 30-Min Prior (${priorPot.length})`} tone={priorPot.length ? C.red : null} />
      </div>

      {loading ? <p style={{ color: C.dim, marginTop: 20 }}>Loading…</p> : (
        <div style={{ marginTop: 18, display: "flex", flexDirection: "column", gap: 10, maxWidth: 680 }}>
          {section === "optins" && (optPot.length
            ? optPot.map(({ l, s }) => <PotCard key={l.id} l={l} s={s} record={record} />)
            : <Empty>No opt-in calls due right now. 🎉</Empty>)}
          {section === "conf" && (confPot.length
            ? confPot.map(({ l, s }) => <PotCard key={l.id} l={l} s={s} record={record} conf setStage={setStage} />)
            : <Empty>No confirmation calls due right now. 🎉</Empty>)}
          {section === "prior" && (priorPot.length
            ? priorPot.map(({ l, m }) => <PriorCard key={l.id} l={l} m={m} setStage={setStage} />)
            : <Empty>No appointments starting within 30 minutes.</Empty>)}
        </div>
      )}
    </div>
  );
}

function PotCard({ l, s, record, conf, setStage }) {
  const ghl = ghlLink(l);
  return (
    <details style={{ background: C.panel, border: `1px solid ${s.fresh ? C.green + "88" : C.amber + "44"}`, borderRadius: 12 }}>
      <summary style={{ listStyle: "none", cursor: "pointer", padding: "12px 15px", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <span style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
          <span style={{ fontWeight: 700, fontSize: 14 }}>{l.full_name || "—"}</span>
          <span style={{ fontFamily: "monospace", fontSize: 12, color: C.dim }}>{l.phone || "—"}</span>
          <span style={{ fontSize: 11, color: C.violet }}>{l.timezone || "?"}</span>
        </span>
        <span style={{ textAlign: "right" }}>
          <span style={{ fontSize: 12, fontWeight: 700, color: s.fresh ? C.green : C.amber }}>{s.stage}</span>
          <span style={{ fontSize: 11, color: C.faint, marginLeft: 8 }}>{s.fresh ? "just now" : `= ${s.sast} SAST`}</span>
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
