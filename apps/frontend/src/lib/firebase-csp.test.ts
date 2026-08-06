import { describe, expect, it } from "vitest";
import {
  FIREBASE_MESSAGING_CONNECT_SRC,
  buildAtlasConnectSrc,
  normalizeFirebaseVapidKey
} from "./firebase-csp";

describe("buildAtlasConnectSrc", () => {
  it("includes self, API, WS, and Firebase messaging hosts only", () => {
    const value = buildAtlasConnectSrc({
      apiOrigin: "https://platform.atlast.work",
      wsOrigin: "wss://platform.atlast.work"
    });
    expect(value).toContain("'self'");
    expect(value).toContain("https://platform.atlast.work");
    expect(value).toContain("wss://platform.atlast.work");
    for (const host of FIREBASE_MESSAGING_CONNECT_SRC) {
      expect(value).toContain(host);
    }
    expect(value).not.toContain("*.googleapis.com");
    expect(value).not.toContain("https://www.googleapis.com");
  });
});

describe("normalizeFirebaseVapidKey", () => {
  it("strips quotes and whitespace", () => {
    expect(normalizeFirebaseVapidKey(' "BNxx yy" \n')).toBe("BNxxyy");
  });

  it("decodes URI-encoded keys when present", () => {
    expect(normalizeFirebaseVapidKey("BN%2Babc")).toBe("BN+abc");
  });
});
