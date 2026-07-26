import type { ClinicCalendarBatchChange } from "@/types/clinic-calendar";

type CalendarDraftSummaryProps = {
  clinics: Array<{ id: string; name: string }>;
  changes: ClinicCalendarBatchChange[];
};

export function CalendarDraftSummary({ clinics, changes }: CalendarDraftSummaryProps) {
  const grouped = clinics.flatMap((clinic) => {
    const clinicChanges = changes.filter((change) => change.clinicId === clinic.id);
    if (clinicChanges.length === 0) return [];
    return [{
      clinic,
      blocks: clinicChanges.filter((change) => change.action === "BLOCK"),
      unblocks: clinicChanges.filter((change) => change.action === "UNBLOCK"),
    }];
  });

  return (
    <section aria-label="Draft changes" className="grid gap-3">
      {grouped.map(({ clinic, blocks, unblocks }) => (
        <div key={clinic.id} className="rounded-xl border border-line bg-canvas/50 p-3 text-sm">
          <h3 className="font-bold text-ink">{clinic.name}</h3>
          {blocks.length ? <p>Block {blocks.length} {blocks.length === 1 ? "date" : "dates"}</p> : null}
          {unblocks.length ? <p>Reopen {unblocks.length} {unblocks.length === 1 ? "date" : "dates"}</p> : null}
        </div>
      ))}
    </section>
  );
}
