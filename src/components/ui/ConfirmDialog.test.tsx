import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ConfirmDialog } from "./ConfirmDialog";

describe("ConfirmDialog", () => {
  it("announces pending work and prevents cancellation", () => {
    const onCancel = vi.fn();

    render(
      <ConfirmDialog
        open
        title="Confirm import"
        description="Import the selected schedule?"
        confirmLabel="Import"
        pending
        pendingLabel="Working"
        onCancel={onCancel}
        onConfirm={vi.fn()}
      />,
    );

    expect(screen.getByRole("dialog")).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("status", { name: "Working" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Working" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("traps focus, closes on Escape, and restores focus to the originating control", async () => {
    const user = userEvent.setup();

    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>Open confirmation</button>
          <ConfirmDialog
            open={open}
            title="Confirm action"
            description="Proceed with this action?"
            confirmLabel="Confirm"
            onCancel={() => setOpen(false)}
            onConfirm={vi.fn()}
          />
        </>
      );
    }

    render(<Harness />);
    const origin = screen.getByRole("button", { name: "Open confirmation" });
    await user.click(origin);

    const cancel = screen.getByRole("button", { name: "Cancel" });
    const confirm = screen.getByRole("button", { name: "Confirm" });
    expect(cancel).toHaveFocus();
    await user.tab({ shift: true });
    expect(confirm).toHaveFocus();
    await user.tab();
    expect(cancel).toHaveFocus();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(origin).toHaveFocus();
  });
});
