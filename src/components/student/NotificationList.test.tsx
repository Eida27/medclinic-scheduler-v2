import { afterEach, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NotificationList } from "./NotificationList";

const { refresh } = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

it("renders the stored OJT hospital/date instruction and marks only its own notice read", async () => {
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true })));
  vi.stubGlobal("fetch", fetch);
  render(<NotificationList items={[{
    id: "notice-ojt-1", title: "Schedule published",
    message: "Your MedClinic schedule is ready. X-ray schedule: 2026-08-13 at Iloilo Mission Hospital, 7 calendar days before your KABALAKA CBC, Urine, and Stool appointment on 2026-08-20. Contact CPU Clinic for instructions if this date has passed.",
    readAt: null, createdAt: new Date("2026-08-01T00:00:00Z"),
  }]} />);
  expect(screen.getByText(/X-ray schedule: 2026-08-13 at Iloilo Mission Hospital/)).toBeVisible();
  expect(screen.getByText(/appointment on 2026-08-20/)).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Mark read" }));
  await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/student/notifications", {
    method: "PATCH", headers: { "content-type": "application/json" },
    body: JSON.stringify({ notificationId: "notice-ojt-1" }),
  }));
  expect(refresh).toHaveBeenCalledOnce();
});
