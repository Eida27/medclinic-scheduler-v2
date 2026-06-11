import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PublishButton } from "./PublishButton";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

describe("PublishButton", () => {
  it("does not publish until the destructive action is confirmed", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<PublishButton batchId="batch-1" />);
    fireEvent.click(screen.getByRole("button", { name: "Publish batch" }));
    expect(fetchMock).not.toHaveBeenCalled();

    vi.spyOn(window, "confirm").mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: "Publish batch" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  });
});
