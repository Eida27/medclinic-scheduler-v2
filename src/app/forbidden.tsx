import Link from "next/link";

export default function Forbidden() {
  return (
    <main className="grid min-h-screen place-items-center bg-canvas p-6">
      <section className="max-w-lg rounded-2xl border border-line bg-surface p-8 text-center shadow-sm">
        <p className="text-sm font-semibold uppercase tracking-[0.18em] text-muted">403</p>
        <h1 className="mt-2 text-2xl font-bold text-ink">Access denied</h1>
        <p className="mt-3 text-sm text-muted">You do not have permission to view this page.</p>
        <Link className="mt-6 inline-flex min-h-11 items-center rounded-xl border border-line px-4 text-sm font-semibold text-ink" href="/">
          Return home
        </Link>
      </section>
    </main>
  );
}
