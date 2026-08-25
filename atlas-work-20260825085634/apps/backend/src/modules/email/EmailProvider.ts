export interface EmailMessage {
  readonly to: string;
  readonly subject: string;
  readonly html: string;
  readonly text: string;
  readonly tags?: readonly { readonly name: string; readonly value: string }[];
}

export interface EmailDeliveryResult {
  readonly providerMessageId: string | null;
  readonly status: "queued" | "delivered";
}

export interface EmailProvider {
  /**
   * Verifies provider configuration and connectivity before the API accepts traffic.
   */
  verify(): Promise<void>;

  /**
   * Sends an email message through the provider.
   */
  send(message: EmailMessage): Promise<EmailDeliveryResult>;
}
