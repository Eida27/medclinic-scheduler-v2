import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { requireStudent, redirect } = vi.hoisted(() => ({
  requireStudent: vi.fn(),
  redirect: vi.fn((location: string) => { throw new Error(`NEXT_REDIRECT:${location}`); }),
}));
vi.mock("@/server/auth/current-student", () => ({ requireStudent }));
vi.mock("next/navigation", () => ({ redirect }));
vi.mock("@/components/student/EmailVerificationForm", () => ({
  EmailVerificationForm: ({ returnTo, verifiedEmail }: { returnTo: string; verifiedEmail: string | null }) => (
    <div data-testid="verification-form" data-return-to={returnTo}>{verifiedEmail ?? "unverified"}</div>
  ),
}));
import StudentEmailVerificationPage from "./page";

const workspace = "/student/results/10000000-0000-4000-8000-000000000001";
describe("StudentEmailVerificationPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireStudent.mockResolvedValue({ email: "verified@example.test", emailVerifiedAt: new Date() });
  });
  it.each(["/student", "/student/results", workspace])("continues already verified students with explicit valid %s", async (returnTo) => {
    await expect(StudentEmailVerificationPage({ searchParams: Promise.resolve({ returnTo }) }))
      .rejects.toThrow(`NEXT_REDIRECT:${returnTo}`);
  });
  it.each([
    undefined, "", "/student/results/not-uuid", `${workspace}/extra`, `${workspace}?a=1`,
    `${workspace}#fragment`, "//evil.test", "https://evil.test", "/student\\results", "/staff",
    [workspace], ["/student", "https://evil.test"],
  ].map((returnTo) => ({ returnTo })))("keeps replacement form for missing or rejected return $returnTo", async ({ returnTo }) => {
    render(await StudentEmailVerificationPage({ searchParams: Promise.resolve({ returnTo }) }));
    expect(screen.getByTestId("verification-form")).toHaveAttribute("data-return-to", "/student");
    expect(screen.getByText("verified@example.test")).toBeVisible();
    expect(redirect).not.toHaveBeenCalled();
  });
  it("passes a safe continuation to the waiting unverified form", async () => {
    requireStudent.mockResolvedValue({ email: null, emailVerifiedAt: null });
    render(await StudentEmailVerificationPage({ searchParams: Promise.resolve({ returnTo: workspace }) }));
    expect(screen.getByTestId("verification-form")).toHaveAttribute("data-return-to", workspace);
    expect(screen.getByText("unverified")).toBeVisible();
  });
  it("requires an authenticated session before rendering", async () => {
    requireStudent.mockRejectedValue(new Error("expired"));
    await expect(StudentEmailVerificationPage({ searchParams: Promise.resolve({ returnTo: workspace }) }))
      .rejects.toThrow("NEXT_REDIRECT:/student/login");
  });
});
