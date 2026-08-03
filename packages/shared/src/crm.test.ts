import { describe, expect, it } from "vitest";
import { isAllowedManualStatusTransition, reopenStatusOnInbound, statusAfterClaim } from "./crm";

describe("CRM status rules", () => {
  it("reopens resolved to open and closed to new on inbound", () => {
    expect(reopenStatusOnInbound("RESOLVED")).toBe("OPEN");
    expect(reopenStatusOnInbound("CLOSED")).toBe("NEW");
    expect(reopenStatusOnInbound("OPEN")).toBeNull();
    expect(reopenStatusOnInbound("WAITING")).toBeNull();
  });

  it("opens NEW conversations when claimed", () => {
    expect(statusAfterClaim("NEW")).toBe("OPEN");
    expect(statusAfterClaim("WAITING")).toBe("WAITING");
  });

  it("allows manual transitions across CRM statuses", () => {
    expect(isAllowedManualStatusTransition("OPEN", "WAITING")).toBe(true);
    expect(isAllowedManualStatusTransition("OPEN", "OPEN")).toBe(false);
  });
});
