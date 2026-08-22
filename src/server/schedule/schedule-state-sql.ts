export function authoritativeScheduleLocationSql(
  appointmentAlias: string,
  clinicAlias: string,
) {
  return `CASE WHEN ${appointmentAlias}.ovpsa_batch_id IS NOT NULL
                     AND ${appointmentAlias}.schedule_type='LABORATORY'
               THEN 'Iloilo Mission Hospital' ELSE ${clinicAlias}.name END`;
}

export function currentPublishedSchedulePredicate(appointmentAlias: string) {
  return `${appointmentAlias}.is_published=TRUE
    AND ${appointmentAlias}.status NOT IN ('DRAFT','RESCHEDULED','CANCELLED')`;
}

export function authoritativeScheduleDateSql(appointmentAlias: string) {
  return `CASE WHEN ${appointmentAlias}.status='AWAITING_RESCHEDULE'
               THEN NULL ELSE ${appointmentAlias}.appointment_date::text END`;
}
