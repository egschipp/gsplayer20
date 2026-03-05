import dynamic from "next/dynamic";

const QueuePageClient = dynamic(() => import("@/components/queue/QueuePageClient"), {
  loading: () => (
    <section className="card" style={{ marginTop: 24 }}>
      <p className="text-body">Queue laden...</p>
    </section>
  ),
});

export default function QueuePage() {
  return (
    <main className="page page-queue">
      <QueuePageClient />
    </main>
  );
}
