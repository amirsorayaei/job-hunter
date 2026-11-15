import { describe, expect, it } from "vitest";
import { inQuietHours } from "../../scripts/agent/lib";

describe("quiet hours", () => {
  it("wraps midnight: 0 to 8", () => {
    expect(inQuietHours(0, 0, 8)).toBe(true);
    expect(inQuietHours(7, 0, 8)).toBe(true);
    expect(inQuietHours(8, 0, 8)).toBe(false);
    expect(inQuietHours(23, 0, 8)).toBe(false);
  });
  it("wraps midnight: 23 to 7", () => {
    expect(inQuietHours(23, 23, 7)).toBe(true);
    expect(inQuietHours(2, 23, 7)).toBe(true);
    expect(inQuietHours(7, 23, 7)).toBe(false);
    expect(inQuietHours(12, 23, 7)).toBe(false);
  });
  it("same-day range and disabled range", () => {
    expect(inQuietHours(13, 12, 14)).toBe(true);
    expect(inQuietHours(14, 12, 14)).toBe(false);
    expect(inQuietHours(3, 5, 5)).toBe(false);
  });
});
