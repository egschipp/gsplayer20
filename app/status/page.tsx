import dynamic from "next/dynamic";

const MonitoringDashboard = dynamic(() => import("../components/MonitoringDashboard"), {
  loading: () => (
    <main id="main-content" tabIndex={-1} className="page settings-page">
      <section className="card" style={{ marginTop: "4px" }}>
        <p className="text-body">Loading monitoring...</p>
      </section>
    </main>
  ),
});

export default function StatusPage() {
  return <MonitoringDashboard />;
}
