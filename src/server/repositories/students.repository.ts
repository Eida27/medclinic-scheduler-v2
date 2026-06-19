import "server-only";
import { query } from "@/server/db/pool";

export type StudentInput = {
  studentNumber: string;
  firstName: string;
  middleName: string | null;
  lastName: string;
  suffix: string | null;
  collegeId: string;
  programId: string;
  yearLevel: number | null;
  section: string | null;
};

export type StudentListFilters = {
  search?: string;
  collegeId?: string;
  programId?: string;
  yearLevel?: number;
  page: number;
  limit: number;
  offset: number;
};

export type AppointmentHistory = {
  id: string;
  schedule_type: string;
  appointment_date: string;
  appointment_time: string | null;
  status: string;
  is_published: boolean;
  notes: string | null;
};

export type ResultHistory = {
  id: string;
  appointment_id: string | null;
  result_status: string;
  completed_at: string | null;
  remarks: string | null;
};

type StudentRow = {
  student_number: string;
  first_name: string;
  middle_name: string | null;
  last_name: string;
  suffix: string | null;
  college_id: string;
  college_name: string;
  program_id: string;
  program_name: string;
  year_level: number | null;
  section: string | null;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
};

function mapStudent(row: StudentRow) {
  return {
    studentNumber: row.student_number,
    firstName: row.first_name,
    middleName: row.middle_name,
    lastName: row.last_name,
    suffix: row.suffix,
    fullName: [row.first_name, row.middle_name, row.last_name, row.suffix].filter(Boolean).join(" "),
    collegeId: row.college_id,
    collegeName: row.college_name,
    programId: row.program_id,
    programName: row.program_name,
    yearLevel: row.year_level,
    section: row.section,
    isActive: row.is_active,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

const studentSelect = `
  SELECT s.student_number, s.first_name, s.middle_name, s.last_name, s.suffix,
         s.college_id, c.name AS college_name, s.program_id, p.name AS program_name,
         s.year_level, s.section, s.is_active, s.created_at, s.updated_at
  FROM students s
  JOIN colleges c ON c.id = s.college_id
  JOIN programs p ON p.id = s.program_id
`;

export async function listStudents(filters: StudentListFilters) {
  const clauses = ["s.is_active = TRUE"];
  const values: unknown[] = [];
  if (filters.search) {
    values.push(`%${filters.search}%`);
    clauses.push(`(s.student_number ILIKE $${values.length} OR CONCAT_WS(' ', s.first_name, s.middle_name, s.last_name) ILIKE $${values.length})`);
  }
  if (filters.collegeId) {
    values.push(filters.collegeId);
    clauses.push(`s.college_id = $${values.length}`);
  }
  if (filters.programId) {
    values.push(filters.programId);
    clauses.push(`s.program_id = $${values.length}`);
  }
  if (filters.yearLevel) {
    values.push(filters.yearLevel);
    clauses.push(`s.year_level = $${values.length}`);
  }

  const where = clauses.join(" AND ");
  const count = await query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM students s WHERE ${where}`, values);
  values.push(filters.limit, filters.offset);
  const rows = await query<StudentRow>(
    `${studentSelect} WHERE ${where}
     ORDER BY s.last_name, s.first_name, s.student_number
     LIMIT $${values.length - 1} OFFSET $${values.length}`,
    values,
  );
  return { items: rows.rows.map(mapStudent), total: Number(count.rows[0].count) };
}

export async function getStudent(studentNumber: string) {
  const result = await query<StudentRow>(`${studentSelect} WHERE s.student_number = $1`, [studentNumber]);
  return result.rows[0] ? mapStudent(result.rows[0]) : null;
}

export async function registeredStudentNumbers(studentNumbers: string[]) {
  if (studentNumbers.length === 0) return new Set<string>();
  const result = await query<{ student_number: string }>(
    "SELECT student_number FROM students WHERE student_number = ANY($1::varchar[])",
    [studentNumbers],
  );
  return new Set(result.rows.map((row) => row.student_number));
}

export async function programBelongsToCollege(programId: string, collegeId: string): Promise<boolean> {
  const result = await query("SELECT 1 FROM programs WHERE id = $1 AND college_id = $2 AND is_active = TRUE", [programId, collegeId]);
  return Boolean(result.rowCount);
}

export async function insertStudent(input: StudentInput) {
  await query(
    `INSERT INTO students (
      student_number, first_name, middle_name, last_name, suffix,
      college_id, program_id, year_level, section
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [input.studentNumber, input.firstName, input.middleName, input.lastName, input.suffix, input.collegeId, input.programId, input.yearLevel, input.section],
  );
  return getStudent(input.studentNumber);
}

export async function updateStudentRecord(studentNumber: string, input: Omit<StudentInput, "studentNumber">) {
  await query(
    `UPDATE students SET first_name=$2, middle_name=$3, last_name=$4, suffix=$5,
      college_id=$6, program_id=$7, year_level=$8, section=$9
     WHERE student_number=$1`,
    [studentNumber, input.firstName, input.middleName, input.lastName, input.suffix, input.collegeId, input.programId, input.yearLevel, input.section],
  );
  return getStudent(studentNumber);
}

export async function deactivateStudentRecord(studentNumber: string): Promise<boolean> {
  const result = await query("UPDATE students SET is_active = FALSE WHERE student_number = $1 AND is_active = TRUE", [studentNumber]);
  return Boolean(result.rowCount);
}

export async function studentHistory(studentNumber: string) {
  const appointments = await query<AppointmentHistory>(
    `SELECT id, schedule_type, appointment_date::text, appointment_time::text, status, is_published, notes
     FROM appointments WHERE student_number = $1 ORDER BY appointment_date DESC, created_at DESC`,
    [studentNumber],
  );
  const examResults = await query<ResultHistory>(
    `SELECT id, appointment_id, result_status, completed_at::text, remarks
     FROM exam_results WHERE student_number = $1 ORDER BY completed_at DESC NULLS LAST, created_at DESC`,
    [studentNumber],
  );
  const laboratoryResults = await query<ResultHistory>(
    `SELECT id, appointment_id, result_status, completed_at::text, remarks
     FROM laboratory_results WHERE student_number = $1 ORDER BY completed_at DESC NULLS LAST, created_at DESC`,
    [studentNumber],
  );
  return { appointments: appointments.rows, examResults: examResults.rows, laboratoryResults: laboratoryResults.rows };
}
