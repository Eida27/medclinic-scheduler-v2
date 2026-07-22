import { AppointmentDetail } from "@/components/appointments/AppointmentDetail";

export default async function AppointmentPage({
  params,
}: {
  params: Promise<{ appointmentId: string }>;
}) {
  return <AppointmentDetail appointmentId={(await params).appointmentId} source="APPOINTMENTS" />;
}
