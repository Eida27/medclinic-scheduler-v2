import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  OvpsaFirstYearBatchEditor,
  type OvpsaFirstYearBatchDetail,
} from "./OvpsaFirstYearBatchEditor";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

const detail: OvpsaFirstYearBatchDetail = {
  batchId: "batch-1",
  scheduleCycleStart: 2026,
  collegeName: "College of Testing",
  status: "RESCHEDULE_REQUIRED",
  optimisticToken: "token-1",
  revisionId: "revision-1",
  revisionNumber: 1,
  revisionStatus: "PUBLISHED",
  laboratoryDate: "2026-09-14",
  physicalExamDate: "2026-09-21",
  physicalExamExceptionReason: null,
  cancellationReason: null,
  memberCount: 1,
  members: [{ studentNumber: "T-1", studentName: "Student One", programName: "Testing" }],
  appointments: [],
  revisions: [],
  reservations: [],
  history: [],
};

describe("OvpsaFirstYearBatchEditor", () => {
  beforeEach(() => {
    refresh.mockReset();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: { optimisticToken: "token-2" } }),
    }));
  });

  it("submits a replacement date received through the native input event", async () => {
    render(<OvpsaFirstYearBatchEditor initial={detail} />);

    fireEvent.input(screen.getByLabelText("Laboratory date"), {
      target: { value: "2026-10-12" },
    });
    fireEvent.change(screen.getByLabelText("Reschedule reason"), {
      target: { value: "Official closure replacement" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Publish replacement" }));

    await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    expect(JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string)).toMatchObject({
      laboratoryDate: "2026-10-12",
      physicalExamDateOverride: null,
      reason: "Official closure replacement",
    });
  });
});
