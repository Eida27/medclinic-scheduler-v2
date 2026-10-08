// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/errors";
const { requireUser, completePhysicalExam } = vi.hoisted(() => ({ requireUser: vi.fn(), completePhysicalExam: vi.fn() }));
vi.mock("@/server/auth/current-user", () => ({ requireUser }));
vi.mock("@/server/medical-certificates/certificate.service", () => ({ completePhysicalExam }));
import { POST } from "./route";
const id = "11111111-1111-4111-8111-111111111111";
const actor = { userId: "cpu", role: "CLINIC_STAFF" };
const input = { requestId: id, attested: true };
const call = (appointmentId = id) => POST(new Request("http://localhost/api/complete", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input),
}), { params: Promise.resolve({ appointmentId }) });
describe("complete Physical Examination route", () => {
  beforeEach(() => { vi.clearAllMocks(); requireUser.mockResolvedValue(actor); });
  it("returns the existing private outcome through the clinical service", async () => {
    const outcome = { certificateId: "certificate", revisionId: "revision", appointmentId: id, certificateNumber: "MC-1" };
    completePhysicalExam.mockResolvedValue(outcome);
    const response = await call();
    expect(await response.json()).toEqual({ data: outcome });
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(requireUser).toHaveBeenCalledWith(["ADMIN", "CLINIC_STAFF"]);
    expect(completePhysicalExam).toHaveBeenCalledWith(id, input, actor);
  });
  it("rejects invalid UUIDs before issuance", async () => {
    expect((await call("bad")).status).toBe(404);
    expect(completePhysicalExam).not.toHaveBeenCalled();
  });
  it("preserves a stale clinical conflict", async () => {
    completePhysicalExam.mockRejectedValue(new AppError("EXAMINATION_STALE", "Refresh and review the details.", 409));
    const response = await call();
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "EXAMINATION_STALE" } });
  });
});
