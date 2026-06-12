import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PublishButton } from "./PublishButton";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

describe("PublishButton", () => {
  it("does not publish until the destructive action is confirmed", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
    render(<PublishButton batchId="batch-1" />);

    fireEvent.click(screen.getByRole("button", { name: "Publish batch" }));
    expect(screen.getByRole("dialog", { name: "Publish this batch?" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Publish batch" }));
    fireEvent.click(screen.getByRole("button", { name: "Publish appointments" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  });
});
