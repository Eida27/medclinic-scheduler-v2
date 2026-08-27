import { describe, expect, it, vi } from "vitest";

const { redirect } = vi.hoisted(() => ({ redirect: vi.fn() }));

vi.mock("next/navigation", () => ({ redirect }));

import StudentLookupPage from "./page";

describe("StudentLookupPage", () => {
  it("redirects the compatibility route to authenticated student sign in", () => {
    StudentLookupPage();

    expect(redirect).toHaveBeenCalledWith("/student/login");
  });
});
