// src/App.jsx — standalone dialer app: Remodeling (estimate funnel) + Insurance (IUL) dialers.
import { useState } from "react";
import B2CDialer from "./B2CDialer";
import RemodelDialer from "./RemodelDialer";

const VIEW_STORE = "dialer_view";
const readView = () => { try { return localStorage.getItem(VIEW_STORE) || "remodel"; } catch (e) { return "remodel"; } };

export default function App() {
  const [view, setView] = useState(readView);
  const pick = (v) => { setView(v); try { localStorage.setItem(VIEW_STORE, v); } catch (e) { /* private mode */ } };
  const tab = (v, label) => (
    <button onClick={() => pick(v)} style={{
      padding: "7px 14px", borderRadius: 20, fontSize: 12.5, fontWeight: 600, fontFamily: "inherit", cursor: "pointer",
      background: view === v ? "#e7e9ee" : "transparent", color: view === v ? "#0f1115" : "#8b909e",
      border: `1px solid ${view === v ? "#e7e9ee" : "#262b36"}`,
    }}>{label}</button>
  );
  return (
    <div style={{ minHeight: "100vh", background: "#0f1115", color: "#e7e9ee", padding: "26px 22px" }}>
      <div style={{ maxWidth: 1100, margin: "0 auto" }}>
        <div style={{ display: "flex", gap: 8, marginBottom: 18 }}>
          {tab("remodel", "Remodeling")}
          {tab("iul", "Insurance (IUL)")}
        </div>
        {view === "remodel" ? <RemodelDialer /> : <B2CDialer />}
      </div>
    </div>
  );
}
