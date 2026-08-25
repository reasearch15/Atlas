import { describe, expect, it } from "vitest";
import {
  CUSTOMER_PRIVACY_NOTICE,
  customerPrivacyCapabilities,
  findForbiddenCustomerIdentifierKeys,
  neutralCustomerTypeLabel
} from "./customer-privacy";
import { hasPermission } from "./roles";

describe("shared customer privacy policy", () => {
  it("Staff defaults deny every direct-contact permission", () => {
    const caps = customerPrivacyCapabilities("STAFF");
    expect(Object.values(caps).every((value) => value === false)).toBe(true);
  });

  it("Coadmin and Admin retain direct-contact permissions", () => {
    expect(hasPermission("COADMIN", "customer:search-external")).toBe(true);
    expect(hasPermission("PLATFORM_ADMIN", "customer:export")).toBe(true);
  });

  it("neutral labels never say Telegram contact", () => {
    expect(neutralCustomerTypeLabel("PRIVATE")).toBe("Customer");
    expect(neutralCustomerTypeLabel("GROUP")).toBe("Group");
    expect(neutralCustomerTypeLabel("CHANNEL")).toBe("Channel");
    expect(CUSTOMER_PRIVACY_NOTICE).toBe("Contact details hidden by workspace policy");
  });

  it("findForbiddenCustomerIdentifierKeys catches nested phone and username", () => {
    const hits = findForbiddenCustomerIdentifierKeys({
      ok: true,
      nested: { phone: "+1", profile: { username: "x", accessHash: "y" } }
    });
    expect(hits).toEqual(expect.arrayContaining(["nested.phone", "nested.profile.username", "nested.profile.accessHash"]));
  });
});
