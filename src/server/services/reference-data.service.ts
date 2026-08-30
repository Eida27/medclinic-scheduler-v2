import "server-only";
import { z } from "zod";
import { AppError, isPostgresForeignKeyViolation, isPostgresUniqueViolation } from "@/lib/errors";
import { transaction } from "@/server/db/pool";
import { writeAudit } from "@/server/repositories/audit.repository";
import { createReference, deleteReference, updateReference } from "@/server/repositories/reference-data.repository";

const collegeSchema = z.object({ code: z.string().trim().min(2).max(30), name: z.string().trim().min(2).max(150) });
const programSchema = collegeSchema.extend({ collegeId: z.string().uuid() });
const deleteSchema = z.object({ id: z.string().uuid() });
const referenceTypeSchema = z.enum(["college", "program"]);
type ReferenceType = z.infer<typeof referenceTypeSchema>;

function schemaFor(type: ReferenceType) {
  return type === "college" ? collegeSchema : programSchema;
}

export async function addReference(rawType: ReferenceType, raw: unknown, actorUserId: string) {
  const type = referenceTypeSchema.parse(rawType);
  const input = schemaFor(type).parse(raw);
  try {
    const result = await createReference(type, input);
    await writeAudit(actorUserId, "REFERENCE_CREATED", type, String(result.id));
    return result;
  } catch (error) {
    if (isPostgresUniqueViolation(error)) throw new AppError("DUPLICATE_REFERENCE", "That reference value already exists.", 409);
    throw error;
  }
}

export async function editReference(rawType: ReferenceType, raw: unknown, actorUserId: string) {
  const type = referenceTypeSchema.parse(rawType);
  const input = schemaFor(type).extend({ id: z.string().uuid(), isActive: z.boolean() }).parse(raw);
  try {
    const result = await updateReference(type, input);
    if (!result) throw new AppError("REFERENCE_NOT_FOUND", "Reference value not found.", 404);
    await writeAudit(actorUserId, "REFERENCE_UPDATED", type, String(result.id));
    return result;
  } catch (error) {
    if (isPostgresUniqueViolation(error)) throw new AppError("DUPLICATE_REFERENCE", "That reference value already exists.", 409);
    throw error;
  }
}

export async function removeReference(
  rawType: ReferenceType,
  raw: unknown,
  actorUserId: string,
) {
  const type = referenceTypeSchema.parse(rawType);
  const { id } = deleteSchema.parse(raw);
  return transaction(async (client) => {
    let result;
    try {
      result = await deleteReference(type, id, client);
    } catch (error) {
      if (isPostgresForeignKeyViolation(error)) {
        throw new AppError(
          "REFERENCE_IN_USE",
          "This reference value is already in use and cannot be deleted.",
          409,
        );
      }
      throw error;
    }

    if (!result) throw new AppError("REFERENCE_NOT_FOUND", "Reference value not found.", 404);
    await writeAudit(actorUserId, "REFERENCE_DELETED", type, id, {}, client);
    return { success: true as const };
  });
}
