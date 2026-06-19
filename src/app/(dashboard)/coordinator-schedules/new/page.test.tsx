import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const { priorities } = vi.hoisted(() => ({
  priorities: [{ id: "priority", name: "Regular", rankOrder: 4, isActive: true }],
}));

vi.mock("@/server/repositories/reference-data.repository", () => ({
  listColleges: vi.fn().mockResolvedValue([]),
  listPrograms: vi.fn().mockResolvedValue([]),
  listPriorityGroups: vi.fn().mockResolvedValue(priorities),
}));
vi.mock("@/components/schedules/ScheduleBatchForm", () => ({
  ScheduleBatchForm: () => <div>Manual schedule encoder</div>,
}));
vi.mock("@/components/schedules/ScheduleCsvImportForm", () => ({
  ScheduleCsvImportForm: ({ priorities: received }: { priorities: typeof priorities }) => (
    <div>CSV importer with {received[0].name}</div>
  ),
}));

import NewScheduleBatchPage from "./page";

describe("NewScheduleBatchPage", () => {
  it("offers CSV import and manual schedule encoding", async () => {
    render(await NewScheduleBatchPage());
    expect(screen.getByText("CSV importer with Regular")).toBeVisible();
    expect(screen.getByText("Manual schedule encoder")).toBeVisible();
  });
});
