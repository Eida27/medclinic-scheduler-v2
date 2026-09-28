import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { ManualResolutionDatePicker } from "./ManualResolutionDatePicker";

afterEach(() => vi.unstubAllGlobals());

it("shows capacity and labels, and permits only available dates", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: {
    month: "2026-10", service: "LABORATORY", required: 2,
    days: [
      { date: "2026-10-01", state: "AVAILABLE", issues: [], capacity: [{ clinicId: "clinic", used: 3, maximum: 8, available: 5, required: 2, projected: 5 }] },
      { date: "2026-10-02", state: "FULL", issues: [], capacity: [{ clinicId: "clinic", used: 8, maximum: 8, available: 0, required: 2, projected: 10 }] },
    ],
  } }), { status: 200 })));
  const choose = vi.fn();
  render(<ManualResolutionDatePicker service="LABORATORY" cases={[{ caseId: "one", expectedOptimisticToken: "token" }]}
    replaceRelatedServices={false} value="" onChange={choose} initialMonth="2026-10" />);
  expect(await screen.findByRole("button", { name: /2026-10-01.*Available.*3 used.*8 maximum.*5 available.*2 seats required/ })).toBeEnabled();
  expect(screen.getByRole("button", { name: /2026-10-02.*Full/ })).toBeDisabled();
  await userEvent.setup().click(screen.getByRole("button", { name: /2026-10-01.*Available/ }));
  expect(choose).toHaveBeenCalledWith("2026-10-01");
});
