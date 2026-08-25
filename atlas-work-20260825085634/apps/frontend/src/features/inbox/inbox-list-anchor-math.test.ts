import { describe, expect, it } from "vitest";
import { applySequentialScrollDeltas, scrollDeltaForAnchor } from "./inbox-list-anchor";

describe("inbox-list-anchor math", () => {
  it("returns zero delta when the row did not move visually", () => {
    expect(
      scrollDeltaForAnchor({
        previousOffsetFromContainerTop: 40,
        newOffsetFromContainerTop: 40
      })
    ).toBe(0);
  });

  it("compensates upward moves with a negative scroll delta", () => {
    expect(
      scrollDeltaForAnchor({
        previousOffsetFromContainerTop: 140,
        newOffsetFromContainerTop: 20
      })
    ).toBe(-120);
  });

  it("does not accumulate phantom drift across perfect compensations", () => {
    const deltas = [
      scrollDeltaForAnchor({ previousOffsetFromContainerTop: 0, newOffsetFromContainerTop: 72 }),
      scrollDeltaForAnchor({ previousOffsetFromContainerTop: 72, newOffsetFromContainerTop: 0 }),
      scrollDeltaForAnchor({ previousOffsetFromContainerTop: 0, newOffsetFromContainerTop: 0 })
    ];
    expect(applySequentialScrollDeltas(200, deltas)).toBe(200);
  });
});
