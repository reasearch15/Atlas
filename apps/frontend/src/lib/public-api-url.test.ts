import { describe, expect, it } from "vitest";
import { resolvePublicApiUrl } from "./resolve-public-api-url";

describe("resolvePublicApiUrl", () => {
  it("requires NEXT_PUBLIC_API_URL when unset", () => {
    expect(() =>
      resolvePublicApiUrl({ explicit: true, nodeEnv: "development", nextPublicApiUrl: undefined })
    ).toThrow(/NEXT_PUBLIC_API_URL/);
  });

  it("allows http localhost outside production when provided", () => {
    expect(
      resolvePublicApiUrl({
        explicit: true,
        nodeEnv: "development",
        nextPublicApiUrl: "http://localhost:4000"
      })
    ).toBe("http://localhost:4000");
  });

  it("requires NEXT_PUBLIC_API_URL in production", () => {
    expect(() =>
      resolvePublicApiUrl({ explicit: true, nodeEnv: "production", nextPublicApiUrl: undefined })
    ).toThrow(/NEXT_PUBLIC_API_URL/);
  });

  it("rejects localhost in production", () => {
    expect(() =>
      resolvePublicApiUrl({
        explicit: true,
        nodeEnv: "production",
        nextPublicApiUrl: "https://localhost:4000"
      })
    ).toThrow(/localhost/);
  });

  it("rejects non-https in production", () => {
    expect(() =>
      resolvePublicApiUrl({
        explicit: true,
        nodeEnv: "production",
        nextPublicApiUrl: "http://platform.example.com"
      })
    ).toThrow(/https/);
  });

  it("accepts https production origins and strips trailing slash", () => {
    expect(
      resolvePublicApiUrl({
        explicit: true,
        nodeEnv: "production",
        nextPublicApiUrl: "https://platform.example.com/"
      })
    ).toBe("https://platform.example.com");
  });
});
