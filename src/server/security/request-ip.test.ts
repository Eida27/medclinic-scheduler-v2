import { describe, expect, it } from "vitest";
import { requestIp } from "./request-ip";

describe("requestIp", () => {
  it("uses the first address from x-forwarded-for", () => {
    expect(requestIp(new Request("http://localhost", {
      headers: { "x-forwarded-for": "203.0.113.9, 10.0.0.1" },
    }))).toBe("203.0.113.9");
  });

  it("falls back to x-real-ip", () => {
    expect(requestIp(new Request("http://localhost", {
      headers: { "x-real-ip": "198.51.100.14" },
    }))).toBe("198.51.100.14");
  });

  it("falls back to unknown when proxy headers are absent", () => {
    expect(requestIp(new Request("http://localhost"))).toBe("unknown");
  });

  it("trims the selected address", () => {
    expect(requestIp(new Request("http://localhost", {
      headers: { "x-forwarded-for": "  203.0.113.9  , 10.0.0.1" },
    }))).toBe("203.0.113.9");
  });

  it("limits the address to 64 characters", () => {
    const address = "1".repeat(65);
    expect(requestIp(new Request("http://localhost", {
      headers: { "x-real-ip": address },
    }))).toBe("1".repeat(64));
  });
});
