CREATE TEMP TABLE migration_012_colleges (
  id UUID PRIMARY KEY,
  code VARCHAR(30) NOT NULL,
  name VARCHAR(150) NOT NULL
) ON COMMIT DROP;

INSERT INTO migration_012_colleges (id, code, name)
VALUES
  ('10000000-0000-4000-8000-000000000001', 'COEng', 'College of Engineering'),
  ('10000000-0000-4000-8000-000000000002', 'CON', 'College of Nursing'),
  ('10000000-0000-4000-8000-000000000003', 'CCS', 'College of Computer Studies'),
  ('10000000-0000-4000-8000-000000000004', 'CARES', 'College of Agriculture, Resources, and Environmental Sciences'),
  ('10000000-0000-4000-8000-000000000005', 'CAS', 'College of Arts and Sciences'),
  ('10000000-0000-4000-8000-000000000006', 'CBA', 'College of Business and Accountancy'),
  ('10000000-0000-4000-8000-000000000007', 'CED', 'College of Education'),
  ('10000000-0000-4000-8000-000000000008', 'CHM', 'College of Hospitality Management'),
  ('10000000-0000-4000-8000-000000000009', 'CMLS', 'College of Medical Laboratory Science'),
  ('10000000-0000-4000-8000-000000000010', 'COP', 'College of Pharmacy'),
  ('10000000-0000-4000-8000-000000000011', 'COL', 'College of Law'),
  ('10000000-0000-4000-8000-000000000012', 'COM', 'College of Medicine'),
  ('10000000-0000-4000-8000-000000000013', 'COT', 'College of Theology');

CREATE TEMP TABLE migration_012_programs (
  id UUID PRIMARY KEY,
  college_id UUID NOT NULL,
  code VARCHAR(30) NOT NULL,
  name VARCHAR(150) NOT NULL
) ON COMMIT DROP;

INSERT INTO migration_012_programs (id, college_id, code, name)
VALUES
  ('20000000-0000-4000-8000-000000000004', '10000000-0000-4000-8000-000000000004', 'BSA', 'Bachelor of Science in Agriculture'),
  ('20000000-0000-4000-8000-000000000005', '10000000-0000-4000-8000-000000000004', 'BSEM', 'Bachelor of Science in Environmental Management'),
  ('20000000-0000-4000-8000-000000000006', '10000000-0000-4000-8000-000000000004', 'BSABE', 'Bachelor of Science in Agricultural and Biosystems Engineering'),
  ('20000000-0000-4000-8000-000000000007', '10000000-0000-4000-8000-000000000005', 'BA ELS', 'Bachelor of Arts in English Language Studies'),
  ('20000000-0000-4000-8000-000000000008', '10000000-0000-4000-8000-000000000005', 'BA Com', 'Bachelor of Arts in Mass Communication'),
  ('20000000-0000-4000-8000-000000000009', '10000000-0000-4000-8000-000000000005', 'BASPSPA', 'Bachelor of Arts in Political Science & Public Administration'),
  ('20000000-0000-4000-8000-000000000010', '10000000-0000-4000-8000-000000000005', 'BS Psych', 'Bachelor of Science in Psychology'),
  ('20000000-0000-4000-8000-000000000011', '10000000-0000-4000-8000-000000000005', 'BS Bio', 'Bachelor of Science in Biology'),
  ('20000000-0000-4000-8000-000000000012', '10000000-0000-4000-8000-000000000005', 'BS BioMic', 'Bachelor of Science in Biology with specialization in Microbiology'),
  ('20000000-0000-4000-8000-000000000013', '10000000-0000-4000-8000-000000000005', 'BS Chem', 'Bachelor of Science in Chemistry'),
  ('20000000-0000-4000-8000-000000000014', '10000000-0000-4000-8000-000000000005', 'BS Math', 'Bachelor of Science in Mathematics'),
  ('20000000-0000-4000-8000-000000000015', '10000000-0000-4000-8000-000000000005', 'BS SW', 'Bachelor of Science in Social Work'),
  ('20000000-0000-4000-8000-000000000016', '10000000-0000-4000-8000-000000000006', 'BSA', 'Bachelor of Science in Accountancy'),
  ('20000000-0000-4000-8000-000000000017', '10000000-0000-4000-8000-000000000006', 'BSBA BM', 'Bachelor of Science in Business Administration Major in Business Management'),
  ('20000000-0000-4000-8000-000000000018', '10000000-0000-4000-8000-000000000006', 'BSBAFM', 'Bachelor of Science in Business Administration Major in Financial Management'),
  ('20000000-0000-4000-8000-000000000019', '10000000-0000-4000-8000-000000000006', 'BSBAMM', 'Bachelor of Science in Business Administration Major in Marketing Management'),
  ('20000000-0000-4000-8000-000000000020', '10000000-0000-4000-8000-000000000006', 'BSEnt', 'Bachelor of Science in Entrepreneurship'),
  ('20000000-0000-4000-8000-000000000021', '10000000-0000-4000-8000-000000000006', 'BSMA', 'Bachelor of Science in Management Accounting'),
  ('20000000-0000-4000-8000-000000000022', '10000000-0000-4000-8000-000000000006', 'BSBAHRM', 'Bachelor of Science in Business Administration Major in Human Resource Management'),
  ('20000000-0000-4000-8000-000000000023', '10000000-0000-4000-8000-000000000003', 'BSCS', 'Bachelor of Science in Computer Science'),
  ('20000000-0000-4000-8000-000000000024', '10000000-0000-4000-8000-000000000003', 'BSDMIA', 'Bachelor of Science in Digital Media and Interactive Arts'),
  ('20000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000003', 'BSIT', 'Bachelor of Science in Information Technology'),
  ('20000000-0000-4000-8000-000000000025', '10000000-0000-4000-8000-000000000003', 'BSIS', 'Bachelor of Science in Information Systems'),
  ('20000000-0000-4000-8000-000000000026', '10000000-0000-4000-8000-000000000003', 'BLIS', 'Bachelor in Library and Information Science'),
  ('20000000-0000-4000-8000-000000000027', '10000000-0000-4000-8000-000000000007', 'BECEd', 'Bachelor of Early Childhood Education'),
  ('20000000-0000-4000-8000-000000000028', '10000000-0000-4000-8000-000000000007', 'BEEd', 'Bachelor of Elementary Education'),
  ('20000000-0000-4000-8000-000000000029', '10000000-0000-4000-8000-000000000007', 'BPEd', 'Bachelor of Physical Education'),
  ('20000000-0000-4000-8000-000000000030', '10000000-0000-4000-8000-000000000007', 'BSEd-E', 'Bachelor of Secondary Education major in English'),
  ('20000000-0000-4000-8000-000000000031', '10000000-0000-4000-8000-000000000007', 'BSEd-F', 'Bachelor of Secondary Education major in Filipino'),
  ('20000000-0000-4000-8000-000000000032', '10000000-0000-4000-8000-000000000007', 'BSEd-M', 'Bachelor of Secondary Education major in Mathematics'),
  ('20000000-0000-4000-8000-000000000033', '10000000-0000-4000-8000-000000000007', 'BSEd-S', 'Bachelor of Secondary Education major in Science'),
  ('20000000-0000-4000-8000-000000000034', '10000000-0000-4000-8000-000000000007', 'BSNEd', 'Bachelor of Secondary Education major in Special Needs Education'),
  ('20000000-0000-4000-8000-000000000035', '10000000-0000-4000-8000-000000000001', 'BSChE', 'Bachelor of Science in Chemical Engineering'),
  ('20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'BSCE', 'Bachelor of Science in Civil Engineering'),
  ('20000000-0000-4000-8000-000000000036', '10000000-0000-4000-8000-000000000001', 'BSEE', 'Bachelor of Science in Electrical Engineering'),
  ('20000000-0000-4000-8000-000000000037', '10000000-0000-4000-8000-000000000001', 'BSECE', 'Bachelor of Science in Electronics Engineering'),
  ('20000000-0000-4000-8000-000000000038', '10000000-0000-4000-8000-000000000001', 'BSME', 'Bachelor of Science in Mechanical Engineering'),
  ('20000000-0000-4000-8000-000000000039', '10000000-0000-4000-8000-000000000001', 'BSPkgE', 'Bachelor of Science in Packaging Engineering'),
  ('20000000-0000-4000-8000-000000000040', '10000000-0000-4000-8000-000000000001', 'BSSE', 'Bachelor of Science in Software Engineering'),
  ('20000000-0000-4000-8000-000000000041', '10000000-0000-4000-8000-000000000008', 'BSHM', 'Bachelor of Science in Hospitality Management'),
  ('20000000-0000-4000-8000-000000000042', '10000000-0000-4000-8000-000000000008', 'BSTM', 'Bachelor of Science in Tourism Management'),
  ('20000000-0000-4000-8000-000000000043', '10000000-0000-4000-8000-000000000009', 'BSMLS', 'Bachelor of Science in Medical Laboratory Science'),
  ('20000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', 'BSN', 'Bachelor of Science in Nursing'),
  ('20000000-0000-4000-8000-000000000044', '10000000-0000-4000-8000-000000000010', 'BSPharm', 'Bachelor of Science in Pharmacy'),
  ('20000000-0000-4000-8000-000000000045', '10000000-0000-4000-8000-000000000011', 'JD', 'Juris Doctor'),
  ('20000000-0000-4000-8000-000000000046', '10000000-0000-4000-8000-000000000012', 'BSRT', 'Bachelor of Science in Respiratory Therapy'),
  ('20000000-0000-4000-8000-000000000047', '10000000-0000-4000-8000-000000000012', 'MD', 'Doctor of Medicine'),
  ('20000000-0000-4000-8000-000000000048', '10000000-0000-4000-8000-000000000013', 'BTh', 'Bachelor of Theology');

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM students student
     WHERE NOT EXISTS (
       SELECT 1
         FROM migration_012_programs desired
        WHERE desired.id = student.program_id
          AND desired.college_id = student.college_id
     )
  ) OR EXISTS (
    SELECT 1
      FROM schedule_batches batch
     WHERE (batch.college_id IS NOT NULL AND NOT EXISTS (
              SELECT 1 FROM migration_012_colleges desired WHERE desired.id = batch.college_id
           ))
        OR (batch.program_id IS NOT NULL AND NOT EXISTS (
              SELECT 1
                FROM migration_012_programs desired
               WHERE desired.id = batch.program_id
                 AND desired.college_id = batch.college_id
           ))
  ) THEN
    RAISE EXCEPTION 'Noncanonical college or program references remain. Run npm run db:reference-catalog-cleanup -- apply before migration.';
  END IF;
END
$$;

DELETE FROM programs existing
 WHERE NOT EXISTS (
   SELECT 1 FROM migration_012_programs desired WHERE desired.id = existing.id
 );

DELETE FROM colleges existing
 WHERE NOT EXISTS (
   SELECT 1 FROM migration_012_colleges desired WHERE desired.id = existing.id
 );

INSERT INTO colleges (id, code, name, is_active)
SELECT id, code, name, TRUE FROM migration_012_colleges
ON CONFLICT (id) DO UPDATE
SET code = EXCLUDED.code,
    name = EXCLUDED.name,
    is_active = TRUE;

INSERT INTO programs (id, college_id, code, name, is_active)
SELECT id, college_id, code, name, TRUE FROM migration_012_programs
ON CONFLICT (id) DO UPDATE
SET college_id = EXCLUDED.college_id,
    code = EXCLUDED.code,
    name = EXCLUDED.name,
    is_active = TRUE;

UPDATE coordinator_schedule_items
   SET priority_group_id = NULL
 WHERE priority_group_id IN (
   SELECT id
     FROM priority_groups
    WHERE id = '30000000-0000-4000-8000-000000000001'
       OR name = 'Graduating'
 );

DELETE FROM priority_groups
 WHERE id = '30000000-0000-4000-8000-000000000001'
    OR name = 'Graduating';

CREATE TEMP TABLE migration_012_priorities (
  id UUID PRIMARY KEY,
  name VARCHAR(80) NOT NULL,
  rank_order INTEGER NOT NULL
) ON COMMIT DROP;

INSERT INTO migration_012_priorities (id, name, rank_order)
VALUES
  ('30000000-0000-4000-8000-000000000002', 'OJT', 1),
  ('30000000-0000-4000-8000-000000000003', 'Tour', 2),
  ('30000000-0000-4000-8000-000000000004', 'Regular', 3);

WITH base AS (
  SELECT COALESCE(MAX(rank_order), 0) + 100 AS rank_order
    FROM priority_groups
)
INSERT INTO priority_groups (id, name, rank_order, is_active)
SELECT desired.id, desired.name, base.rank_order + desired.rank_order, TRUE
  FROM migration_012_priorities desired
 CROSS JOIN base
ON CONFLICT (id) DO UPDATE
SET name = EXCLUDED.name,
    is_active = TRUE;

WITH base AS (
  SELECT COALESCE(MAX(rank_order), 0) + 100 AS rank_order
    FROM priority_groups
)
UPDATE priority_groups existing
   SET rank_order = base.rank_order + desired.rank_order
  FROM migration_012_priorities desired
 CROSS JOIN base
 WHERE existing.id = desired.id;

UPDATE priority_groups existing
   SET rank_order = desired.rank_order
  FROM migration_012_priorities desired
 WHERE existing.id = desired.id;
