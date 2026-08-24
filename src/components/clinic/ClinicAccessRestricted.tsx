type ClinicAccessRestrictedProps = {
  title: string;
  message: string;
};

export function ClinicAccessRestricted({ title, message }: ClinicAccessRestrictedProps) {
  return (
    <section className="grid min-h-[50vh] place-items-center rounded-2xl border border-line bg-surface p-6 text-center shadow-panel sm:p-10">
      <div className="grid max-w-xl justify-items-center gap-4">
        <svg
          aria-hidden="true"
          data-testid="clinic-access-lock"
          viewBox="0 0 24 24"
          className="size-16 text-cpu-navy sm:size-20"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.75"
        >
          <rect x="4" y="10" width="16" height="10" rx="2" />
          <path d="M8 10V7a4 4 0 0 1 8 0v3" />
          <path d="M12 14v2" />
        </svg>
        <h1 className="text-2xl font-bold tracking-tight text-ink sm:text-3xl">{title}</h1>
        <p className="text-sm leading-6 text-muted-strong sm:text-base">{message}</p>
      </div>
    </section>
  );
}
