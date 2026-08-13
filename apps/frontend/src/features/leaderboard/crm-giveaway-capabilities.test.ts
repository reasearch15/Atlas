import { describe, expect, it } from "vitest";
import { canViewCrmGiveawayPanel, crmGiveawayCapabilities } from "./crm-giveaway-capabilities";

describe("crmGiveawayCapabilities", () => {
  it("lets Staff view and operate the CRM panel without Coadmin-only admin tools", () => {
    const caps = crmGiveawayCapabilities("STAFF");
    expect(canViewCrmGiveawayPanel("STAFF")).toBe(true);
    expect(caps.canRead).toBe(true);
    expect(caps.canDeposit).toBe(true);
    expect(caps.canReferral).toBe(true);
    expect(caps.canPromotion).toBe(true);
    expect(caps.canGiveInfo).toBe(true);
    expect(caps.canWheelSpin).toBe(true);

    expect(caps.canBind).toBe(false);
    expect(caps.canAdminSettings).toBe(false);
    expect(caps.canReverse).toBe(false);
    expect(caps.canReferralOverride).toBe(false);
    expect(caps.canFinalize).toBe(false);
    expect(caps.canPayout).toBe(false);
    expect(caps.canEligibilityReview).toBe(false);
    expect(caps.canTelegramManage).toBe(false);
    expect(caps.canWheelManage).toBe(false);
  });

  it("lets Coadmin use the same operational panel plus bind, without exposing admin here via CRM flags", () => {
    const caps = crmGiveawayCapabilities("COADMIN");
    expect(canViewCrmGiveawayPanel("COADMIN")).toBe(true);
    expect(caps.canRead).toBe(true);
    expect(caps.canDeposit).toBe(true);
    expect(caps.canReferral).toBe(true);
    expect(caps.canPromotion).toBe(true);
    expect(caps.canGiveInfo).toBe(true);
    expect(caps.canWheelSpin).toBe(true);
    expect(caps.canBind).toBe(true);
    // Admin permissions exist for Coadmin but CRM panel must not render those controls.
    expect(caps.canAdminSettings).toBe(true);
    expect(caps.canReverse).toBe(true);
    expect(caps.canTelegramManage).toBe(true);
    expect(caps.canWheelManage).toBe(true);
  });

  it("hides the panel when role is missing", () => {
    expect(canViewCrmGiveawayPanel(null)).toBe(false);
    expect(crmGiveawayCapabilities(undefined).canDeposit).toBe(false);
  });
});
