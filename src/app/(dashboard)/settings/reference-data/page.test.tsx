import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { listColleges, listPrograms } = vi.hoisted(() => ({
  listColleges: vi.fn(),
  listPrograms: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

vi.mock("@/server/repositories/reference-data.repository", () => ({
  listColleges,
  listPrograms,
}));

import ReferenceDataPage from "./page";

const colleges = [{
  id: "10000000-0000-4000-8000-000000000003",
  code: "CCS",
  name: "College of Computer Studies",
  isActive: true,
}];

const programs = [{
  id: "20000000-0000-4000-8000-000000000003",
  collegeId: colleges[0].id,
  collegeName: colleges[0].name,
  code: "BSIT",
  name: "Bachelor of Science in Information Technology",
  isActive: true,
}];

describe("ReferenceDataPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listColleges.mockResolvedValue(colleges);
    listPrograms.mockResolvedValue(programs);
  });

  it("loads and renders only academic reference values used for student imports", async () => {
    render(await ReferenceDataPage());

    expect(listColleges).toHaveBeenCalledOnce();
    expect(listPrograms).toHaveBeenCalledOnce();
    expect(screen.getByText(
      "Manage colleges and academic programs used for student imports.",
    )).toBeVisible();
    expect(screen.getByRole("heading", { name: "Colleges" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Programs" })).toBeVisible();
    expect(screen.queryByRole("heading", { name: "Priority groups" })).not.toBeInTheDocument();
  });
});
