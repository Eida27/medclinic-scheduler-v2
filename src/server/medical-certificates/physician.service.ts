import "server-only";
import sharp from "sharp";
import type { PoolClient } from "pg";
import { AppError } from "@/lib/errors";
import { pool, transaction } from "@/server/db/pool";
import { physicianRevisionSchema } from "@/server/medical-certificates/certificate-schema";
import { writeAudit } from "@/server/repositories/audit.repository";
import type { SessionUser } from "@/types/roles";

type PhysicianRow = {
  id: string;
  version: number;
  active: boolean;
  displayName: string;
  licenseNumber: string;
  specialty: string | null;
};

async function assertCurrentAdmin(client: PoolClient, actor: SessionUser) {
  const result = await client.query<{ role: string; fullName: string; credentialVersion: number; verified: boolean; mustChangePassword: boolean }>(
    `SELECT role,full_name AS "fullName",credential_version AS "credentialVersion",
            email_verified_at IS NOT NULL AS verified,must_change_password AS "mustChangePassword"
       FROM users WHERE id=$1 AND deleted_at IS NULL FOR SHARE`, [actor.userId],
  );
  const current = result.rows[0];
  if (!current || (actor.credentialVersion !== undefined && current.credentialVersion !== actor.credentialVersion)) {
    throw new AppError("SESSION_EXPIRED", "Your session is no longer active.", 401);
  }
  if (current.role !== "ADMIN" || !current.verified || current.mustChangePassword) {
    throw new AppError("FORBIDDEN", "Only an active Administrator can configure physicians.", 403);
  }
  return current;
}

export async function listPhysicians(actor: SessionUser, includeInactive = false): Promise<PhysicianRow[]> {
  if (actor.role !== "ADMIN" && (actor.role !== "CLINIC_STAFF" || actor.clinicCode !== "CPU_CLINIC")) {
    throw new AppError("FORBIDDEN", "You cannot view physician profiles.", 403);
  }
  const result = await pool.query<PhysicianRow>(`SELECT physician.id::text,physician.version,physician.active,
       revision.display_name AS "displayName",revision.license_number AS "licenseNumber",
       revision.specialty
     FROM medical_certificate_physicians physician
     JOIN medical_certificate_physician_revisions revision
       ON revision.physician_id=physician.id AND revision.version=physician.version
    WHERE ($1::boolean OR physician.active=TRUE)
    ORDER BY revision.display_name,physician.id`, [includeInactive && actor.role === "ADMIN"]);
  return result.rows;
}

export async function normalizePhysicianSignature(bytes: Buffer, mediaType: string): Promise<Buffer> {
  if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > 1024 * 1024
      || !["image/png", "image/jpeg"].includes(mediaType)) {
    throw new AppError("SIGNATURE_INVALID", "Upload a PNG or JPEG signature up to 1 MiB.", 422);
  }
  let metadata: { width?: number; height?: number; format?: string };
  try { metadata = await sharp(bytes, { failOn: "error", limitInputPixels: 4_000_000 }).metadata(); }
  catch { throw new AppError("SIGNATURE_INVALID", "The signature image could not be decoded.", 422); }
  if (!metadata.width || !metadata.height || metadata.width * metadata.height > 4_000_000
      || (mediaType === "image/png" && metadata.format !== "png")
      || (mediaType === "image/jpeg" && metadata.format !== "jpeg")) {
    throw new AppError("SIGNATURE_INVALID", "The signature must be a valid PNG or JPEG under four megapixels.", 422);
  }
  const raster = await sharp(bytes, { failOn: "error", limitInputPixels: 4_000_000 })
    .rotate().resize({ width: 1600, height: 800, fit: "inside", withoutEnlargement: true })
    .ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const normalized = await sharp(raster.data, { raw: raster.info })
    .png({ compressionLevel: 9 }).toBuffer();
  if (normalized.length > 8 * 1024 * 1024) {
    throw new AppError("SIGNATURE_INVALID", "The normalized signature is too large.", 422);
  }
  return normalized;
}

export async function savePhysicianRevision(input: {
  physicianId?: string;
  expectedVersion?: number;
  profile: unknown;
  signatureBytes?: Buffer;
  signatureMediaType?: string;
}, actor: SessionUser): Promise<PhysicianRow> {
  const profile = physicianRevisionSchema.parse(input.profile);
  const signature = input.signatureBytes
    ? await normalizePhysicianSignature(input.signatureBytes, input.signatureMediaType ?? "")
    : null;
  if (!input.physicianId && !signature) {
    throw new AppError("SIGNATURE_REQUIRED", "Upload the physician's authorized signature.", 422);
  }
  return transaction(async (client) => {
    const current = await assertCurrentAdmin(client, actor);
    let physicianId = input.physicianId;
    let version = 1;
    let signatureBytes = signature;
    if (physicianId) {
      const previous = await client.query<{ version: number; signatureBytes: Buffer }>(`SELECT physician.version,
        revision.signature_bytes AS "signatureBytes"
        FROM medical_certificate_physicians physician
        JOIN medical_certificate_physician_revisions revision
          ON revision.physician_id=physician.id AND revision.version=physician.version
        WHERE physician.id=$1 FOR UPDATE OF physician`, [physicianId]);
      if (!previous.rows[0]) throw new AppError("PHYSICIAN_NOT_FOUND", "Physician profile not found.", 404);
      if (previous.rows[0].version !== input.expectedVersion) {
        throw new AppError("PHYSICIAN_STALE", "This physician profile changed. Reload and try again.", 409);
      }
      version = previous.rows[0].version + 1;
      signatureBytes ??= previous.rows[0].signatureBytes;
      await client.query(`UPDATE medical_certificate_physicians
        SET version=$2,active=$3,updated_at=clock_timestamp() WHERE id=$1`,
      [physicianId, version, profile.active]);
    } else {
      const created = await client.query<{ id: string }>(`INSERT INTO medical_certificate_physicians (active)
        VALUES ($1) RETURNING id::text`, [profile.active]);
      physicianId = created.rows[0].id;
    }
    await client.query(`INSERT INTO medical_certificate_physician_revisions
      (physician_id,version,display_name,license_number,specialty,signature_bytes,
       signature_media_type,active,actor_user_id,actor_snapshot)
      VALUES ($1,$2,$3,$4,$5,$6,'image/png',$7,$8,$9::jsonb)`,
    [physicianId, version, profile.displayName, profile.licenseNumber,
      profile.specialty || null, signatureBytes, profile.active, actor.userId,
      JSON.stringify({ fullName: current.fullName, role: current.role, deleted: false })]);
    await writeAudit(actor.userId, "MEDICAL_CERTIFICATE_PHYSICIAN_CONFIGURED", "physician", physicianId,
      { physicianId, version, active: profile.active }, client);
    return { id: physicianId!, version, active: profile.active,
      displayName: profile.displayName, licenseNumber: profile.licenseNumber,
      specialty: profile.specialty || null };
  });
}
