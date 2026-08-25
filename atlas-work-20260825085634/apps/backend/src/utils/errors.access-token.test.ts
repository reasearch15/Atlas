import { describe, expect, it } from "vitest";
import { accessTokenExpired, unauthorized } from "../utils/errors";

describe("auth error helpers", () => {
  it("ACCESS_TOKEN_EXPIRED is a 401 AppError", () => {
    const error = accessTokenExpired();
    expect(error).toMatchObject({
      statusCode: 401,
      code: "ACCESS_TOKEN_EXPIRED",
      message: "Access token has expired"
    });
  });

  it("keeps UNAUTHORIZED distinct from ACCESS_TOKEN_EXPIRED", () => {
    expect(unauthorized().code).toBe("UNAUTHORIZED");
    expect(accessTokenExpired().code).not.toBe(unauthorized().code);
  });
});
