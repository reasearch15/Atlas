import { describe, expect, it } from "vitest";
import { resolveDeliveryVisual } from "./outgoing-delivery-status";

describe("outgoing delivery visuals", () => {
  it("maps queued/sending to spinner state", () => {
    expect(resolveDeliveryVisual("QUEUED")).toBe("sending");
    expect(resolveDeliveryVisual("SENDING")).toBe("sending");
  });

  it("uses a single check for server-confirmed SENT only", () => {
    expect(resolveDeliveryVisual("SENT")).toBe("sent");
  });

  it("uses double checks only for explicit delivery/read statuses", () => {
    expect(resolveDeliveryVisual("DELIVERED")).toBe("delivered");
    expect(resolveDeliveryVisual("READ")).toBe("read");
  });

  it("maps failed statuses for retry UI", () => {
    expect(resolveDeliveryVisual("FAILED_RETRYABLE")).toBe("failed");
    expect(resolveDeliveryVisual("FAILED_PERMANENT")).toBe("failed");
  });
});
