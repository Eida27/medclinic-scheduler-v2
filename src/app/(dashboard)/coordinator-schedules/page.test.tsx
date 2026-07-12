import { describe, expect, it, vi } from "vitest";

const { redirect } = vi.hoisted(() => ({ redirect: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect }));

import ScheduleBatchesPage from "./page";

describe("ScheduleBatchesPage", () => {
  it("redirects the retired list to grouped import history", async () => {
    await ScheduleBatchesPage();
    expect(redirect).toHaveBeenCalledWith("/students?view=schedule-imports");
  });
});
