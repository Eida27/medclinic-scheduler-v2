import type { CalendarOccupancyDay } from "@/server/services/calendar-occupancy.service";

export function CalendarDayDetails({ day, closedLabel }: {
  day: CalendarOccupancyDay;
  closedLabel?: string;
}) {
  const services = [
    ["Laboratory", day.laboratory],
    ["Physical Examination", day.physicalExam],
  ] as const;
  return <div role="dialog" aria-label={`Calendar details for ${day.date}`}
    className="absolute left-0 top-full z-30 mt-1 w-72 rounded-xl border border-line bg-white p-4 text-left text-xs text-ink shadow-xl">
    <h4 className="text-sm font-bold">{day.date}</h4>
    {closedLabel ? <p className="mt-1 font-semibold text-amber-900">{closedLabel}</p> : null}
    {day.reservations.length ? <p className="mt-1 font-semibold text-amber-900">
      Reserved: {day.reservations.map((item) => `${item.service.replaceAll("_", " ")} (${item.kind})`).join(", ")}
    </p> : null}
    <p className="mt-2">{day.uniqueStudents} unique students · {day.appointmentTotal} appointments</p>
    <dl className="mt-2 grid gap-1">
      {services.map(([label, capacity]) => <div key={label} className="flex justify-between gap-2">
        <dt>{label}</dt><dd className="font-semibold">{capacity.maximum === null
          ? "Capacity not configured"
          : `${capacity.used}/${capacity.maximum} used · ${capacity.remaining} remaining${capacity.used > capacity.maximum ? " · Over capacity" : capacity.used === capacity.maximum ? " · Full" : ""}`}</dd>
      </div>)}
    </dl>
    {day.externalLaboratory ? <p className="mt-2">External Laboratory — Iloilo Mission Hospital: {day.externalLaboratory}</p> : null}
    {day.heldCapacity ? <p className="mt-1">Unpublished capacity holds: {day.heldCapacity}</p> : null}
    {day.hiddenCapacityHold > day.heldCapacity ? <p className="mt-1">Other hidden capacity holds: {day.hiddenCapacityHold - day.heldCapacity}</p> : null}
    {day.groups.length ? <div className="mt-2 border-t border-line pt-2">
      <p className="font-bold">Published by college and service</p>
      <ul className="mt-1 space-y-1">{day.groups.map((group) => <li key={`${group.college}-${group.service}-${group.location}`}>
        {group.college}: {group.service.replaceAll("_", " ")}{group.location === "EXTERNAL" ? " external" : ""} · {group.appointments}
      </li>)}</ul>
    </div> : null}
  </div>;
}
