import { AppointmentDetail } from "@/components/appointments/AppointmentDetail";

export default async function LaboratoryAppointmentPage({
  params,
}: {
  params: Promise<{ appointmentId: string }>;
}) {
  return (
    <AppointmentDetail
      appointmentId={(await params).appointmentId}
      expectedScheduleType="LABORATORY"
      source="LABORATORY"
    />
  );
}
