import type { FastifyBaseLogger } from "fastify";
import type { Env } from "../../config/env";
import type { EmailMessage, EmailProvider } from "./EmailProvider";
import {
  adminVerificationEmail,
  generalNotificationEmail,
  newDeviceLoginEmail,
  passwordResetEmail,
  securityAlertEmail,
} from "./email.templates";
import { ResendEmailProvider } from "./providers/resend.provider";

interface NotificationEmailInput {
  readonly to: string;
  readonly title: string;
  readonly body: string;
}

export class EmailService {
  private readonly provider: EmailProvider;
  private readonly expiryMinutes: number;

  /**
   * Creates the provider-neutral email service facade used by application modules.
   */
  public constructor(env: Env, logger: FastifyBaseLogger) {
    this.provider = new ResendEmailProvider(env, logger);
    this.expiryMinutes = Math.ceil(env.ADMIN_VERIFICATION_TTL_SECONDS / 60);
  }

  /**
   * Verifies provider readiness before accepting traffic.
   */
  public async verify(): Promise<void> {
    await this.provider.verify();
  }

  /**
   * Sends a verification code without exposing provider details to callers.
   */
  public async sendVerificationCode(to: string, code: string): Promise<void> {
    await this.send(to, adminVerificationEmail(code, this.expiryMinutes), "admin-verification");
  }

  /**
   * Sends a password reset email.
   */
  public async sendPasswordReset(to: string, resetUrl: string, expiryMinutes: number): Promise<void> {
    await this.send(to, passwordResetEmail(resetUrl, expiryMinutes), "password-reset");
  }

  /**
   * Sends a security alert email.
   */
  public async sendSecurityAlert(input: NotificationEmailInput): Promise<void> {
    await this.send(input.to, securityAlertEmail(input), "security-alert");
  }

  /**
   * Sends a new-device login notification email.
   */
  public async sendNewDeviceLogin(to: string, ipAddress: string, occurredAt: string): Promise<void> {
    await this.send(to, newDeviceLoginEmail(ipAddress, occurredAt), "new-device-login");
  }

  /**
   * Sends a general notification email.
   */
  public async sendNotification(input: NotificationEmailInput): Promise<void> {
    await this.send(input.to, generalNotificationEmail(input), "general-notification");
  }

  private async send(to: string, template: Omit<EmailMessage, "to" | "tags">, category: string): Promise<void> {
    await this.provider.send({
      to,
      ...template,
      tags: [{ name: "category", value: category }]
    });
  }
}
