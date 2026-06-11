import { Card, CardTitle } from "@/components/ui/Card";
import { PageHeader } from "@/components/ui/PageHeader";

const cards = [
  ["Students", "180", "Active records in the demo dataset"],
  ["Draft batches", "4", "Ready for validation"],
  ["Recommended capacity", "120", "Students per service each day"],
  ["Maximum capacity", "150", "Admin override required above this"],
];

export default function DashboardPage() {
  return (
    <>
      <PageHeader title="Clinic dashboard" description="A concise view of scheduling and compliance operations." />
      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {cards.map(([label, value, description]) => (
          <Card key={label}>
            <p className="text-sm font-semibold text-slate-500">{label}</p>
            <p className="mt-2 text-3xl font-black text-slate-950">{value}</p>
            <p className="mt-2 text-xs text-slate-500">{description}</p>
          </Card>
        ))}
      </section>
      <Card>
        <CardTitle>Core workflow</CardTitle>
        <ol className="mt-4 grid gap-3 text-sm text-slate-700 sm:grid-cols-3">
          {[
            "Encode a coordinator schedule batch",
            "Validate dates, students, and capacity",
            "Generate draft appointments",
            "Review conflicts and assignments",
            "Publish as an administrator",
            "Track results and compliance",
          ].map((step, index) => (
            <li key={step} className="rounded-xl bg-slate-50 p-4"><span className="mr-2 font-black text-teal-700">{index + 1}.</span>{step}</li>
          ))}
        </ol>
      </Card>
    </>
  );
}
