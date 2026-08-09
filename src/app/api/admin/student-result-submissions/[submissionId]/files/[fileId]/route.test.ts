// @vitest-environment node
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/errors";

const {
  getAccessibleAdminResultFileRow,
  getAccessibleStudentResultFileRow,
  read,
  requireUser,
  writeAudit,
} = vi.hoisted(() => ({
  getAccessibleAdminResultFileRow: vi.fn(),
  getAccessibleStudentResultFileRow: vi.fn(),
  read: vi.fn(),
  requireUser: vi.fn(),
  writeAudit: vi.fn(),
}));

vi.mock("@/server/auth/current-user", () => ({ requireUser }));
vi.mock("@/server/repositories/student-result-submissions.repository", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/server/repositories/student-result-submissions.repository")>(),
  getAccessibleAdminResultFileRow,
  getAccessibleStudentResultFileRow,
}));
vi.mock("@/server/storage/local-result-storage", () => ({
  localResultStorage: { read },
}));
vi.mock("@/server/repositories/audit.repository", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/server/repositories/audit.repository")>(),
  writeAudit,
}));

import { getStudentResultFile } from "@/server/services/student-result-submissions.service";
import { GET } from "./route";

const admin = {
  userId: "admin-id",
  fullName: "System Admin",
  email: "admin@medclinic.local",
  role: "ADMIN" as const,
};
const submissionId = "10000000-0000-4000-8000-000000000001";
const fileId = "20000000-0000-4000-8000-000000000002";
const bytes = Buffer.from("superseded official result");
const metadata = {
  id: fileId,
  submissionId,
  storageKey: `results/${submissionId}/${fileId}.pdf`,
  originalFilename: "superseded-result.pdf",
  detectedMimeType: "application/pdf",
  byteSize: bytes.byteLength,
  checksumSha256: createHash("sha256").update(bytes).digest("hex"),
};
const context = { params: Promise.resolve({ submissionId, fileId }) };

describe("GET /api/admin/student-result-submissions/[submissionId]/files/[fileId]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireUser.mockResolvedValue(admin);
    getAccessibleAdminResultFileRow.mockResolvedValue(metadata);
    getAccessibleStudentResultFileRow.mockResolvedValue(null);
    read.mockResolvedValue(bytes);
  });

  it("downloads an addressed superseded official file for an administrator", async () => {
    const response = await GET(new Request("http://localhost/admin-result"), context);

    expect(response.status).toBe(200);
    expect(requireUser).toHaveBeenCalledWith(["ADMIN"]);
    expect(getAccessibleAdminResultFileRow).toHaveBeenCalledWith(fileId, submissionId);
    expect(getAccessibleStudentResultFileRow).not.toHaveBeenCalled();
    expect(response.headers.get("content-type")).toBe("application/pdf");
    expect(response.headers.get("content-disposition"))
      .toBe("attachment; filename*=UTF-8''superseded-result.pdf");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
    expect(writeAudit).toHaveBeenCalledWith(
      admin.userId,
      "ADMIN_RESULT_FILE_DOWNLOADED",
      "student_result_file",
      fileId,
      { submissionId },
    );
  });

  it.each(["COORDINATOR", "CLINIC_STAFF"] as const)(
    "denies %s before reading protected result metadata",
    async (role) => {
      requireUser.mockRejectedValue(new AppError(
        "FORBIDDEN",
        `${role} cannot download administrator result documents.`,
        403,
      ));

      const response = await GET(new Request("http://localhost/admin-result"), context);

      expect(response.status).toBe(403);
      expect(getAccessibleAdminResultFileRow).not.toHaveBeenCalled();
      expect(read).not.toHaveBeenCalled();
    },
  );

  it("keeps an unrelated student denied by the current-finalized student query", async () => {
    await expect(getStudentResultFile(
      "23/9999 99",
      fileId,
      { read, write: vi.fn(), delete: vi.fn() },
    )).rejects.toMatchObject({ code: "RESULT_FILE_NOT_FOUND", status: 404 });

    expect(getAccessibleStudentResultFileRow).toHaveBeenCalledWith(fileId, "23/9999 99");
    expect(getAccessibleAdminResultFileRow).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });
});
