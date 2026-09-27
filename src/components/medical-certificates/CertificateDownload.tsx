import Link from "next/link";

export function CertificateDownload({ certificateId, audience }: {
  certificateId: string;
  audience: "staff" | "student";
}) {
  const href = audience === "student"
    ? `/api/student/medical-certificates/${certificateId}/download`
    : `/api/medical-certificates/${certificateId}/download`;
  return <Link href={href} className="inline-flex rounded-xl bg-cpu-navy px-4 py-3 font-semibold text-white hover:bg-cpu-navy-light">
    Download medical certificate JPG
  </Link>;
}
