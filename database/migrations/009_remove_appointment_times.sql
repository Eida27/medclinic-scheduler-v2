CREATE OR REPLACE FUNCTION default_appointment_schedule_cycle_start()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.schedule_cycle_start IS NULL THEN
    NEW.schedule_cycle_start := CASE
      WHEN EXTRACT(MONTH FROM NEW.appointment_date) >= 8
        THEN EXTRACT(YEAR FROM NEW.appointment_date)::INTEGER
      ELSE EXTRACT(YEAR FROM NEW.appointment_date)::INTEGER - 1
    END;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER appointments_default_schedule_cycle_start
  BEFORE INSERT OR UPDATE OF appointment_date, schedule_cycle_start ON appointments
  FOR EACH ROW EXECUTE FUNCTION default_appointment_schedule_cycle_start();

ALTER TABLE appointments DROP COLUMN appointment_time;
