import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { PhysicianProfiles } from "./PhysicianProfiles";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
afterEach(() => vi.unstubAllGlobals());

it("reports a saved physician without accessing the submit event after the request", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
    ok: true,
    headers: { get: () => "application/json" },
    json: async () => ({ data: { displayName: "Dr. Synthetic Test" } }),
  }));
  render(<PhysicianProfiles profiles={[]} />);
  fireEvent.change(screen.getByRole("textbox", { name: "Physician name" }), { target: { value: "Dr. Synthetic Test" } });
  fireEvent.change(screen.getByRole("textbox", { name: "License number" }), { target: { value: "TEST-1" } });
  fireEvent.change(screen.getByLabelText(/Authorized signature/), { target: { files: [new File(["png"], "signature.png", { type: "image/png" })] } });
  fireEvent.submit(screen.getByRole("button", { name: "Save physician" }).closest("form")!);
  await waitFor(() => expect(screen.getByText("Saved Dr. Synthetic Test profile revision.")).toBeVisible());
  expect(screen.queryByText(/Cannot read properties of null/)).not.toBeInTheDocument();
});
