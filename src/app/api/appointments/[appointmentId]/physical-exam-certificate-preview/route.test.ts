// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
const { requireUser, previewPhysicalExam } = vi.hoisted(() => ({ requireUser: vi.fn(), previewPhysicalExam: vi.fn() }));
vi.mock("@/server/auth/current-user", () => ({ requireUser }));
vi.mock("@/server/medical-certificates/certificate.service", () => ({ previewPhysicalExam }));
import { POST } from "./route";
const id = "11111111-1111-4111-8111-111111111111";
const actor = { userId: "cpu", role: "CLINIC_STAFF" };
const call = (appointmentId = id) => POST(new Request("http://localhost/api/preview", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ attested: true }),
}), { params: Promise.resolve({ appointmentId }) });
describe("Physical Examination preview route", () => {
  beforeEach(() => { vi.clearAllMocks(); requireUser.mockResolvedValue(actor); });
  it("returns only private JPEG bytes through the preview service", async () => {
    const bytes = Buffer.from([255, 216, 255, 217]);
    previewPhysicalExam.mockResolvedValue(bytes);
    const response = await call();
    expect(response.headers.get("Content-Type")).toBe("image/jpeg");
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
    expect(requireUser).toHaveBeenCalledWith(["ADMIN", "CLINIC_STAFF"]);
    expect(previewPhysicalExam).toHaveBeenCalledWith(id, { attested: true }, actor);
  });
  it("rejects malformed UUIDs without rendering", async () => {
    expect((await call("bad")).status).toBe(404);
    expect(previewPhysicalExam).not.toHaveBeenCalled();
  });
});
