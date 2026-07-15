import "server-only";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { AppError, isPostgresUniqueViolation } from "@/lib/errors";
import { writeAudit } from "@/server/repositories/audit.repository";
import { insertUser, listUsers, updateUserRecord } from "@/server/repositories/users.repository";

export const userSchema = z.object({
  fullName: z.string().trim().min(2).max(150),
  email: z.string().trim().toLowerCase().email().max(150),
  role: z.enum(["ADMIN", "COORDINATOR", "CLINIC_STAFF"]),
  clinicCode: z.union([z.enum(["KABALAKA_CLINIC", "CPU_CLINIC"]), z.literal(""), z.null(), z.undefined()])
    .transform((value) => value || null),
}).superRefine((input, context) => {
  if (input.role === "CLINIC_STAFF" && !input.clinicCode) {
    context.addIssue({ code: "custom", path: ["clinicCode"], message: "Clinic staff must be assigned to a clinic." });
  }
  if (input.role === "COORDINATOR" && input.clinicCode) {
    context.addIssue({ code: "custom", path: ["clinicCode"], message: "Coordinator accounts must be global." });
  }
});

export async function createUser(raw: unknown, actorUserId: string) {
  const input = userSchema.extend({ password: z.string().min(8).max(100) }).parse(raw);
  try {
    const user = await insertUser({ ...input, passwordHash: await bcrypt.hash(input.password, 12) });
    await writeAudit(actorUserId, "USER_CREATED", "user", user?.id ?? null, { role: input.role });
    return user;
  } catch (error) {
    if (isPostgresUniqueViolation(error)) throw new AppError("DUPLICATE_USER", "That email address is already in use.", 409);
    throw error;
  }
}

export async function updateUser(raw: unknown, actorUserId: string) {
  const input = userSchema.extend({
    id: z.string().uuid(),
    isActive: z.boolean(),
    password: z.union([z.string().min(8).max(100), z.literal(""), z.undefined()]),
  }).parse(raw);
  if (input.id === actorUserId && !input.isActive) throw new AppError("SELF_DEACTIVATION", "You cannot deactivate your own account.", 422);
  const passwordHash = input.password ? await bcrypt.hash(input.password, 12) : undefined;
  try {
    const user = await updateUserRecord({ ...input, passwordHash });
    if (!user) throw new AppError("USER_NOT_FOUND", "User not found.", 404);
    await writeAudit(actorUserId, "USER_UPDATED", "user", input.id, { role: input.role, isActive: input.isActive });
    return user;
  } catch (error) {
    if (isPostgresUniqueViolation(error)) throw new AppError("DUPLICATE_USER", "That email address is already in use.", 409);
    throw error;
  }
}

export { listUsers };
