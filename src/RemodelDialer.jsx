// src/RemodelDialer.jsx
//
// Remodeling Dialer: the B2C "pot" dialer for the kitchen & bath estimate
// funnel (schedule-estimate.netlify.app). Same mechanics as the insurance
// dialer: only leads DUE for a call show in the pots.
//   Opt-Ins        new opt-ins + cadence calls, no-show nurture, rebook calls
//   Confirmations  new bookings + confirmation cadence until the appointment
//   30-Min Prior   appointments starting within 30 minutes
//   All Leads      everyone, searchable, stage editable
// Cadence (client-local): days 1-3 → 9a/1p/5p · days 4-6 → 9a/3p · day 7+ → 12p.
// The cadence is computed by the funnel backend (lib/cadence.js), the SAME code
// the Slack reminders (dialer-cron) use. Ticking a call here stops that Slack
// reminder. Stage changes land on the metrics dashboard + client tracker.
//
// Data: GET/POST {API}/dialer with header x-dialer-key (DIALER_KEY on the
// funnel's Netlify site). The key is asked once per device and remembered.

import { useCallback, useEffect, useMemo, useState } from "react";

const API = (import.meta.env.VITE_REMODEL_API || "https://schedule-estimate.netlify.app/.netlify/functions").replace(/\/$/, "");
const KEY_STORE = "remodel_dialer_key";
const C = {
  bg: "#0f1115", panel: "#171a21", panel2: "#1d212b", border: "#262b36",
  text: "#e7e9ee", dim: "#8b909e", faint: "#5b606e",
  accent: "#5b8def", green: "#3ecf8e", amber: "#e9b949", violet: "#a78bfa", red: "#f0616d",
};
const STAGES = [
  ["opt_in", "Opt-in"], ["booked_unconfirmed", "Booked · unconfirmed"], ["booked_confirmed", "Booked · confirmed"],
  ["reschedule_needed", "Reschedule needed"], ["cancelled", "Cancelled"], ["no_show", "No show"],
  ["show_fup", "Showed"], ["show_close", "Showed · sold"], ["dnd", "Not interested (DND)"], ["fake_lead", "Fake lead"],
];
const STAGE_LABEL = Object.fromEntries(STAGES);
const stageTone = (s) => ["show_fup", "show_close", "booked_confirmed"].includes(s) ? C.green
  : s === "booked_unconfirmed" ? C.accent : ["no_show", "cancelled", "dnd", "fake_lead"].includes(s) ? C.red
  : s === "reschedule_needed" ? C.violet : C.amber;

const readKey = () => { try { return localStorage.getItem(KEY_STORE) || ""; } catch (e) { return ""; } };
const saveKey = (k) => { try { k ? localStorage.setItem(KEY_STORE, k) : localStorage.removeItem(KEY_STORE); } catch (e) { /* private mode */ } };
const fmtPhone = (d) => (d && d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : d || "—");
const telHref = (d) => (d ? `tel:${d.length === 10 ? "+1" + d : "+" + d}` : undefined);
const sastNow = () => new Intl.DateTimeFormat("en-GB", { timeZone: "Africa/Johannesburg", hour: "2-digit", minute: "2-digit" }).format(new Date());
const fmtIn = (iso, tz, o) => new Date(iso).toLocaleString("en-US", { timeZone: tz, ...o });
const tzShort = (iso, tz) => ((new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "short" })
  .formatToParts(new Date(iso)).find((p) => p.type === "timeZoneName")) || {}).value || "";
const apptText = (l) => l.booking && l.booking.start_time
  ? `${fmtIn(l.booking.start_time, l.tz, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })} ${tzShort(l.booking.start_time, l.tz)}`
  : "";

export default function RemodelDialer() {
  const [key, setKey] = useState(readKey);
  const [data, setData] = useState(null);
  const [err, setErr] = useState("");
  const [section, setSection] = useState("optins");
  const [client, setClient] = useState("All");
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (k) => {
    const useKey = k || key;
    if (!useKey) return;
    try {
      const r = await fetch(`${API}/dialer`, { headers: { "x-dialer-key": useKey } });
      if (r.status === 401) { saveKey(""); setKey(""); setErr("That dialer key didn't work. Try again."); return; }
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "Load failed");
      setData(d); setErr("");
    } catch (e) { setErr("Couldn't load leads: " + e.message); }
  }, [key]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { const t = setInterval(() => load(), 60000); return () => clearInterval(t); }, [load]);

  async function act(body) {
    setBusy(true);
    try {
      const r = await fetch(`${API}/dialer`, { method: "POST", headers: { "Content-Type": "application/json", "x-dialer-key": key }, body: JSON.stringify(body) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) setErr(d.error || "Save failed");
    } catch (e) { setErr("Save failed: " + e.message); }
    await load(); setBusy(false);
  }
  const onCall = (l, k, outcome) => act({ action: "call", lead_id: l.id, key: k, outcome });
  const onStage = (l, stage) => act({ action: "stage", lead_id: l.id, stage });
  const onNotes = (l, notes) => act({ action: "notes", lead_id: l.id, notes });

  const leads = useMemo(() => (data ? data.leads : []).filter((l) => client === "All" || l.client_id === client), [data, client]);
  const pot = (name) => leads.filter((l) => l.call && l.call.pot === name)
    .sort((a, b) => (a.call.kind === "fresh" ? 0 : 1) - (b.call.kind === "fresh" ? 0 : 1) || (a.call.due || "").localeCompare(b.call.due || ""));
  const optins = pot("optins"), conf = pot("conf");
  const prior = pot("prior").sort((a, b) => a.call.mins - b.call.mins);
  const all = useMemo(() => {
    const n = q.trim().toLowerCase();
    const rows = [...leads].sort((a, b) => (b.created_at || "").localeCompare(a.created_at || ""));
    return n ? rows.filter((l) => [l.name, l.phone_digits, fmtPhone(l.phone_digits), l.email, l.zip, l.client].some((f) => String(f || "").toLowerCase().includes(n))) : rows;
  }, [leads, q]);

  if (!key) return <KeyGate err={err} onSave={(k) => { saveKey(k); setKey(k); load(k); }} />;

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 14, flexWrap: "wrap" }}>
        <div>
          <h1 style={{ fontSize: 26, fontWeight: 600, margin: 0 }}>Remodeling Dialer</h1>
          <p style={{ color: C.dim, marginTop: 6, marginBottom: 0, fontSize: 13.5 }}>
            Only leads due for a call show here. It's <b>{sastNow()} SAST</b> now. Times on cards are the client's local time.
          </p>
          {data && <p style={{ color: C.faint, marginTop: 4, marginBottom: 0, fontSize: 11.5 }}>Call times in SAST: {data.legend.join(" · ")}</p>}
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <select value={client} onChange={(e) => setClient(e.target.value)} style={sel}>
            <option value="All">All clients</option>
            {(data ? data.clients : []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <button style={btn(C.dim)} onClick={() => load()} title="Refresh">⟳</button>
        </div>
      </div>

      <div style={{ display: "flex", gap: 8, marginTop: 16, flexWrap: "wrap" }}>
        <SectionBtn on={section === "optins"} onClick={() => setSection("optins")} label={`Opt-Ins (${optins.length})`} />
        <SectionBtn on={section === "conf"} onClick={() => setSection("conf")} label={`Confirmations (${conf.length})`} />
        <SectionBtn on={section === "prior"} onClick={() => setSection("prior")} label={`⏰ 30-Min Prior (${prior.length})`} tone={prior.length ? C.red : null} />
        <SectionBtn on={section === "all"} onClick={() => setSection("all")} label={`All Leads (${leads.length})`} />
      </div>

      {err && <p style={{ color: C.red, fontSize: 13, marginTop: 12 }}>{err}</p>}
      {!data ? <p style={{ color: C.dim, marginTop: 20 }}>Loading…</p> : (
        <div style={{ marginTop: 18, display: "flex", flexDirection: "column", gap: 10, maxWidth: 720 }}>
          {section === "optins" && (optins.length
            ? optins.map((l) => <LeadCard key={l.id} l={l} busy={busy} onCall={onCall} onStage={onStage} onNotes={onNotes} />)
            : <Empty>No opt-in calls due right now. 🎉</Empty>)}
          {section === "conf" && (conf.length
            ? conf.map((l) => <LeadCard key={l.id} l={l} busy={busy} onCall={onCall} onStage={onStage} onNotes={onNotes} conf />)
            : <Empty>No confirmation calls due right now. 🎉</Empty>)}
          {section === "prior" && (prior.length
            ? prior.map((l) => <PriorCard key={l.id} l={l} busy={busy} onStage={onStage} />)
            : <Empty>No appointments starting within 30 minutes.</Empty>)}
          {section === "all" && (
            <>
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name / phone / email / ZIP / client…"
                style={{ ...sel, width: "100%", boxSizing: "border-box" }} />
              {all.length === 0 && <Empty>No leads match.</Empty>}
              {all.map((l) => <AllRow key={l.id} l={l} busy={busy} onStage={onStage} />)}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function KeyGate({ err, onSave }) {
  const [v, setV] = useState("");
  return (
    <div style={{ maxWidth: 380, margin: "60px auto", background: C.panel, border: `1px solid ${C.border}`, borderRadius: 14, padding: 22 }}>
      <h2 style={{ margin: 0, fontSize: 19 }}>Remodeling Dialer</h2>
      <p style={{ color: C.dim, fontSize: 13, margin: "8px 0 14px" }}>Enter the dialer key. You only need to do this once on this device.</p>
      <form onSubmit={(e) => { e.preventDefault(); if (v.trim()) onSave(v.trim()); }}>
        <input type="password" value={v} onChange={(e) => setV(e.target.value)} placeholder="Dialer key" autoFocus
          style={{ ...sel, width: "100%", boxSizing: "border-box" }} />
        <button type="submit" style={{ ...btn(C.accent), background: C.accent, color: "#fff", marginTop: 10, width: "100%" }}>Open dialer</button>
      </form>
      {err && <p style={{ color: C.red, fontSize: 12.5, marginTop: 10 }}>{err}</p>}
    </div>
  );
}

function Details({ l, onNotes }) {
  const [notes, setNotes] = useState(l.notes || "");
  useEffect(() => { setNotes(l.notes || ""); }, [l.notes]);
  const nowIso = new Date().toISOString();
  return (
    <>
      <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "5px 14px", fontSize: 12.5, marginTop: 10 }}>
        <span style={{ color: C.dim }}>Client</span><span style={{ color: C.green, fontWeight: 600 }}>{l.client}</span>
        <span style={{ color: C.dim }}>Phone</span><span><a href={telHref(l.phone_digits)} style={{ color: C.text }}>{fmtPhone(l.phone_digits)}</a></span>
        <span style={{ color: C.dim }}>Email</span><span>{l.email || "—"}</span>
        <span style={{ color: C.dim }}>ZIP</span><span>{l.zip || "—"}{l.property_type ? ` · ${l.property_type}` : ""}{l.ownership ? ` · ${l.ownership}` : ""}</span>
        <span style={{ color: C.dim }}>Opted in</span><span>{fmtIn(l.created_at, l.tz, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}{l.ad_name ? <span style={{ color: C.faint }}> · {l.ad_name}</span> : null}</span>
        {l.booking && <><span style={{ color: C.dim }}>Appt</span><span>{apptText(l)}{l.booking.address ? <span style={{ color: C.faint }}> · {l.booking.address}</span> : null}</span></>}
        <span style={{ color: C.dim }}>Stage</span><span style={{ color: stageTone(l.stage) }}>{STAGE_LABEL[l.stage] || l.stage}</span>
        <span style={{ color: C.dim }}>Local time</span><span>{fmtIn(nowIso, l.tz, { hour: "numeric", minute: "2-digit" })} {tzShort(nowIso, l.tz)}</span>
        {l.ghl_link && <><span style={{ color: C.dim }}>GHL</span><span><a href={l.ghl_link} target="_blank" rel="noreferrer" style={{ color: C.accent, fontWeight: 700 }}>Open contact ↗</a></span></>}
      </div>
      <textarea value={notes} onChange={(e) => setNotes(e.target.value)} onBlur={() => { if (notes !== (l.notes || "")) onNotes(l, notes); }}
        placeholder="Setter notes (saved when you click away)" rows={2}
        style={{ ...sel, width: "100%", boxSizing: "border-box", marginTop: 10, fontSize: 12.5, resize: "vertical" }} />
    </>
  );
}

function LeadCard({ l, busy, onCall, onStage, onNotes, conf }) {
  const c = l.call, tone = c.kind === "fresh" ? C.green : C.amber;
  const booked = !!l.booking && ["booked_unconfirmed", "booked_confirmed"].includes(l.stage);
  return (
    <details style={{ background: C.panel, border: `1px solid ${(conf ? C.amber : C.accent)}44`, borderRadius: 12 }}>
      <summary style={{ listStyle: "none", cursor: "pointer", padding: "12px 15px", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <span style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0, flexWrap: "wrap" }}>
          <span style={{ fontWeight: 700, fontSize: 14 }}>{l.name}</span>
          <span style={{ fontFamily: "monospace", fontSize: 12, color: C.dim }}>{fmtPhone(l.phone_digits)}</span>
          <span style={{ fontSize: 11, color: C.violet }}>{l.client}</span>
        </span>
        <span style={{ textAlign: "right" }}>
          <span style={{ fontSize: 12, fontWeight: 700, color: tone }}>{c.stage}</span>
          {c.sast && <span style={{ fontSize: 11, color: C.faint, marginLeft: 8 }}>= {c.sast} SAST</span>}
        </span>
      </summary>
      <div style={{ padding: "0 15px 13px", borderTop: `1px solid ${C.border}` }}>
        <Details l={l} onNotes={onNotes} />
        <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
          <button disabled={busy} style={btn(C.green)} onClick={() => onCall(l, c.key, "picked_up")}>✓ Called — picked up</button>
          <button disabled={busy} style={btn(C.faint)} onClick={() => onCall(l, c.key, "no_pickup")}>☎ Called — no answer</button>
          {!booked && <a href={l.book_link} target="_blank" rel="noreferrer" style={{ ...btn(C.accent), textDecoration: "none" }}>📅 Book appointment ↗</a>}
          {conf && <>
            <button disabled={busy} style={btn(C.green)} onClick={() => onStage(l, "booked_confirmed")}>Confirmed</button>
            <button disabled={busy} style={btn(C.violet)} onClick={() => onStage(l, "reschedule_needed")}>Needs reschedule</button>
            <button disabled={busy} style={btn(C.red)} onClick={() => onStage(l, "cancelled")}>Cancelled</button>
          </>}
          {!conf && <button disabled={busy} style={btn(C.red)} onClick={() => onStage(l, "dnd")}>Not interested</button>}
        </div>
      </div>
    </details>
  );
}

function PriorCard({ l, busy, onStage }) {
  const m = l.call.mins;
  return (
    <div style={{ background: C.panel, border: `1px solid ${C.red}66`, borderRadius: 12, padding: 14 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
        <div>
          <span style={{ fontWeight: 700, fontSize: 14.5 }}>{l.name}</span>
          <div style={{ fontFamily: "monospace", fontSize: 12, color: C.dim, marginTop: 2 }}>
            <a href={telHref(l.phone_digits)} style={{ color: C.dim }}>{fmtPhone(l.phone_digits)}</a>  ·  [{l.client}]
          </div>
          {l.booking && l.booking.address && <div style={{ fontSize: 11.5, color: C.faint, marginTop: 2 }}>{l.booking.address}</div>}
        </div>
        <div style={{ textAlign: "right" }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: m <= 0 ? C.red : C.amber }}>{m <= 0 ? "starting now" : `in ${m} min`}</div>
          <div style={{ fontSize: 11.5, color: C.dim }}>{apptText(l)}</div>
        </div>
      </div>
      <div style={{ display: "flex", gap: 8, marginTop: 10, alignItems: "center", flexWrap: "wrap" }}>
        <button disabled={busy} style={btn(C.accent)} onClick={() => onStage(l, "show_fup")}>Show</button>
        <button disabled={busy} style={btn(C.red)} onClick={() => onStage(l, "no_show")}>No Show</button>
        {l.ghl_link && <a href={l.ghl_link} target="_blank" rel="noreferrer" style={{ color: C.accent, fontSize: 12, fontWeight: 700, marginLeft: 4 }}>Open in GHL ↗</a>}
      </div>
    </div>
  );
}

function AllRow({ l, busy, onStage }) {
  const booked = !!l.booking && ["booked_unconfirmed", "booked_confirmed"].includes(l.stage);
  return (
    <div style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 12, padding: "11px 15px", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
      <span style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0, flexWrap: "wrap" }}>
        <span style={{ fontWeight: 700, fontSize: 13.5 }}>{l.name}</span>
        <a href={telHref(l.phone_digits)} style={{ fontFamily: "monospace", fontSize: 12, color: C.dim }}>{fmtPhone(l.phone_digits)}</a>
        <span style={{ fontSize: 11, color: C.violet }}>{l.client}</span>
        <span style={{ fontSize: 11, color: C.faint }}>{fmtIn(l.created_at, l.tz, { month: "short", day: "numeric" })}</span>
      </span>
      <span style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", justifyContent: "flex-end" }}>
        {l.booking && l.booking.start_time && <span style={{ fontSize: 11.5, color: C.dim }}>📅 {apptText(l)}</span>}
        {!booked && !["show_fup", "show_close"].includes(l.stage) &&
          <a href={l.book_link} target="_blank" rel="noreferrer" style={{ color: C.accent, fontSize: 12, fontWeight: 700 }}>Book ↗</a>}
        <select value={l.stage} disabled={busy} onChange={(e) => onStage(l, e.target.value)}
          style={{ ...sel, padding: "5px 8px", fontSize: 12, fontWeight: 700, color: stageTone(l.stage) }}>
          {STAGES.map(([v, lab]) => <option key={v} value={v}>{lab}</option>)}
          {!STAGE_LABEL[l.stage] && <option value={l.stage}>{l.stage}</option>}
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
  background: "transparent", color: tone, border: `1px solid ${tone}66`, display: "inline-block",
});
const sel = { padding: "8px 12px", borderRadius: 9, border: `1px solid ${C.border}`, background: C.panel, color: C.text, fontSize: 13.5, fontFamily: "inherit" };
