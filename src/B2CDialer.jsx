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

const AREA_TZ = {"201":"ET","202":"ET","203":"ET","204":"CT","205":"CT","206":"PT","207":"ET","208":"MT","209":"PT","210":"CT","212":"ET","213":"PT","214":"CT","215":"ET","216":"ET","217":"CT","218":"CT","219":"ET","220":"ET","223":"ET","224":"CT","225":"CT","226":"ET","227":"ET","228":"CT","229":"ET","231":"ET","234":"ET","235":"CT","236":"PT","239":"ET","240":"ET","248":"ET","249":"ET","250":"PT","251":"CT","252":"ET","253":"PT","254":"CT","256":"CT","257":"PT","260":"ET","262":"CT","263":"ET","267":"ET","269":"ET","270":"ET","272":"ET","276":"ET","279":"PT","281":"CT","283":"ET","289":"ET","301":"ET","302":"ET","303":"MT","304":"ET","305":"ET","307":"MT","308":"CT","309":"CT","310":"PT","312":"CT","313":"ET","314":"CT","315":"ET","316":"CT","317":"ET","318":"CT","319":"CT","320":"CT","321":"ET","323":"PT","324":"ET","325":"CT","326":"ET","327":"CT","329":"ET","330":"ET","331":"CT","332":"ET","334":"CT","336":"ET","337":"CT","339":"ET","341":"PT","343":"ET","346":"CT","347":"ET","350":"PT","351":"ET","352":"ET","353":"CT","354":"ET","360":"PT","361":"CT","363":"ET","364":"ET","365":"ET","367":"ET","368":"MT","369":"PT","380":"ET","382":"ET","385":"MT","386":"ET","401":"ET","402":"CT","403":"MT","404":"ET","405":"CT","406":"MT","407":"ET","408":"PT","409":"CT","410":"ET","412":"ET","413":"ET","414":"CT","415":"PT","416":"ET","417":"CT","418":"ET","419":"ET","423":"CT","424":"PT","425":"PT","430":"CT","431":"CT","432":"CT","434":"ET","435":"MT","437":"ET","438":"ET","440":"ET","442":"PT","443":"ET","445":"ET","447":"CT","448":"ET","450":"ET","458":"PT","463":"ET","464":"CT","468":"ET","469":"CT","470":"ET","474":"CT","475":"ET","478":"ET","479":"CT","480":"MT","484":"ET","500":"AKT","501":"CT","502":"ET","503":"PT","504":"CT","505":"MT","507":"CT","508":"ET","509":"PT","510":"PT","512":"CT","513":"ET","514":"ET","515":"CT","516":"ET","517":"ET","518":"ET","519":"ET","520":"MT","521":"AKT","522":"AKT","525":"AKT","526":"AKT","527":"AKT","528":"AKT","529":"AKT","530":"PT","531":"CT","532":"AKT","533":"AKT","534":"CT","539":"CT","540":"ET","541":"PT","544":"AKT","548":"ET","551":"ET","557":"CT","559":"PT","561":"ET","562":"PT","563":"CT","564":"PT","566":"AKT","567":"ET","570":"ET","571":"ET","572":"CT","573":"CT","574":"ET","575":"MT","577":"AKT","579":"ET","580":"CT","581":"ET","582":"ET","584":"CT","585":"ET","586":"ET","587":"MT","588":"AKT","600":"AKT","601":"CT","602":"MT","603":"ET","604":"PT","605":"MT","606":"ET","607":"ET","608":"CT","609":"ET","610":"ET","612":"CT","613":"ET","614":"ET","615":"CT","616":"ET","617":"ET","618":"CT","619":"PT","620":"CT","622":"AKT","623":"MT","626":"PT","628":"PT","629":"CT","630":"CT","631":"ET","633":"AKT","636":"CT","640":"ET","641":"CT","645":"ET","646":"ET","647":"ET","650":"PT","651":"CT","656":"ET","657":"PT","659":"CT","660":"CT","661":"PT","662":"CT","667":"ET","669":"PT","672":"PT","678":"ET","680":"ET","681":"ET","682":"CT","683":"ET","686":"ET","689":"CT","701":"MT","702":"PT","703":"ET","704":"ET","705":"ET","706":"ET","707":"PT","708":"CT","712":"CT","713":"CT","714":"PT","715":"CT","716":"ET","717":"ET","718":"ET","719":"MT","720":"MT","724":"ET","725":"PT","726":"CT","727":"ET","728":"ET","730":"CT","731":"CT","732":"ET","734":"ET","737":"CT","738":"PT","740":"ET","742":"ET","743":"ET","747":"PT","748":"MT","753":"ET","754":"ET","757":"ET","760":"PT","762":"ET","763":"CT","765":"ET","769":"CT","770":"ET","771":"ET","772":"ET","773":"CT","774":"ET","775":"MT","778":"PT","779":"CT","780":"MT","781":"ET","785":"CT","786":"ET","800":"AKT","801":"MT","802":"ET","803":"ET","804":"ET","805":"PT","806":"CT","807":"ET","808":"HAT","810":"ET","812":"ET","813":"ET","814":"ET","815":"CT","816":"CT","817":"CT","818":"PT","819":"ET","820":"PT","821":"ET","825":"MT","826":"ET","828":"ET","830":"CT","831":"PT","832":"CT","833":"AKT","835":"ET","838":"ET","839":"ET","840":"PT","843":"ET","844":"AKT","845":"ET","847":"CT","848":"ET","850":"ET","854":"ET","855":"AKT","856":"ET","857":"ET","858":"PT","859":"ET","860":"ET","862":"ET","863":"ET","864":"ET","865":"ET","866":"AKT","870":"CT","872":"CT","873":"ET","876":"AKT","877":"AKT","878":"ET","888":"AKT","900":"AKT","901":"CT","903":"CT","904":"ET","905":"ET","906":"ET","907":"AKT","908":"ET","909":"PT","910":"ET","912":"ET","913":"CT","914":"ET","915":"MT","916":"PT","917":"ET","918":"CT","919":"ET","920":"CT","925":"PT","928":"MT","929":"ET","930":"ET","931":"CT","934":"ET","936":"CT","937":"ET","938":"CT","940":"CT","941":"ET","942":"ET","943":"ET","945":"CT","947":"ET","948":"ET","949":"PT","951":"PT","952":"CT","954":"ET","956":"CT","959":"ET","970":"MT","971":"PT","972":"CT","973":"ET","975":"CT","978":"ET","979":"CT","980":"ET","984":"ET","985":"CT","986":"MT","989":"ET"};
function tzFromPhone(phone) {
  if (!phone) return "";
  let t = String(phone).trim().replace(/^\+1/, "").replace(/^\+/, "");
  const d = t.replace(/\D/g, "");
  const core = d.length === 11 && d[0] === "1" ? d.slice(1) : d;
  const ac = core.slice(0, 3);
  return ac && AREA_TZ[ac] ? AREA_TZ[ac] : "";
}

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
// Slots that were already in the past when the last call was logged are
// skipped, so ticking "no answer" moves the lead to the NEXT calling time
// rather than instantly resurfacing an earlier slot.
function dueSlot(lead, baseIso, prefix) {
  const iana = TZ_IANA[lead.timezone];
  if (!iana || !baseIso) return null;
  const nowP = nowPartsIn(iana);
  const base = datePartsIn(baseIso, iana);
  const idx = dayDiff(base, nowP);
  if (idx < 0) return null;
  const calls = lead.setter_calls || {};
  const lastCall = Date.parse(calls[`${prefix}|last`] || "") || 0;
  const nowMin = nowP.hh * 60 + nowP.mm;
  let current = null;
  for (const [hh, label] of timesForDay(idx)) {
    const key = `${prefix}|${dayKey(nowP)}|${pad(hh)}00`;
    if (hh * 60 > nowMin || calls[key]) continue;
    const dueUTC = zonedWallToUTC(nowP.y, nowP.m, nowP.d, hh, 0, iana);
    if (dueUTC.getTime() <= lastCall) continue; // already covered by that call
    current = { key, label, stage: `Day ${idx + 1} · ${label} call`, sast: sastTime(dueUTC) };
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
  const [err, setErr] = useState(null);
  const [showAdd, setShowAdd] = useState(false);
  const [draft, setDraft] = useState({ client: "", full_name: "", phone: "", email: "", stage: "Opt-In", appt_at: "" });

  async function load() {
    setLoading(true);
    const { data, error } = await supabase.from("b2c_leads").select("*").in("stage", ["Opt-In", "Booked", "No Show"]);
    setErr(error ? (error.message || String(error)) : null);
    setLeads(data || []);
    setLoading(false);
  }
  useEffect(() => { load(); }, []);
  useEffect(() => { const t = setInterval(() => setTick((x) => x + 1), 60000); return () => clearInterval(t); }, []);

  const clients = useMemo(() => ["All", ...Array.from(new Set(leads.map((l) => l.client).filter(Boolean))).sort()], [leads]);
  const visible = client === "All" ? leads : leads.filter((l) => l.client === client);

  async function record(lead, slotKey, outcome) {
    const prefix = String(slotKey).split("|")[0];
    const calls = { ...(lead.setter_calls || {}), [slotKey]: outcome, [`${prefix}|last`]: new Date().toISOString() };
    await supabase.from("b2c_leads").update({ setter_calls: calls }).eq("id", lead.id);
    load();
  }
  async function setStage(lead, stage) {
    await supabase.from("b2c_leads").update({ stage }).eq("id", lead.id);
    load();
  }

  async function addLead() {
    if (!draft.phone && !draft.email) { window.alert("Need at least a phone or an email."); return; }
    const row = {
      client: draft.client || null, full_name: draft.full_name || null,
      phone: draft.phone || null, email: draft.email || null,
      timezone: tzFromPhone(draft.phone) || null,
      stage: draft.stage, opt_in_at: new Date().toISOString(),
    };
    if (draft.stage === "Booked") { row.booked_at = new Date().toISOString(); row.appt_at = draft.appt_at || null; }
    const { error } = await supabase.from("b2c_leads").insert(row);
    if (error) { window.alert("Could not add lead: " + error.message); return; }
    setDraft({ client: "", full_name: "", phone: "", email: "", stage: "Opt-In", appt_at: "" });
    setShowAdd(false); load();
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
            Only leads due for a call show here. It's <b>{sastTime(new Date())} SAST</b> now. · {leads.length} leads loaded
          </p>
          <p style={{ color: C.faint, marginTop: 4, marginBottom: 0, fontSize: 11.5 }}>
            Appropriate times to call, in SAST: {legend.join(" · ")}
          </p>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <select value={client} onChange={(e) => setClient(e.target.value)} style={sel}>
            {clients.map((c) => <option key={c} value={c}>{c === "All" ? "All clients" : c}</option>)}
          </select>
          <button onClick={() => setShowAdd((v) => !v)} style={{ ...sel, cursor: "pointer", background: showAdd ? C.accent : C.panel, color: showAdd ? "#fff" : C.text }}>+ Add lead</button>
        </div>
      </div>

      {err && (
        <div style={{ marginTop: 14, padding: "11px 15px", borderRadius: 10, background: "#3a1d22", border: `1px solid ${C.red}`, color: C.red, fontSize: 13 }}>
          ⚠ Can't read leads from the database: {err} — run 30_b2c_access.sql in Supabase.
        </div>
      )}

      {showAdd && (
        <div style={{ marginTop: 14, background: C.panel, border: `1px solid ${C.border}`, borderRadius: 12, padding: 15, maxWidth: 680 }}>
          <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 10 }}>Add a lead manually</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <input placeholder="Client" value={draft.client} onChange={(e) => setDraft({ ...draft, client: e.target.value })} style={inp} />
            <input placeholder="Full name" value={draft.full_name} onChange={(e) => setDraft({ ...draft, full_name: e.target.value })} style={inp} />
            <input placeholder="Phone (US)" value={draft.phone} onChange={(e) => setDraft({ ...draft, phone: e.target.value })} style={inp} />
            <input placeholder="Email" value={draft.email} onChange={(e) => setDraft({ ...draft, email: e.target.value })} style={inp} />
            <select value={draft.stage} onChange={(e) => setDraft({ ...draft, stage: e.target.value })} style={inp}>
              {["Opt-In", "Booked", "No Show"].map((st) => <option key={st} value={st}>{st}</option>)}
            </select>
            {draft.stage === "Booked" && (
              <input type="datetime-local" value={draft.appt_at} onChange={(e) => setDraft({ ...draft, appt_at: e.target.value })} style={{ ...inp, colorScheme: "dark" }} title="Appointment time (lead's local time)" />
            )}
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
            <button onClick={addLead} style={{ ...sel, cursor: "pointer", background: C.green, color: "#0f1115", fontWeight: 700, border: "none" }}>Save lead</button>
            <button onClick={() => setShowAdd(false)} style={{ ...sel, cursor: "pointer" }}>Cancel</button>
          </div>
          <div style={{ fontSize: 11, color: C.faint, marginTop: 8 }}>
            Timezone comes from the phone's area code. Reminders start automatically: Opt-In leads show as "call now" and follow the daily cadence; Booked leads enter confirmations + 30-min prior.
          </div>
        </div>
      )}

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
const inp = { padding: "9px 11px", borderRadius: 9, border: `1px solid ${C.border}`, background: C.bg, color: C.text, fontSize: 13, fontFamily: "inherit", boxSizing: "border-box", width: "100%" };
const sel = { padding: "8px 12px", borderRadius: 9, border: `1px solid ${C.border}`, background: C.panel, color: C.text, fontSize: 13.5, fontFamily: "inherit" };
