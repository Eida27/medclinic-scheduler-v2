const WORKSPACE_PREFIX = "/student/results/";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseStudentVerificationReturn(value: unknown): string | null {
  if (value === "/student" || value === "/student/results") return value;
  if (typeof value !== "string" || !value.startsWith(WORKSPACE_PREFIX)) return null;
  const appointmentId = value.slice(WORKSPACE_PREFIX.length);
  return appointmentId.length === 36 && UUID.test(appointmentId) ? value : null;
}

export function studentVerificationReturn(value: unknown): string {
  return parseStudentVerificationReturn(value) ?? "/student";
}

export function studentVerificationHref(value: unknown): string {
  return `/student/email-verification?returnTo=${encodeURIComponent(studentVerificationReturn(value))}`;
}
