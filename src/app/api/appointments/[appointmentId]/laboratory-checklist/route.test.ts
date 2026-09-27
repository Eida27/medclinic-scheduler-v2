// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
const { requireUser, getLaboratoryChecklist, setLaboratoryTestVerification } = vi.hoisted(() => ({
  requireUser: vi.fn(),
  getLaboratoryChecklist: vi.fn(),
  setLaboratoryTestVerification: vi.fn(),
}));
vi.mock("@/server/auth/current-user", () => ({ requireUser }));
vi.mock("@/server/laboratory/laboratory-checklist.service", () => ({ getLaboratoryChecklist, setLaboratoryTestVerification }));
import { GET, PATCH } from "./route";

const id = "11111111-1111-4111-8111-111111111111";
const actor = { userId: "staff", role: "CLINIC_STAFF" };
const context = { params: Promise.resolve({ appointmentId: id }) };

describe("Laboratory checklist API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireUser.mockResolvedValue(actor);
    getLaboratoryChecklist.mockResolvedValue({ version: 1, verifiedCount: 0 });
    setLaboratoryTestVerification.mockResolvedValue({ version: 2, verifiedCount: 1 });
  });

  it("requires clinical staff and returns authoritative checklist progress", async () => {
    const response = await GET(new Request(`http://localhost/api/appointments/${id}/laboratory-checklist`), context);
    expect(response.status).toBe(200);
    expect(requireUser).toHaveBeenCalledWith(["ADMIN", "CLINIC_STAFF"]);
    expect(getLaboratoryChecklist).toHaveBeenCalledWith(id, actor);
  });

  it("rejects malformed IDs before invoking the mutation service", async () => {
    const response = await PATCH(new Request("http://localhost/api/appointments/bad/laboratory-checklist", {
      method: "PATCH", body: JSON.stringify({ testCode: "CBC", checked: true, expectedVersion: 1 }),
    }), { params: Promise.resolve({ appointmentId: "bad" }) });
    expect(response.status).toBe(404);
    expect(setLaboratoryTestVerification).not.toHaveBeenCalled();
  });
});
