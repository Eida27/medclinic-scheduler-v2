export function ageOn(dateOfBirth: string, examinationDate: string): number {
  const birth = new Date(`${dateOfBirth}T00:00:00.000Z`);
  const exam = new Date(`${examinationDate}T00:00:00.000Z`);
  let age = exam.getUTCFullYear() - birth.getUTCFullYear();
  if (exam.getUTCMonth() < birth.getUTCMonth()
      || (exam.getUTCMonth() === birth.getUTCMonth() && exam.getUTCDate() < birth.getUTCDate())) age--;
  return age;
}
