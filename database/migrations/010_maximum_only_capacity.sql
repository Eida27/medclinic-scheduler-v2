BEGIN;

UPDATE clinic_capacity_settings
SET safe_daily_capacity = max_daily_capacity
WHERE safe_daily_capacity <> max_daily_capacity;

COMMENT ON COLUMN clinic_capacity_settings.safe_daily_capacity IS
  'Deprecated compatibility column. Must equal max_daily_capacity.';

COMMIT;
