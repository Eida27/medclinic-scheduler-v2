// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/errors";
const { downloadMedicalCertificate, requireStudent, requireVerifiedStudent } = vi.hoisted(() => ({
  downloadMedicalCertificate: vi.fn(), requireStudent: vi.fn(), requireVerifiedStudent: vi.fn(),
}));
vi.mock("@/server/auth/current-student", () => ({ requireStudent, requireVerifiedStudent }));
vi.mock("@/server/medical-certificates/certificate.service", () => ({ downloadMedicalCertificate }));
import { GET } from "./route";
const certificateId = "10000000-0000-4000-8000-000000000001";
const request = () => new Request("http://localhost/certificate");
describe("student certificate download authorization", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    requireStudent.mockResolvedValue({ studentNumber: "24-0001", studentName: "Student, Test", email: null, emailVerifiedAt: null });
    requireVerifiedStudent.mockRejectedValue(new AppError("STUDENT_EMAIL_VERIFICATION_REQUIRED", "Verify email.", 403));
  });
  it("downloads an issued certificate before email verification with scoped authorization and private headers", async () => {
    downloadMedicalCertificate.mockResolvedValue({ bytes: Buffer.from([255, 216, 255]), studentNumber: "24/0001\"" });
    const response = await GET(request(), { params: Promise.resolve({ certificateId }) });
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(Uint8Array.from([255, 216, 255]));
    expect(downloadMedicalCertificate).toHaveBeenCalledWith(certificateId, { kind: "STUDENT", studentNumber: "24-0001" });
    expect(response.headers.get("content-type")).toBe("image/jpeg");
    expect(response.headers.get("content-disposition")).toBe('attachment; filename="medical-certificate-240001.jpg"');
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });
  it("rejects malformed certificate ids before the service", async () => {
    const response = await GET(request(), { params: Promise.resolve({ certificateId: "malformed" }) });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: { code: "CERTIFICATE_NOT_FOUND", message: "Certificate not found." } });
    expect(downloadMedicalCertificate).not.toHaveBeenCalled();
  });
  it.each([[404, "CERTIFICATE_NOT_FOUND"], [410, "CERTIFICATE_REVOKED"]])("preserves ownership/latest/revocation service denial %s", async (status, code) => {
    downloadMedicalCertificate.mockRejectedValue(new AppError(code, "Certificate unavailable.", status));
    const response = await GET(request(), { params: Promise.resolve({ certificateId }) });
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error: { code, message: "Certificate unavailable." } });
  });
  it("rejects unauthenticated requests before certificate access", async () => {
    const error = new AppError("UNAUTHENTICATED", "Sign in.", 401);
    requireStudent.mockRejectedValue(error); requireVerifiedStudent.mockRejectedValue(error);
    const response = await GET(request(), { params: Promise.resolve({ certificateId }) });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: { code: "UNAUTHENTICATED", message: "Sign in." } });
    expect(downloadMedicalCertificate).not.toHaveBeenCalled();
  });
});
