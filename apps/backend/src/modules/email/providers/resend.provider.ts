import type { FastifyBaseLogger } from "fastify";
import { Resend, type CreateEmailOptions, type ErrorResponse } from "resend";
import type { Env } from "../../../config/env";
import { AppError } from "../../../utils/errors";
import type { EmailDeliveryResult, EmailMessage, EmailProvider } from "../EmailProvider";

const transientResendErrors = new Set(["rate_limit_exceeded", "internal_server_error", "application_error"]);

export class ResendEmailProvider implements EmailProvider {
  private readonly client: Resend;
  private readonly from: string;
  private readonly logger: FastifyBaseLogger;

  /**
   * Creates a Resend-backed email provider.
   */
  public constructor(env: Env, logger: FastifyBaseLogger) {
    this.client = new Resend(env.RESEND_API_KEY);
    this.from = env.EMAIL_FROM;
    this.logger = logger;
  }

  /**
   * Performs local Resend configuration validation before serving traffic.
   */
  public async verify(): Promise<void> {
    this.logger.info("Email Provider: Resend");
    if (!this.client) {
      throw new AppError(500, "RESEND_PROVIDER_INITIALIZATION_FAILED", "Resend provider could not be initialized");
    }
    if (!this.from || !this.mailboxAddressIsValid(this.from)) {
      throw new AppError(500, "EMAIL_FROM_INVALID", "EMAIL_FROM must contain a valid mailbox address");
    }
    if (!this.client.key?.startsWith("re_")) {
      throw new AppError(500, "RESEND_API_KEY_INVALID", 'RESEND_API_KEY must start with "re_"');
    }

    this.logger.info("Provider ready.");
  }

  /**
   * Sends email through Resend with retries for transient provider errors.
   */
  public async send(message: EmailMessage): Promise<EmailDeliveryResult> {
    this.logger.info({ to: message.to, subject: message.subject }, "email queued");
    const response = await this.sendWithRetry(message);
    if (response.error) {
      this.logger.error({ to: message.to, subject: message.subject, providerError: response.error.message }, "email failed");
      throw this.toProviderError(response.error);
    }

    this.logger.info({ to: message.to, subject: message.subject, providerMessageId: response.data.id }, "email delivered");
    return { providerMessageId: response.data.id, status: "delivered" };
  }

  private async sendWithRetry(message: EmailMessage) {
    let response = await this.client.emails.send(this.toResendPayload(message));

    for (let attempt = 1; response.error && transientResendErrors.has(response.error.name) && attempt <= 2; attempt += 1) {
      await this.delay(150 * attempt);
      response = await this.client.emails.send(this.toResendPayload(message));
    }

    return response;
  }

  private toProviderError(error: ErrorResponse): AppError {
    if (error.name === "restricted_api_key") {
      return new AppError(500, "EMAIL_PROVIDER_CONFIGURATION_ERROR", "Resend API key restrictions do not allow email sending");
    }
    if (error.name === "invalid_api_key" || error.statusCode === 401) {
      return new AppError(502, "EMAIL_PROVIDER_AUTHENTICATION_FAILED", `Resend authentication failed: ${error.message}`);
    }
    if (this.isSenderConfigurationError(error)) {
      return new AppError(500, "EMAIL_SENDER_CONFIGURATION_ERROR", `Resend sender configuration failed: ${error.message}`);
    }
    return new AppError(502, "EMAIL_PROVIDER_FAILED", `Resend email failed: ${error.message}`);
  }

  private isSenderConfigurationError(error: ErrorResponse): boolean {
    const message = error.message.toLowerCase();
    return (
      error.name === "invalid_from_address" ||
      message.includes("domain") ||
      message.includes("sender") ||
      message.includes("from") ||
      message.includes("verified") ||
      message.includes("verification")
    );
  }

  private mailboxAddressIsValid(value: string): boolean {
    const match = value.match(/<([^<>]+)>$/);
    const mailbox = (match?.[1] ?? value).trim();
    return /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(mailbox);
  }

  private toResendPayload(message: EmailMessage): CreateEmailOptions {
    const payload: CreateEmailOptions = {
      from: this.from,
      to: message.to,
      subject: message.subject,
      html: message.html,
      text: message.text
    };
    if (message.tags) {
      payload.tags = [...message.tags];
    }
    return payload;
  }

  private async delay(milliseconds: number): Promise<void> {
    await new Promise((resolve) => {
      setTimeout(resolve, milliseconds);
    });
  }
}
