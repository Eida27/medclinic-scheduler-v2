// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const { requireUser, loadPhysicalExamCompletionContext } = vi.hoisted(() => ({
  requireUser: vi.fn(), loadPhysicalExamCompletionContext: vi.fn(),
}));
vi.mock("@/server/auth/current-user", () => ({ requireUser }));
vi.mock("@/server/medical-certificates/physical-exam-completion-context.service", () => ({ loadPhysicalExamCompletionContext }));
import { GET } from "./route";

const id = "11111111-1111-4111-8111-111111111111";
const actor = { userId: "staff", role: "CLINIC_STAFF", clinicCode: "CPU_CLINIC" };

describe("Physical Examination completion context API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireUser.mockResolvedValue(actor);
    loadPhysicalExamCompletionContext.mockResolvedValue({ appointmentId: id, blockers: [] });
  });

  it("requires clinical authorization and returns a private, uncached context", async () => {
    const response = await GET(new Request(`http://localhost/api/appointments/${id}/physical-exam-completion-context`),
      { params: Promise.resolve({ appointmentId: id }) });
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(requireUser).toHaveBeenCalledWith(["ADMIN", "CLINIC_STAFF"]);
    expect(loadPhysicalExamCompletionContext).toHaveBeenCalledWith(id, actor);
    expect(await response.json()).toEqual({ data: { appointmentId: id, blockers: [] } });
  });

  it("rejects malformed IDs without reading student context", async () => {
    const response = await GET(new Request("http://localhost/api/appointments/bad/physical-exam-completion-context"),
      { params: Promise.resolve({ appointmentId: "bad" }) });
    expect(response.status).toBe(404);
    expect(loadPhysicalExamCompletionContext).not.toHaveBeenCalled();
  });
});
