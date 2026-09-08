// This configuration is public test data. Never load application secrets in tests.
export const syntheticTestEnvironment = {
  DATABASE_URL: "postgresql://unit:unit@127.0.0.1:1/medclinic_unit_no_database",
  JWT_SECRET: "synthetic-unit-jwt-secret-at-least-32-characters",
  EMAIL_OUTBOX_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  APP_URL: "http://localhost:3000",
  APP_TIMEZONE: "Asia/Manila",
  SMTP_HOST: "",
  SMTP_PORT: "587",
  SMTP_USER: "",
  SMTP_PASS: "",
  SMTP_FROM: "",
  RESULT_UPLOAD_ROOT: ".data/test-result-uploads",
};

export const fixtureConsentFlags = [
  "REFERENCE_CATALOG_CLEANUP_INTEGRATION_EXCLUSIVE_DATABASE",
  "STUDENT_EMAIL_NOTIFICATIONS_ACCEPTANCE_EXCLUSIVE_DATABASE",
  "STUDENT_RESULT_EDITING_ACCEPTANCE_EXCLUSIVE_DATABASE",
  "REPORTS_ACCEPTANCE_EXCLUSIVE_DATABASE",
];
