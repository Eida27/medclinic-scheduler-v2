import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { connection, events, listColleges, listPrograms, requireUser } = vi.hoisted(() => ({
  connection: vi.fn(),
  events: [] as string[],
  listColleges: vi.fn(),
  listPrograms: vi.fn(),
  requireUser: vi.fn(),
}));

vi.mock("next/server", () => ({ connection }));

vi.mock("@/server/auth/current-user", () => ({ requireUser }));

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
    events.length = 0;
    connection.mockImplementation(async () => { events.push("connection"); });
    requireUser.mockImplementation(async () => {
      events.push("authorization");
      return { userId: "admin", role: "ADMIN" };
    });
    listColleges.mockImplementation(async () => {
      events.push("colleges");
      return colleges;
    });
    listPrograms.mockImplementation(async () => {
      events.push("programs");
      return programs;
    });
  });

  it("enters request time and authorizes an Administrator before reference-data reads", async () => {
    render(await ReferenceDataPage());

    expect(events).toEqual(["connection", "authorization", "colleges", "programs"]);
    expect(connection).toHaveBeenCalledOnce();
    expect(requireUser).toHaveBeenCalledWith(["ADMIN"]);
    expect(listColleges).toHaveBeenCalledOnce();
    expect(listPrograms).toHaveBeenCalledOnce();
    expect(screen.getByText(
      "Manage colleges and academic programs used for student imports.",
    )).toBeVisible();
    expect(screen.getByRole("heading", { name: "Colleges" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Programs" })).toBeVisible();
    expect(screen.queryByRole("heading", { name: "Priority groups" })).not.toBeInTheDocument();
  });

  it("does not read reference data when Administrator authorization fails", async () => {
    requireUser.mockRejectedValueOnce(new Error("denied"));

    await expect(ReferenceDataPage()).rejects.toThrow("denied");

    expect(connection).toHaveBeenCalledOnce();
    expect(listColleges).not.toHaveBeenCalled();
    expect(listPrograms).not.toHaveBeenCalled();
  });
});
