import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { refresh } = vi.hoisted(() => ({ refresh: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh }),
}));

import { CapacityForm } from "./CapacityForm";

const settings = [
  {
    clinicCode: "KABALAKA_CLINIC",
    clinicName: "Kabalaka Clinic",
    scheduleType: "LABORATORY",
    maxDailyCapacity: 125,
  },
  {
    clinicCode: "UNIVERSITY_CLINIC",
    clinicName: "University Clinic",
    scheduleType: "PHYSICAL_EXAM",
    maxDailyCapacity: 150,
  },
];

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("CapacityForm", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows only the maximum students per day setting", () => {
    render(<CapacityForm settings={settings} />);

    expect(screen.getAllByLabelText("Maximum students per day")).toHaveLength(2);
    expect(screen.queryByText("Recommended")).not.toBeInTheDocument();
    expect(screen.queryByText("Warning")).not.toBeInTheDocument();
    expect(screen.queryByText("Safe")).not.toBeInTheDocument();
  });

  it("submits only the maximum and disables only the pending card", async () => {
    let resolveResponse!: (response: Response) => void;
    const fetchMock = vi.fn().mockReturnValue(new Promise<Response>((resolve) => {
      resolveResponse = resolve;
    }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<CapacityForm settings={settings} />);

    const maximumInputs = screen.getAllByLabelText("Maximum students per day");
    await user.clear(maximumInputs[0]);
    await user.type(maximumInputs[0], "130");
    await user.click(screen.getAllByRole("button", { name: "Save" })[0]);

    expect(fetchMock).toHaveBeenCalledWith("/api/settings/capacity", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        clinicCode: "KABALAKA_CLINIC",
        scheduleType: "LABORATORY",
        maxDailyCapacity: 130,
      }),
    });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).not.toHaveProperty("safeDailyCapacity");

    const saveButtons = screen.getAllByRole("button", { name: "Save" });
    expect(saveButtons[0]).toBeDisabled();
    expect(saveButtons[1]).toBeEnabled();
    expect(screen.getByRole("status", { name: "Saving capacity" })).toBeVisible();

    resolveResponse(jsonResponse({ data: { scheduleType: "LABORATORY", maxDailyCapacity: 130 } }));
    await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
  });
});
