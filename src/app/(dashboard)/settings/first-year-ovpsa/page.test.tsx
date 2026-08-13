import { describe, expect, it, vi } from "vitest";

const { redirect } = vi.hoisted(() => ({ redirect: vi.fn(() => { throw new Error("redirect"); }) }));
vi.mock("next/navigation", () => ({ redirect }));

import FirstYearOvpsaPage from "./page";
import FirstYearOvpsaBatchPage from "./[batchId]/page";

describe("retired First Year settings routes", () => {
  it("redirects the list and detail routes to the shared Schedule Import form", async () => {
    expect(() => FirstYearOvpsaPage()).toThrow("redirect");
    expect(redirect).toHaveBeenLastCalledWith("/students/schedule-imports/new");

    expect(() => FirstYearOvpsaBatchPage()).toThrow("redirect");
    expect(redirect).toHaveBeenLastCalledWith("/students/schedule-imports/new");
  });
});
