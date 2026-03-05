import dynamic from "next/dynamic";

const MonitoringDashboard = dynamic(
  () => import("../components/MonitoringDashboard"),
  {
    loading: () => (
      <main className="page settings-page">
        <section className="card" style={{ marginTop: 24 }}>
          <p className="text-body">Monitoring laden...</p>
        </section>
      </main>
    ),
  }
);

export default function StatusPage() {
  return <MonitoringDashboard />;
}
