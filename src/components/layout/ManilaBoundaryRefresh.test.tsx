import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ManilaBoundaryRefresh } from "./ManilaBoundaryRefresh";

const { refresh } = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

describe("ManilaBoundaryRefresh", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-24T15:59:30.000Z"));
    refresh.mockClear();
  });

  afterEach(() => vi.useRealTimers());

  it("refreshes an open view after Manila midnight", () => {
    render(<ManilaBoundaryRefresh />);
    act(() => vi.advanceTimersByTime(60_000));
    expect(refresh).toHaveBeenCalledTimes(1);
    act(() => vi.advanceTimersByTime(60_000));
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("refreshes when the browser window regains focus", () => {
    render(<ManilaBoundaryRefresh />);
    act(() => window.dispatchEvent(new Event("focus")));
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
