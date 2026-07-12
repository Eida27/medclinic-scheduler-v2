import { beforeEach, describe, expect, it, vi } from "vitest";

const { redirect } = vi.hoisted(() => ({ redirect: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect }));

import LaboratoryList from "../laboratory/coordinator-schedules/page";
import LaboratoryNew from "../laboratory/coordinator-schedules/new/page";
import LaboratoryDetail from "../laboratory/coordinator-schedules/[batchId]/page";
import PhysicalList from "../physical-exam/coordinator-schedules/page";
import PhysicalNew from "../physical-exam/coordinator-schedules/new/page";
import PhysicalDetail from "../physical-exam/coordinator-schedules/[batchId]/page";

describe("clinic coordinator route compatibility", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    ["laboratory list", LaboratoryList, "/students?view=schedule-imports"],
    ["physical list", PhysicalList, "/students?view=schedule-imports"],
    ["laboratory new", LaboratoryNew, "/students/schedule-imports/new"],
    ["physical new", PhysicalNew, "/students/schedule-imports/new"],
  ])("redirects %s", async (_label, page, destination) => {
    await page();
    expect(redirect).toHaveBeenCalledWith(destination);
  });

  it.each([
    ["laboratory detail", LaboratoryDetail],
    ["physical detail", PhysicalDetail],
  ])("redirects %s through the global legacy resolver", async (_label, page) => {
    await page({ params: Promise.resolve({ batchId: "batch-1" }) });
    expect(redirect).toHaveBeenCalledWith("/coordinator-schedules/batch-1");
  });
});
