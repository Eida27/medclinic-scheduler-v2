import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { optionalUser } = vi.hoisted(() => ({ optionalUser: vi.fn() }));

vi.mock("next/navigation", () => ({
  redirect: vi.fn(),
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("@/server/auth/current-user", () => ({ optionalUser }));

import LoginPage from "./page";

describe("LoginPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    optionalUser.mockResolvedValue(null);
  });

  it("does not render a circular background decoration", async () => {
    const { container } = render(await LoginPage());

    expect(screen.getByRole("heading", { name: "Clinic staff sign in" })).toBeVisible();
    expect(container.querySelector('[aria-hidden="true"].rounded-full')).not.toBeInTheDocument();
  });
});
