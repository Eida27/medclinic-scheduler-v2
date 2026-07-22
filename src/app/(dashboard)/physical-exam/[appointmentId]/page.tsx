import { AppointmentDetail } from "@/components/appointments/AppointmentDetail";

export default async function PhysicalExamAppointmentPage({
  params,
}: {
  params: Promise<{ appointmentId: string }>;
}) {
  return (
    <AppointmentDetail
      appointmentId={(await params).appointmentId}
      expectedScheduleType="PHYSICAL_EXAM"
      source="PHYSICAL_EXAM"
    />
  );
}
