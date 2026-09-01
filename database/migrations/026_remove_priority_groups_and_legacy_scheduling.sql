ALTER TABLE coordinator_schedule_items
  DROP CONSTRAINT IF EXISTS coordinator_schedule_items_priority_group_id_fkey;

ALTER TABLE coordinator_schedule_items
  DROP COLUMN IF EXISTS priority_group_id;

DROP TRIGGER IF EXISTS priority_groups_updated_at ON priority_groups;

DROP TABLE IF EXISTS priority_groups;
