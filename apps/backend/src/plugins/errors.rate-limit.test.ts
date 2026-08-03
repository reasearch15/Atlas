import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { AppError } from "../utils/errors";
import { errorPlugin } from "./errors";

describe("error plugin RATE_LIMITED envelope", () => {
  it("sets Retry-After and retryAfterSeconds on 429 AppError", async () => {
    const app = Fastify();
    await app.register(errorPlugin);
    app.get("/limited", async () => {
      throw new AppError(429, "RATE_LIMITED", "Too many attempts. Please wait and try again.", {
        retryAfterSeconds: 321
      });
    });
    const response = await app.inject({ method: "GET", url: "/limited" });
    expect(response.statusCode).toBe(429);
    expect(response.headers["retry-after"]).toBe("321");
    expect(response.json()).toMatchObject({
      error: {
        code: "RATE_LIMITED",
        message: "Too many attempts. Please wait and try again.",
        retryAfterSeconds: 321
      }
    });
    await app.close();
  });
});
