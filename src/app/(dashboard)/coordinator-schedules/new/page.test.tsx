import { describe, expect, it, vi } from "vitest";

const { redirect } = vi.hoisted(() => ({ redirect: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect }));

import NewScheduleBatchPage from "./page";

describe("NewScheduleBatchPage", () => {
  it("redirects the retired creation workflow to the master importer", async () => {
    await NewScheduleBatchPage();
    expect(redirect).toHaveBeenCalledWith("/students/schedule-imports/new");
  });
});
