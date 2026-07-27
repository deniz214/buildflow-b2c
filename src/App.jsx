// src/App.jsx — standalone B2C Dialer app: the dialer IS the app.
import B2CDialer from "./B2CDialer";

export default function App() {
  return (
    <div style={{ minHeight: "100vh", background: "#0f1115", color: "#e7e9ee", padding: "26px 22px" }}>
      <div style={{ maxWidth: 1100, margin: "0 auto" }}>
        <B2CDialer />
      </div>
    </div>
  );
}
