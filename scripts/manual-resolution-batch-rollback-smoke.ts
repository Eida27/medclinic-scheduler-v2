import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import type { SessionUser } from "../src/types/roles";

// Explicitly invoked shared-local smoke: all fixture and service writes remain
// inside one outer transaction, even when the service commits its savepoint.
async function main() {
  const args = process.argv.slice(2);
  assert.ok(args.includes("--rollback-only") && args.includes("--allow-shared-local-db"), "Explicit --rollback-only --allow-shared-local-db flags are required.");
  assert.notEqual(process.env.NODE_ENV, "production", "This smoke is unavailable in production mode.");
  const expectedDatabase = args.find((arg) => arg.startsWith("--expected-database="))?.split("=")[1];
  assert.ok(expectedDatabase && !["postgres","template0","template1"].includes(expectedDatabase), "Specify the intended application database with --expected-database=NAME.");
  const url = new URL(process.env.DATABASE_URL!);
  assert.ok(["postgres:","postgresql:"].includes(url.protocol));
  assert.ok(["localhost","127.0.0.1","[::1]"].includes(url.hostname), "Only an explicit loopback database is supported.");
  assert.equal(decodeURIComponent(url.pathname.slice(1)), expectedDatabase, "DATABASE_URL does not match the explicitly named database.");
  const realPool = new Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 10000 });
  const client = await realPool.connect();
  const prefix = `BMR${randomUUID().replaceAll("-", "").slice(0,10)}`;
  const requestId = randomUUID();
  const ownedCaseIds: string[] = [];
  let depth = 0, injectFailure = false;
  const wrapped = {
    query: async (sql: string, values?: unknown[]) => {
      if (sql === "BEGIN") return client.query(`SAVEPOINT bulk_smoke_${++depth}`);
      if (sql === "COMMIT") return client.query(`RELEASE SAVEPOINT bulk_smoke_${depth--}`);
      if (sql === "ROLLBACK") { const result=await client.query(`ROLLBACK TO SAVEPOINT bulk_smoke_${depth}`); await client.query(`RELEASE SAVEPOINT bulk_smoke_${depth--}`); return result; }
      if (injectFailure && sql.includes("'BULK_MANUAL_RESOLUTION','manual_resolution_batch'")) throw new Error("injected batch audit failure");
      return client.query(sql,values);
    },
    release() {},
  } as unknown as PoolClient;
  globalThis.__medclinicPool = { connect: async () => wrapped, query: wrapped.query.bind(wrapped) } as unknown as Pool;
  await client.query("BEGIN");
  try {
    assert.equal((await client.query("SELECT current_database() AS name")).rows[0].name, expectedDatabase);
    await client.query("SET LOCAL lock_timeout='10s'");
    const { previewManualResolutionBatch,resolveManualResolutionBatch,selectManualResolutionCases,getManualResolutionAvailability } = await import("../src/server/services/manual-resolution-batch.service");
    const { linkPublishedLaboratoryAppointments } = await import("../src/server/laboratory/laboratory-checklist.repository");
    const actorRow=(await client.query(`SELECT id::text,email,full_name,credential_version FROM users WHERE role='ADMIN' AND deleted_at IS NULL AND email_verified_at IS NOT NULL AND must_change_password=FALSE LIMIT 1`)).rows[0];
    assert.ok(actorRow,"Need an existing active Administrator");
    const actor={userId:actorRow.id,role:"ADMIN",fullName:actorRow.full_name,email:actorRow.email,clinicId:null,credentialVersion:actorRow.credential_version} as SessionUser;
    const refs=(await client.query(`SELECT program.id AS program_id,program.college_id,college.name AS college_name,program.name AS program_name,program.code AS program_code FROM programs program JOIN colleges college ON college.id=program.college_id LIMIT 1`)).rows[0];
    const clinics=(await client.query(`SELECT id::text,code FROM clinics WHERE code IN ('KABALAKA_CLINIC','CPU_CLINIC')`)).rows;
    const labClinic=clinics.find((row)=>row.code==='KABALAKA_CLINIC')!.id, peClinic=clinics.find((row)=>row.code==='CPU_CLINIC')!.id;
    await client.query(`INSERT INTO academic_years(start_year,closing_date,created_by,updated_by) VALUES (2098,'2099-07-31',$1,$1) ON CONFLICT(start_year) DO NOTHING`,[actor.userId]);
    const importId=randomUUID();
    await client.query(`INSERT INTO schedule_import_groups(id,import_name,source_filename,total_rows,created_by,student_category,academic_year_start,accepted_at,import_mode) VALUES ($1,$2,$2,2,$3,'REGULAR',2098,NOW(),'STANDARD')`,[importId,prefix,actor.userId]);
    const labBatch=randomUUID(),peBatch=randomUUID();
    await client.query(`INSERT INTO schedule_batches(id,clinic_id,batch_name,status,created_by,import_group_id) VALUES ($1,$3,$5,'PUBLISHED',$6,$7),($2,$4,$5,'PUBLISHED',$6,$7)`,[labBatch,peBatch,labClinic,peClinic,prefix,actor.userId,importId]);
    const cases:Array<{caseId:string;expectedOptimisticToken:string}>=[];
    for(let index=0;index<2;index++) {
      const student=`${prefix}${index}`,pair=randomUUID(),lab=randomUUID(),pe=randomUUID();
      await client.query(`INSERT INTO students(student_number,first_name,last_name,college_id,program_id,year_level,date_of_birth) VALUES ($1,'Bulk','Smoke',$2,$3,2,'2000-01-01')`,[student,refs.college_id,refs.program_id]);
      await client.query(`INSERT INTO student_academic_snapshots(student_number,academic_year_start,student_name,college_id,college_name,program_id,program_code,program_name,year_level,source_import_group_id) VALUES ($1,2098,'Bulk Smoke',$2,$3,$4,$5,$6,2,$7)`,[student,refs.college_id,refs.college_name,refs.program_id,refs.program_code,refs.program_name,importId]);
      await client.query(`INSERT INTO appointments(id,batch_id,clinic_id,student_number,schedule_type,appointment_date,status,is_published,schedule_pair_id,schedule_cycle_start,scheduling_category,created_by,updated_by)
        VALUES ($1,$3,$5,$7,'LABORATORY','2098-09-01','PENDING',TRUE,$8,2098,'REGULAR',$9,$9),($2,$4,$6,$7,'PHYSICAL_EXAM','2098-09-02','AWAITING_RESCHEDULE',FALSE,$8,2098,'REGULAR',$9,$9)`,[lab,pe,labBatch,peBatch,labClinic,peClinic,student,pair,actor.userId]);
      await linkPublishedLaboratoryAppointments(client,[lab]);
      const manual=(await client.query(`INSERT INTO clinic_closure_manual_cases(student_number,case_source,schedule_pair_id,schedule_cycle_start,affected_laboratory_appointment_id,affected_physical_exam_appointment_id,reason_code,reason_message,policy_metadata)
        VALUES ($1,'AUTOMATIC_DISPLACEMENT',$2,2098,$3,$4,'NO_VALID_REPLACEMENT_WITHIN_CYCLE','Owned rollback smoke','{}') RETURNING id::text,optimistic_token::text`,[student,pair,lab,pe])).rows[0];
      cases.push({caseId:manual.id,expectedOptimisticToken:manual.optimistic_token});
      ownedCaseIds.push(manual.id);
      await client.query(`INSERT INTO appointment_reschedule_events(student_number,schedule_pair_id,cause,source_import_group_id,old_laboratory_appointment_id,old_physical_exam_appointment_id,actor_user_id,manual_case_id,schedule_cycle_start,outcome)
        VALUES ($1,$2,'PRIORITY_DISPLACEMENT',$3,$4,$5,$6,$7,2098,'AWAITING_RESCHEDULE')`,[student,pair,importId,lab,pe,actor.userId,manual.id]);
    }
    const selection=await selectManualResolutionCases({academicYearStart:2098,importGroupId:importId},actor);
    assert.equal(selection.eligibleCount,2);assert.equal(selection.total,2);
    const emptySelection=await selectManualResolutionCases({academicYearStart:2098,importGroupId:randomUUID()},actor);assert.equal(emptySelection.total,0);
    const date=new Date('2098-10-01T00:00:00Z');while([0,6].includes(date.getUTCDay()))date.setUTCDate(date.getUTCDate()+1);
    const payload={cases,physicalExamDate:date.toISOString().slice(0,10),replaceRelatedServices:false,preservationAcknowledged:true as const,reason:'Owned rollback-only acceptance'};
    const availability=await getManualResolutionAvailability({cases,replaceRelatedServices:false,month:'2098-10',service:'PHYSICAL_EXAM'},actor);assert.equal(availability.days.length,31);
    const preview=await previewManualResolutionBatch(payload,actor);assert.ok(preview.previewToken,JSON.stringify(preview.rows));assert.equal(preview.appointmentCount,2);
    assert.equal((await client.query(`SELECT count(*)::int AS count FROM appointments WHERE student_number LIKE $1`,[`${prefix}%`])).rows[0].count,4);
    injectFailure=true;
    await assert.rejects(resolveManualResolutionBatch({...payload,requestId,previewToken:preview.previewToken},actor),/injected batch audit failure/);
    injectFailure=false;
    assert.equal((await client.query(`SELECT count(*)::int AS count FROM clinic_closure_manual_cases WHERE id=ANY($1::uuid[]) AND status='OPEN'`,[cases.map((row)=>row.caseId)])).rows[0].count,2);
    assert.equal((await client.query(`SELECT count(*)::int AS count FROM appointments WHERE student_number LIKE $1`,[`${prefix}%`])).rows[0].count,4);
    assert.equal((await client.query(`SELECT count(*)::int AS count FROM clinical_mutation_requests WHERE actor_user_id=$1 AND request_id=$2`,[actor.userId,requestId])).rows[0].count,0);
    assert.equal((await client.query(`SELECT (SELECT count(*) FROM student_portal_notifications WHERE student_number LIKE $1)+(SELECT count(*) FROM email_outbox WHERE student_number LIKE $1)+(SELECT count(*) FROM audit_logs WHERE entity_id=ANY($2::text[]) OR metadata->>'requestId'=$3) AS count`,[`${prefix}%`,ownedCaseIds,requestId])).rows[0].count,"0");
    const outcome=await resolveManualResolutionBatch({...payload,requestId,previewToken:preview.previewToken},actor);
    assert.deepEqual(await resolveManualResolutionBatch({...payload,requestId,previewToken:preview.previewToken},actor),outcome);
    assert.equal((await client.query(`SELECT count(*)::int AS count FROM appointments WHERE student_number LIKE $1 AND rescheduled_from IS NOT NULL AND batch_id=$2`,[`${prefix}%`,peBatch])).rows[0].count,2);
    assert.equal((await client.query(`SELECT count(*)::int AS count FROM appointment_reschedule_events WHERE manual_case_id=ANY($1::uuid[]) AND outcome='MANUALLY_RESOLVED' AND new_physical_exam_appointment_id IS NOT NULL`,[cases.map((row)=>row.caseId)])).rows[0].count,2);
    console.log(JSON.stringify({selection:true,provenanceFilter:true,availabilityDays:availability.days.length,previewReadOnly:true,injectedFaultRollback:true,atomicApply:outcome,exactReplay:true,crossConnectionConcurrency:false}));
  } finally {
    try {
      await client.query("ROLLBACK");
      const residue=(await client.query(`SELECT
        (SELECT count(*) FROM students WHERE student_number LIKE $1)+
        (SELECT count(*) FROM student_academic_snapshots WHERE student_number LIKE $1)+
        (SELECT count(*) FROM appointments WHERE student_number LIKE $1)+
        (SELECT count(*) FROM clinic_closure_manual_cases WHERE student_number LIKE $1)+
        (SELECT count(*) FROM appointment_reschedule_events WHERE student_number LIKE $1)+
        (SELECT count(*) FROM student_portal_notifications WHERE student_number LIKE $1)+
        (SELECT count(*) FROM email_outbox WHERE student_number LIKE $1)+
        (SELECT count(*) FROM schedule_import_groups WHERE import_name=$2)+
        (SELECT count(*) FROM schedule_batches WHERE batch_name=$2)+
        (SELECT count(*) FROM audit_logs WHERE entity_id=ANY($3::text[]) OR metadata->>'requestId'=$4)+
        (SELECT count(*) FROM clinical_mutation_requests WHERE request_id=$4::uuid) AS count`,[`${prefix}%`,prefix,ownedCaseIds,requestId])).rows[0].count;
      assert.equal(Number(residue),0);console.log('ROLLBACK cleanup verified: zero owned student/snapshot/appointment/case/event/notification/outbox/import/batch/audit/replay residue');
    } finally {
      client.release();await realPool.end();delete globalThis.__medclinicPool;
    }
  }
}
main().catch((error)=>{console.error(error);process.exitCode=1;});
