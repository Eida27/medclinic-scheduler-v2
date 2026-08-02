import "server-only";
import type { AcademicYearState } from "@/lib/academic-year";
import type {
  HistoricalComplianceClassification,
  HistoricalDataQuality,
  HistoricalReportFilters,
  HistoricalRequirementStatus,
} from "@/lib/historical-compliance-report";
import { query } from "@/server/db/pool";
import type { PoolClient } from "pg";

type ExecutableHistoricalReportFilters = Omit<HistoricalReportFilters, "academicYearStart"> & {
  academicYearStart: number;
};

export type HistoricalComplianceReportItem = {
  studentNumber: string;
  studentName: string;
  collegeId: string | null;
  collegeName: string;
  programId: string | null;
  programCode: string | null;
  programName: string;
  yearLevel: number | null;
  laboratoryAppointmentId: string | null;
  laboratoryAppointmentDate: string | null;
  laboratoryStatus: HistoricalRequirementStatus;
  physicalExamAppointmentId: string | null;
  physicalExamAppointmentDate: string | null;
  physicalExamStatus: HistoricalRequirementStatus;
  overallStatus: HistoricalComplianceClassification;
  dataQuality: HistoricalDataQuality;
};

export type HistoricalComplianceSummary = {
  totalStudents: number;
  fullyComplied: number;
  pendingCompliance: number;
  didNotComply: number;
  complianceRate: number;
  laboratoryIncomplete: number;
  physicalExamIncomplete: number;
  bothIncomplete: number;
  migratedIncomplete: number;
};

type BreakdownMetrics = {
  totalStudents: number;
  fullyComplied: number;
  attentionStudents: number;
  complianceRate: number;
};

export type HistoricalComplianceBreakdowns = {
  colleges: Array<BreakdownMetrics & { collegeId: string | null; collegeName: string }>;
  programs: Array<BreakdownMetrics & {
    collegeId: string | null;
    collegeName: string;
    programId: string | null;
    programCode: string | null;
    programName: string;
  }>;
  yearLevels: Array<BreakdownMetrics & { yearLevel: number | null }>;
};

export type HistoricalReportDimensions = {
  colleges: Array<{ id: string; name: string }>;
  programs: Array<{ id: string; collegeId: string; code: string; name: string }>;
  yearLevels: number[];
};

export type HistoricalComplianceReportResult = {
  items: HistoricalComplianceReportItem[];
  total: number;
  summary: HistoricalComplianceSummary;
  breakdowns: HistoricalComplianceBreakdowns;
  dimensions: HistoricalReportDimensions;
};

const orderBy: Record<HistoricalReportFilters["sort"], string> = {
  college_asc: `LOWER(row."collegeName") ASC,LOWER(row."programName") ASC,
    row."yearLevel" ASC NULLS LAST,LOWER(row."studentName") ASC,row."studentNumber" ASC`,
  college_desc: `LOWER(row."collegeName") DESC,LOWER(row."programName") DESC,
    row."yearLevel" DESC NULLS LAST,LOWER(row."studentName") DESC,row."studentNumber" DESC`,
  program_asc: `LOWER(row."programName") ASC,LOWER(row."collegeName") ASC,
    row."yearLevel" ASC NULLS LAST,LOWER(row."studentName") ASC,row."studentNumber" ASC`,
  program_desc: `LOWER(row."programName") DESC,LOWER(row."collegeName") DESC,
    row."yearLevel" DESC NULLS LAST,LOWER(row."studentName") DESC,row."studentNumber" DESC`,
  year_asc: `row."yearLevel" ASC NULLS LAST,LOWER(row."collegeName") ASC,
    LOWER(row."programName") ASC,LOWER(row."studentName") ASC,row."studentNumber" ASC`,
  year_desc: `row."yearLevel" DESC NULLS LAST,LOWER(row."collegeName") DESC,
    LOWER(row."programName") DESC,LOWER(row."studentName") DESC,row."studentNumber" DESC`,
  name_asc: `LOWER(row."studentName") ASC,row."studentNumber" ASC`,
  name_desc: `LOWER(row."studentName") DESC,row."studentNumber" DESC`,
  attention_first: `CASE WHEN row."overallStatus"='COMPLIED' THEN 1 ELSE 0 END ASC,
    LOWER(row."collegeName") ASC,LOWER(row."programName") ASC,
    row."yearLevel" ASC NULLS LAST,LOWER(row."studentName") ASC,row."studentNumber" ASC`,
  completed_first: `CASE WHEN row."overallStatus"='COMPLIED' THEN 0 ELSE 1 END ASC,
    LOWER(row."collegeName") ASC,LOWER(row."programName") ASC,
    row."yearLevel" ASC NULLS LAST,LOWER(row."studentName") ASC,row."studentNumber" ASC`,
};

function run<T extends object>(client: PoolClient | undefined, sql: string, values: unknown[]) {
  return client ? client.query<T>(sql, values) : query<T>(sql, values);
}

export async function historicalComplianceReportRepository(
  filters: ExecutableHistoricalReportFilters,
  academicYearState: AcademicYearState,
  options: { limit?: number; offset?: number; client?: PoolClient } = {},
): Promise<HistoricalComplianceReportResult> {
  const values: unknown[] = [filters.academicYearStart, academicYearState];
  const clauses = ["TRUE"];
  const add = (sql: string, value: unknown) => {
    values.push(value);
    clauses.push(sql.replaceAll("?", `$${values.length}`));
  };

  if (filters.search) {
    add(`(row."studentNumber" ILIKE ? OR row."studentName" ILIKE ?)`, `%${filters.search}%`);
  }
  if (filters.overallStatus === "DID_NOT_COMPLY") {
    clauses.push(`row."overallStatus" LIKE 'DID_NOT_COMPLY_%'`);
  } else if (filters.overallStatus) {
    add(`row."overallStatus"=?`, filters.overallStatus);
  }
  if (filters.laboratoryStatus) add(`row."laboratoryStatus"=?`, filters.laboratoryStatus);
  if (filters.physicalExamStatus) add(`row."physicalExamStatus"=?`, filters.physicalExamStatus);
  if (filters.collegeId) add(`row."collegeId"=?::uuid`, filters.collegeId);
  if (filters.programId) add(`row."programId"=?::uuid`, filters.programId);
  if (filters.yearLevel) add(`row."yearLevel"=?`, filters.yearLevel);
  if (filters.dataQuality) add(`row."dataQuality"=?`, filters.dataQuality);

  values.push(options.limit ?? filters.limit, options.offset ?? filters.offset);
  const limitParameter = `$${values.length - 1}`;
  const offsetParameter = `$${values.length}`;
  const ordering = orderBy[filters.sort];

  const result = await run<{ result: HistoricalComplianceReportResult }>(
    options.client,
    `WITH published_population AS (
       SELECT DISTINCT appointment.student_number
         FROM appointments appointment
        WHERE appointment.schedule_cycle_start=$1
          AND appointment.is_published=TRUE
          AND appointment.status<>'DRAFT'
     ),
     published_leaf_appointments AS (
       SELECT appointment.id,appointment.student_number,appointment.schedule_type,
              appointment.appointment_date,appointment.status,appointment.created_at
         FROM appointments appointment
        WHERE appointment.schedule_cycle_start=$1
          AND appointment.is_published=TRUE
          AND appointment.status<>'DRAFT'
          AND NOT EXISTS (
            SELECT 1 FROM appointments replacement
             WHERE replacement.rescheduled_from=appointment.id
               AND replacement.schedule_cycle_start=appointment.schedule_cycle_start
               AND replacement.student_number=appointment.student_number
               AND replacement.schedule_type=appointment.schedule_type
               AND replacement.is_published=TRUE
               AND replacement.status<>'DRAFT'
          )
     ),
     ranked_effective_appointments AS (
       SELECT appointment.*,
              ROW_NUMBER() OVER (
                PARTITION BY appointment.student_number,appointment.schedule_type
                ORDER BY appointment.appointment_date DESC,
                         appointment.created_at DESC,appointment.id DESC
              ) AS effective_rank
         FROM published_leaf_appointments appointment
     ),
     effective_appointments AS (
       SELECT * FROM ranked_effective_appointments WHERE effective_rank=1
     ),
     reporting_rows AS (
       SELECT snapshot.student_number AS "studentNumber",
              snapshot.student_name AS "studentName",
              snapshot.college_id AS "collegeId",
              snapshot.college_name AS "collegeName",
              snapshot.program_id AS "programId",
              snapshot.program_code AS "programCode",
              snapshot.program_name AS "programName",
              snapshot.year_level AS "yearLevel",
              snapshot.source_type AS "dataQuality",
              laboratory.id AS "laboratoryAppointmentId",
              laboratory.appointment_date::text AS "laboratoryAppointmentDate",
              COALESCE(laboratory.status,'UNSCHEDULED') AS "laboratoryStatus",
              physical.id AS "physicalExamAppointmentId",
              physical.appointment_date::text AS "physicalExamAppointmentDate",
              COALESCE(physical.status,'UNSCHEDULED') AS "physicalExamStatus"
         FROM student_academic_snapshots snapshot
         JOIN published_population population
           ON population.student_number=snapshot.student_number
         LEFT JOIN effective_appointments laboratory
           ON laboratory.student_number=snapshot.student_number
          AND laboratory.schedule_type='LABORATORY'
         LEFT JOIN effective_appointments physical
           ON physical.student_number=snapshot.student_number
          AND physical.schedule_type='PHYSICAL_EXAM'
        WHERE snapshot.academic_year_start=$1
     ),
     classified_rows AS (
       SELECT row.*,
              CASE
                WHEN row."laboratoryStatus"='COMPLETED'
                 AND row."physicalExamStatus"='COMPLETED' THEN 'COMPLIED'
                WHEN $2<>'CLOSED' THEN 'PENDING_COMPLIANCE'
                WHEN row."laboratoryStatus"<>'COMPLETED'
                 AND row."physicalExamStatus"='COMPLETED' THEN 'DID_NOT_COMPLY_LABORATORY'
                WHEN row."laboratoryStatus"='COMPLETED' THEN 'DID_NOT_COMPLY_PHYSICAL_EXAM'
                ELSE 'DID_NOT_COMPLY_BOTH'
              END AS "overallStatus"
         FROM reporting_rows row
     ),
     filtered_rows AS MATERIALIZED (
       SELECT * FROM classified_rows row WHERE ${clauses.join(" AND ")}
     )
     SELECT jsonb_build_object(
       'items',(
         SELECT COALESCE(jsonb_agg(page.item ORDER BY page.row_order),'[]'::jsonb)
           FROM (
             SELECT jsonb_build_object(
                      'studentNumber',row."studentNumber",'studentName',row."studentName",
                      'collegeId',row."collegeId",'collegeName',row."collegeName",
                      'programId',row."programId",'programCode',row."programCode",
                      'programName',row."programName",'yearLevel',row."yearLevel",
                      'laboratoryAppointmentId',row."laboratoryAppointmentId",
                      'laboratoryAppointmentDate',row."laboratoryAppointmentDate",
                      'laboratoryStatus',row."laboratoryStatus",
                      'physicalExamAppointmentId',row."physicalExamAppointmentId",
                      'physicalExamAppointmentDate',row."physicalExamAppointmentDate",
                      'physicalExamStatus',row."physicalExamStatus",
                      'overallStatus',row."overallStatus",'dataQuality',row."dataQuality"
                    ) AS item,
                    ROW_NUMBER() OVER (ORDER BY ${ordering}) AS row_order
               FROM filtered_rows row
              ORDER BY ${ordering}
              LIMIT ${limitParameter} OFFSET ${offsetParameter}
           ) page
       ),
       'total',(SELECT COUNT(*)::integer FROM filtered_rows),
       'summary',(
         SELECT jsonb_build_object(
           'totalStudents',COUNT(*)::integer,
           'fullyComplied',COUNT(*) FILTER (WHERE row."overallStatus"='COMPLIED')::integer,
           'pendingCompliance',COUNT(*) FILTER (WHERE row."overallStatus"='PENDING_COMPLIANCE')::integer,
           'didNotComply',COUNT(*) FILTER (WHERE row."overallStatus" LIKE 'DID_NOT_COMPLY_%')::integer,
           'complianceRate',COALESCE(ROUND(
             100.0 * COUNT(*) FILTER (WHERE row."overallStatus"='COMPLIED') / NULLIF(COUNT(*),0),1
           ),0),
           'laboratoryIncomplete',COUNT(*) FILTER (WHERE row."laboratoryStatus"<>'COMPLETED')::integer,
           'physicalExamIncomplete',COUNT(*) FILTER (WHERE row."physicalExamStatus"<>'COMPLETED')::integer,
           'bothIncomplete',COUNT(*) FILTER (
             WHERE row."laboratoryStatus"<>'COMPLETED' AND row."physicalExamStatus"<>'COMPLETED'
           )::integer,
           'migratedIncomplete',COUNT(*) FILTER (WHERE row."dataQuality"='MIGRATED_INCOMPLETE')::integer
         ) FROM filtered_rows row
       ),
       'breakdowns',jsonb_build_object(
         'colleges',(
           SELECT COALESCE(jsonb_agg(to_jsonb(grouped) ORDER BY LOWER(grouped."collegeName")),'[]'::jsonb)
             FROM (
               SELECT row."collegeId",row."collegeName",COUNT(*)::integer AS "totalStudents",
                      COUNT(*) FILTER (WHERE row."overallStatus"='COMPLIED')::integer AS "fullyComplied",
                      COUNT(*) FILTER (WHERE row."overallStatus"<>'COMPLIED')::integer AS "attentionStudents",
                      COALESCE(ROUND(100.0 * COUNT(*) FILTER (WHERE row."overallStatus"='COMPLIED')
                        / NULLIF(COUNT(*),0),1),0) AS "complianceRate"
                 FROM filtered_rows row GROUP BY row."collegeId",row."collegeName"
             ) grouped
         ),
         'programs',(
           SELECT COALESCE(jsonb_agg(to_jsonb(grouped) ORDER BY LOWER(grouped."collegeName"),LOWER(grouped."programName")),'[]'::jsonb)
             FROM (
               SELECT row."collegeId",row."collegeName",row."programId",row."programCode",row."programName",
                      COUNT(*)::integer AS "totalStudents",
                      COUNT(*) FILTER (WHERE row."overallStatus"='COMPLIED')::integer AS "fullyComplied",
                      COUNT(*) FILTER (WHERE row."overallStatus"<>'COMPLIED')::integer AS "attentionStudents",
                      COALESCE(ROUND(100.0 * COUNT(*) FILTER (WHERE row."overallStatus"='COMPLIED')
                        / NULLIF(COUNT(*),0),1),0) AS "complianceRate"
                 FROM filtered_rows row
                GROUP BY row."collegeId",row."collegeName",row."programId",row."programCode",row."programName"
             ) grouped
         ),
         'yearLevels',(
           SELECT COALESCE(jsonb_agg(to_jsonb(grouped) ORDER BY grouped."yearLevel" NULLS LAST),'[]'::jsonb)
             FROM (
               SELECT row."yearLevel",COUNT(*)::integer AS "totalStudents",
                      COUNT(*) FILTER (WHERE row."overallStatus"='COMPLIED')::integer AS "fullyComplied",
                      COUNT(*) FILTER (WHERE row."overallStatus"<>'COMPLIED')::integer AS "attentionStudents",
                      COALESCE(ROUND(100.0 * COUNT(*) FILTER (WHERE row."overallStatus"='COMPLIED')
                        / NULLIF(COUNT(*),0),1),0) AS "complianceRate"
                 FROM filtered_rows row GROUP BY row."yearLevel"
             ) grouped
         )
       ),
       'dimensions',jsonb_build_object(
         'colleges',(
           SELECT COALESCE(jsonb_agg(jsonb_build_object('id',option."collegeId",'name',option."collegeName")
                    ORDER BY LOWER(option."collegeName")),'[]'::jsonb)
             FROM (SELECT DISTINCT row."collegeId",row."collegeName" FROM reporting_rows row
                    WHERE row."collegeId" IS NOT NULL) option
         ),
         'programs',(
           SELECT COALESCE(jsonb_agg(jsonb_build_object(
                    'id',option."programId",'collegeId',option."collegeId",
                    'code',option."programCode",'name',option."programName"
                  ) ORDER BY LOWER(option."collegeName"),LOWER(option."programName")),'[]'::jsonb)
             FROM (SELECT DISTINCT row."programId",row."collegeId",row."collegeName",
                          row."programCode",row."programName" FROM reporting_rows row
                    WHERE row."programId" IS NOT NULL AND row."collegeId" IS NOT NULL) option
         ),
         'yearLevels',(
           SELECT COALESCE(jsonb_agg(option."yearLevel" ORDER BY option."yearLevel"),'[]'::jsonb)
             FROM (SELECT DISTINCT row."yearLevel" FROM reporting_rows row
                    WHERE row."yearLevel" IS NOT NULL) option
         )
       )
     ) AS result`,
    values,
  );
  return result.rows[0].result;
}
