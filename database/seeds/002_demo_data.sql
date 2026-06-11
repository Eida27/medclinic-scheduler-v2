INSERT INTO students (
  student_number, first_name, last_name, college_id, program_id, year_level, section
)
SELECT
  'DEMO-' || LPAD(value::text, 4, '0'),
  'Student',
  LPAD(value::text, 4, '0'),
  '10000000-0000-4000-8000-000000000003',
  '20000000-0000-4000-8000-000000000003',
  CASE WHEN value <= 40 THEN 4 ELSE ((value - 1) % 4) + 1 END,
  'A'
FROM generate_series(1, 180) AS value
ON CONFLICT (student_number) DO NOTHING;

INSERT INTO schedule_batches (
  id, batch_name, college_id, program_id, submitted_by_name, description, created_by
)
VALUES
  ('50000000-0000-4000-8000-000000000120', 'Demo Valid Capacity - 120', '10000000-0000-4000-8000-000000000003', '20000000-0000-4000-8000-000000000003', 'Demo Coordinator', 'Exactly at recommended capacity', '00000000-0000-4000-8000-000000000002'),
  ('50000000-0000-4000-8000-000000000130', 'Demo Warning Capacity - 130', '10000000-0000-4000-8000-000000000003', '20000000-0000-4000-8000-000000000003', 'Demo Coordinator', 'Above recommended capacity', '00000000-0000-4000-8000-000000000002'),
  ('50000000-0000-4000-8000-000000000160', 'Demo Conflict Capacity - 160', '10000000-0000-4000-8000-000000000003', '20000000-0000-4000-8000-000000000003', 'Demo Coordinator', 'Above maximum capacity', '00000000-0000-4000-8000-000000000002'),
  ('50000000-0000-4000-8000-000000000010', 'Demo Week Distribution', '10000000-0000-4000-8000-000000000003', '20000000-0000-4000-8000-000000000003', 'Demo Coordinator', 'Weekday balancing example', '00000000-0000-4000-8000-000000000002')
ON CONFLICT (id) DO NOTHING;

INSERT INTO coordinator_schedule_items (
  batch_id, student_number, schedule_type, priority_group_id, target_date, remarks
)
SELECT
  '50000000-0000-4000-8000-000000000120', student_number, 'PHYSICAL_EXAM',
  CASE WHEN year_level = 4 THEN '30000000-0000-4000-8000-000000000001'::uuid ELSE '30000000-0000-4000-8000-000000000004'::uuid END,
  DATE '2026-07-06', 'Valid capacity fixture'
FROM students WHERE student_number BETWEEN 'DEMO-0001' AND 'DEMO-0120'
ON CONFLICT DO NOTHING;

INSERT INTO coordinator_schedule_items (
  batch_id, student_number, schedule_type, priority_group_id, target_date, remarks
)
SELECT
  '50000000-0000-4000-8000-000000000130', student_number, 'LABORATORY',
  '30000000-0000-4000-8000-000000000004', DATE '2026-07-07', 'Warning capacity fixture'
FROM students WHERE student_number BETWEEN 'DEMO-0001' AND 'DEMO-0130'
ON CONFLICT DO NOTHING;

INSERT INTO coordinator_schedule_items (
  batch_id, student_number, schedule_type, priority_group_id, target_date, remarks
)
SELECT
  '50000000-0000-4000-8000-000000000160', student_number, 'PHYSICAL_EXAM',
  '30000000-0000-4000-8000-000000000004', DATE '2026-07-08', 'Conflict capacity fixture'
FROM students WHERE student_number BETWEEN 'DEMO-0001' AND 'DEMO-0160'
ON CONFLICT DO NOTHING;

INSERT INTO coordinator_schedule_items (
  batch_id, student_number, schedule_type, priority_group_id, target_week_start, target_week_end, remarks
)
SELECT
  '50000000-0000-4000-8000-000000000010', student_number, 'BOTH',
  CASE WHEN year_level = 4 THEN '30000000-0000-4000-8000-000000000001'::uuid ELSE '30000000-0000-4000-8000-000000000004'::uuid END,
  DATE '2026-07-13', DATE '2026-07-17', 'Week distribution fixture'
FROM students WHERE student_number BETWEEN 'DEMO-0161' AND 'DEMO-0180'
ON CONFLICT DO NOTHING;
