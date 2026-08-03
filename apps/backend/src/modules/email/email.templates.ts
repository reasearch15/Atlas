interface TemplateResult {
  readonly subject: string;
  readonly html: string;
  readonly text: string;
}

interface NotificationInput {
  readonly title: string;
  readonly body: string;
}

function layout(title: string, body: string): string {
  return `
    <div style="font-family:Inter,Arial,sans-serif;background:#f7faf9;padding:32px;color:#1a202c">
      <div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #d6e0dd;border-radius:8px;padding:28px">
        <div style="font-size:18px;font-weight:700;color:#14766f">Atlas Security</div>
        <h1 style="font-size:22px;margin:24px 0 16px">${title}</h1>
        ${body}
      </div>
    </div>
  `;
}

/**
 * Builds the Platform Admin verification code email.
 */
export function adminVerificationEmail(code: string, expiryMinutes: number): TemplateResult {
  return {
    subject: "Atlas Security Verification Code",
    html: layout(
      "Security Verification Code",
      `
        <p style="line-height:1.6;margin:0 0 12px">Hello,</p>
        <p style="line-height:1.6;margin:0 0 12px">A login from a new device was detected.</p>
        <p style="line-height:1.6;margin:0 0 16px">Your verification code is:</p>
        <div style="font-size:32px;letter-spacing:8px;font-weight:800;background:#edf7f5;border-radius:8px;padding:16px 20px;text-align:center;color:#0f5954">${code}</div>
        <p style="line-height:1.6;margin:20px 0 12px">This code expires in ${expiryMinutes} minutes.</p>
        <p style="line-height:1.6;margin:0 0 24px">If you did not attempt to sign in, you can safely ignore this email.</p>
        <p style="line-height:1.6;margin:0">Regards,<br />Atlas Security</p>
      `
    ),
    text: `Hello,

A login from a new device was detected.

Your verification code is:

${code}

This code expires in ${expiryMinutes} minutes.

If you did not attempt to sign in, you can safely ignore this email.

Regards,
Atlas Security`
  };
}

/**
 * Builds a password reset email.
 */
export function passwordResetEmail(resetUrl: string, expiryMinutes: number): TemplateResult {
  return {
    subject: "Atlas Password Reset",
    html: layout("Password Reset", `<p>Hello,</p><p>Use the secure link below to reset your Atlas password.</p><p><a href="${resetUrl}">Reset password</a></p><p>This link expires in ${expiryMinutes} minutes.</p>`),
    text: `Hello,\n\nUse this secure link to reset your Atlas password:\n\n${resetUrl}\n\nThis link expires in ${expiryMinutes} minutes.`
  };
}

/**
 * Builds a new-device login alert.
 */
export function newDeviceLoginEmail(ipAddress: string, occurredAt: string): TemplateResult {
  return {
    subject: "Atlas New Device Login",
    html: layout("New Device Login", `<p>Hello,</p><p>A new device login was detected.</p><p>IP address: ${ipAddress}</p><p>Time: ${occurredAt}</p>`),
    text: `Hello,\n\nA new device login was detected.\n\nIP address: ${ipAddress}\nTime: ${occurredAt}`
  };
}

/**
 * Builds a security alert email.
 */
export function securityAlertEmail(input: NotificationInput): TemplateResult {
  return {
    subject: `Atlas Security Alert: ${input.title}`,
    html: layout(input.title, `<p>Hello,</p><p>${input.body}</p><p>Regards,<br />Atlas Security</p>`),
    text: `Hello,\n\n${input.body}\n\nRegards,\nAtlas Security`
  };
}

/**
 * Builds a general notification email.
 */
export function generalNotificationEmail(input: NotificationInput): TemplateResult {
  return {
    subject: `Atlas: ${input.title}`,
    html: layout(input.title, `<p>Hello,</p><p>${input.body}</p>`),
    text: `Hello,\n\n${input.body}`
  };
}
