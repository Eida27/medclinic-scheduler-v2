BEGIN;

ALTER TABLE schedule_import_groups
  DROP CONSTRAINT IF EXISTS schedule_import_groups_student_category_check;
ALTER TABLE schedule_import_groups
  ADD CONSTRAINT schedule_import_groups_student_category_check CHECK (
    student_category IN ('REGULAR','OJT','TOUR')
  );

ALTER TABLE appointments
  DROP CONSTRAINT IF EXISTS appointments_scheduling_category_check;
ALTER TABLE appointments
  ADD CONSTRAINT appointments_scheduling_category_check CHECK (
    scheduling_category IN ('REGULAR','OJT','TOUR')
  );

COMMIT;
