import fp from "fastify-plugin";
import { ZodError } from "zod";
import { AppError, accessTokenExpired } from "../utils/errors";

/**
 * Registers a consistent API error envelope for operational and validation errors.
 */
export const errorPlugin = fp(async (app) => {
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) {
      return reply.status(400).send({
        error: {
          code: "VALIDATION_ERROR",
          message: error.issues.map((issue) => issue.message).join("; "),
          requestId: request.id
        }
      });
    }

    if (error instanceof AppError) {
      const retryAfterSeconds = error.details?.retryAfterSeconds;
      if (error.statusCode === 429 && typeof retryAfterSeconds === "number" && retryAfterSeconds > 0) {
        reply.header("Retry-After", String(Math.ceil(retryAfterSeconds)));
      }
      return reply.status(error.statusCode).send({
        error: {
          code: error.code,
          message: error.message,
          requestId: request.id,
          ...(typeof retryAfterSeconds === "number" ? { retryAfterSeconds } : {})
        }
      });
    }

    // Safety net: jose JWTExpired must never become HTTP 500 / stack leakage.
    const code = typeof error === "object" && error !== null && "code" in error ? String((error as { code?: string }).code) : "";
    if (code === "ERR_JWT_EXPIRED") {
      const expired = accessTokenExpired();
      return reply.status(expired.statusCode).send({
        error: {
          code: expired.code,
          message: expired.message,
          requestId: request.id
        }
      });
    }

    request.log.error(error);
    return reply.status(500).send({
      error: {
        code: "INTERNAL_SERVER_ERROR",
        message: "An unexpected server error occurred",
        requestId: request.id
      }
    });
  });
});
