export const AUTOMATIC_NO_SHOW_NOTE =
  "Automatically marked no-show after the scheduled appointment day ended.";

export const LEGACY_AUTOMATIC_NO_SHOW_NOTE =
  "Automatically marked no-show after the 24-hour appointment completion window.";

export type AutomaticNoShowLog = {
  oldStatus: string | null;
  newStatus: string;
  notes: string | null;
  changedById: string | null;
};

export function isAutomaticNoShowLog(log: AutomaticNoShowLog | null | undefined) {
  return Boolean(
    log
      && log.oldStatus === "PENDING"
      && log.newStatus === "NO_SHOW"
      && (
        log.notes === AUTOMATIC_NO_SHOW_NOTE
        || log.notes === LEGACY_AUTOMATIC_NO_SHOW_NOTE
      )
      && log.changedById === null,
  );
}
