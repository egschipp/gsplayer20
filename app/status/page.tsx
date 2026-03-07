import dynamic from "next/dynamic";

const MonitoringDashboard = dynamic(
  () => import("../components/MonitoringDashboard"),
  {
    loading: () => (
      <main className="page settings-page">
        <section
          className="card"
          style={{ marginTop: "calc(var(--app-content-offset-top, 0px) + 24px)" }}
        >
          <p className="text-body">Monitoring laden...</p>
        </section>
      </main>
    ),
  }
);

export default function StatusPage() {
  return <MonitoringDashboard />;
}
