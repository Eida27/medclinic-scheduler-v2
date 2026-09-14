import { describe, expect, it } from "vitest";
import {
  operationalStatusLabel,
  statusTone,
} from "./status-labels";

describe("operationalStatusLabel", () => {
  it.each([
    ["UNSCHEDULED", "Unscheduled"],
    ["PENDING", "Pending"],
    ["COMPLETED", "Completed"],
    ["NO_SHOW", "No-show"],
    ["RESCHEDULED", "Rescheduled"],
    ["CANCELLED", "Cancelled"],
    ["AWAITING_RESCHEDULE", "Awaiting manual reschedule"],
  ])("labels %s as %s", (value, expected) => {
    expect(operationalStatusLabel(value)).toBe(expected);
  });
});

describe("readable fallback", () => {
  it.each([
    [operationalStatusLabel, "CHECKED_IN", "Checked in"],
  ])("formats an unknown underscore-separated value", (label, value, expected) => {
    expect(label(value)).toBe(expected);
  });
});

describe("statusTone", () => {
  it.each([
    ["COMPLETED", "success"],
    ["COMPLETE", "success"],
    ["NO_SHOW", "danger"],
    ["CANCELLED", "danger"],
    ["REQUIRES_FOLLOW_UP", "warning"],
    ["FOLLOW_UP", "warning"],
    ["PENDING", "warning"],
    ["RESCHEDULED", "warning"],
    ["PENDING_UPLOAD", "neutral"],
    ["NOT_APPLICABLE", "neutral"],
    ["UNSCHEDULED", "neutral"],
    ["INCOMPLETE", "neutral"],
    ["UNKNOWN_STATUS", "neutral"],
  ] as const)("maps %s to %s", (value, expected) => {
    expect(statusTone(value)).toBe(expected);
  });
});
