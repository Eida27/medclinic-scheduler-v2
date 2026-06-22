import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BatchActions } from "./BatchActions";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

describe("BatchActions", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    refresh.mockReset();
  });

  it("generates drafts as the only batch action", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: {} }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<BatchActions batchId="50000000-0000-4000-8000-000000000120" status="DRAFT" isAdmin={false} />);

    expect(screen.queryByRole("button", { name: "Validate batch" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Generate drafts" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const [url, request] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/appointments/generate");
    expect(request).toMatchObject({
      method: "POST",
      headers: { "content-type": "application/json" },
    });
    expect(JSON.parse(request.body)).toEqual({
      batchId: "50000000-0000-4000-8000-000000000120",
    });
    expect(await screen.findByRole("alert")).toHaveTextContent("Draft appointments generated.");
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("includes an admin capacity override reason when generating", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: {} }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<BatchActions batchId="batch-1" status="DRAFT" isAdmin />);

    await user.type(
      screen.getByPlaceholderText("Admin capacity override reason, when required"),
      "Approved for graduation week.",
    );
    await user.click(screen.getByRole("button", { name: "Generate drafts" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const request = fetchMock.mock.calls[0][1];
    expect(JSON.parse(request.body)).toEqual({
      batchId: "batch-1",
      overrideReason: "Approved for graduation week.",
    });
  });

  it("shows validation errors and refreshes persisted batch issues", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      json: async () => ({ error: { message: "Resolve non-capacity conflicts before generating appointments." } }),
    }));
    const user = userEvent.setup();
    render(<BatchActions batchId="batch-1" status="DRAFT" isAdmin={false} />);

    await user.click(screen.getByRole("button", { name: "Generate drafts" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Resolve non-capacity conflicts before generating appointments.",
    );
    expect(refresh).toHaveBeenCalledOnce();
  });
});
