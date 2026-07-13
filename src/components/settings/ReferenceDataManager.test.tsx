import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { refresh } = vi.hoisted(() => ({ refresh: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh }),
}));

import { ReferenceDataManager } from "./ReferenceDataManager";

const colleges = [{
  id: "10000000-0000-4000-8000-000000000003",
  code: "CCS",
  name: "College of Computer Studies",
  isActive: true,
}];

const programs = [{
  id: "20000000-0000-4000-8000-000000000003",
  collegeId: colleges[0].id,
  collegeName: colleges[0].name,
  code: "BSIT",
  name: "BS Information Technology",
  isActive: true,
}];

const priorities = [{
  id: "30000000-0000-4000-8000-000000000004",
  name: "Regular",
  rankOrder: 4,
  isActive: true,
}];

function renderManager() {
  return render(
    <ReferenceDataManager
      colleges={colleges}
      programs={programs}
      priorities={priorities}
    />,
  );
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("ReferenceDataManager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resets the submitted program form and refreshes after an asynchronous create succeeds", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ data: {
      id: "20000000-0000-4000-8000-000000000099",
      collegeId: colleges[0].id,
      code: "BSCS",
      name: "BS Computer Science",
      isActive: true,
    } }, 201));
    vi.stubGlobal("fetch", fetchMock);
    renderManager();

    const card = screen.getByRole("heading", { name: "Programs" }).parentElement!;
    const code = within(card).getByPlaceholderText("Code");
    const name = within(card).getByPlaceholderText("Program name");
    await user.selectOptions(within(card).getByRole("combobox"), colleges[0].id);
    await user.type(code, "BSCS");
    await user.type(name, "BS Computer Science");
    await user.click(within(card).getByRole("button", { name: "Add program" }));

    await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    expect(fetchMock).toHaveBeenCalledWith("/api/programs", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({
        collegeId: colleges[0].id,
        code: "BSCS",
        name: "BS Computer Science",
      }),
    }));
    expect(code).toHaveValue("");
    expect(name).toHaveValue("");
    expect(within(card).getByRole("combobox")).toHaveValue("");
  });

  it("preserves entered creation values and shows the API message when creation fails", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({
      error: { code: "DUPLICATE_REFERENCE", message: "That reference value already exists." },
    }, 409)));
    renderManager();

    const card = screen.getByRole("heading", { name: "Colleges" }).parentElement!;
    const code = within(card).getByPlaceholderText("Code");
    const name = within(card).getByPlaceholderText("College name");
    await user.type(code, "CCS");
    await user.type(name, "College of Computer Studies");
    await user.click(within(card).getByRole("button", { name: "Add college" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("That reference value already exists.");
    expect(code).toHaveValue("CCS");
    expect(name).toHaveValue("College of Computer Studies");
    expect(refresh).not.toHaveBeenCalled();
  });

  it("does not delete a program when confirmation is cancelled", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    renderManager();

    await user.click(screen.getByRole("button", { name: "Delete BSIT · BS Information Technology" }));
    expect(screen.getByRole("dialog")).toHaveTextContent("Delete program?");
    expect(screen.getByRole("dialog")).toHaveTextContent("BSIT · BS Information Technology");
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["CCS · College of Computer Studies", "/api/colleges", colleges[0].id, "college"],
    ["BSIT · BS Information Technology", "/api/programs", programs[0].id, "program"],
    ["Regular", "/api/priority-groups", priorities[0].id, "priority group"],
  ])("sends a confirmed delete for %s to the matching endpoint", async (label, endpoint, id, typeLabel) => {
    const user = userEvent.setup();
    let resolveResponse!: (response: Response) => void;
    const fetchMock = vi.fn().mockReturnValue(new Promise<Response>((resolve) => {
      resolveResponse = resolve;
    }));
    vi.stubGlobal("fetch", fetchMock);
    renderManager();

    await user.click(screen.getByRole("button", { name: `Delete ${label}` }));
    await user.click(screen.getByRole("button", { name: `Delete ${typeLabel}` }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(endpoint, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id }),
    }));
    expect(screen.getByRole("button", { name: "Deleting..." })).toBeDisabled();

    resolveResponse(jsonResponse({ data: { success: true } }));
    await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("keeps an in-use reference visible and shows the conflict message", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({
      error: {
        code: "REFERENCE_IN_USE",
        message: "This reference value is already in use and cannot be deleted.",
      },
    }, 409)));
    renderManager();

    await user.click(screen.getByRole("button", { name: "Delete CCS · College of Computer Studies" }));
    await user.click(screen.getByRole("button", { name: "Delete college" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This reference value is already in use and cannot be deleted.",
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByText("CCS · College of Computer Studies")).toBeVisible();
    expect(refresh).not.toHaveBeenCalled();
  });
});
