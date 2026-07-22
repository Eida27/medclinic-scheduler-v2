import { describe, expect, it, vi } from "vitest";
import ResultsPage from "./page";

const { redirect } = vi.hoisted(() => ({
  redirect: vi.fn(),
}));

vi.mock("next/navigation", () => ({ redirect }));

describe("ResultsPage", () => {
  it("redirects old Results bookmarks to Appointments", () => {
    ResultsPage();

    expect(redirect).toHaveBeenCalledWith("/appointments");
  });
});
