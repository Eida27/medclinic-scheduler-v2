ALTER TABLE clinic_capacity_settings
  ADD CONSTRAINT clinic_capacity_settings_max_daily_capacity_positive
    CHECK (max_daily_capacity > 0);

ALTER TABLE clinic_capacity_settings
  DROP CONSTRAINT clinic_capacity_settings_check,
  DROP COLUMN safe_daily_capacity;
