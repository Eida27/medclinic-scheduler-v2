import { z } from "zod";
import { runInstallationPreflight } from "./installation-preflight";

const environment = z.object({
  BOOTSTRAP_ADMIN_FULL_NAME: z.string().min(1),
  BOOTSTRAP_ADMIN_EMAIL: z.string().min(1),
  BOOTSTRAP_ADMIN_TEMPORARY_PASSWORD: z.string().min(1),
}).parse(process.env);

await runInstallationPreflight();
const { bootstrapFirstAdministrator } = await import(
  "../src/server/services/staff-bootstrap.service"
);
const administrator = await bootstrapFirstAdministrator({
  fullName: environment.BOOTSTRAP_ADMIN_FULL_NAME,
  email: environment.BOOTSTRAP_ADMIN_EMAIL,
  temporaryPassword: environment.BOOTSTRAP_ADMIN_TEMPORARY_PASSWORD,
});

console.log(`Bootstrap Administrator created for ${administrator.email}. Complete email verification and temporary-password replacement before use.`);
