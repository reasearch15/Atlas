export type TelegramAuthorizationMachineState =
  | "EMPTY"
  | "QR_REQUESTED"
  | "PHONE_REQUESTED"
  | "CODE_REQUESTED"
  | "PASSWORD_REQUESTED"
  | "AUTHORIZED"
  | "EXPIRED"
  | "CANCELLED"
  | "REAUTH_REQUIRED";

const transitions: Record<TelegramAuthorizationMachineState, readonly TelegramAuthorizationMachineState[]> = {
  EMPTY: ["QR_REQUESTED", "PHONE_REQUESTED", "CANCELLED"],
  QR_REQUESTED: ["PHONE_REQUESTED", "CODE_REQUESTED", "AUTHORIZED", "EXPIRED", "CANCELLED"],
  PHONE_REQUESTED: ["CODE_REQUESTED", "EXPIRED", "CANCELLED"],
  CODE_REQUESTED: ["PASSWORD_REQUESTED", "AUTHORIZED", "EXPIRED", "CANCELLED"],
  PASSWORD_REQUESTED: ["AUTHORIZED", "EXPIRED", "CANCELLED"],
  AUTHORIZED: ["REAUTH_REQUIRED", "CANCELLED"],
  EXPIRED: ["QR_REQUESTED", "PHONE_REQUESTED", "CANCELLED"],
  CANCELLED: ["QR_REQUESTED", "PHONE_REQUESTED"],
  REAUTH_REQUIRED: ["QR_REQUESTED", "PHONE_REQUESTED", "AUTHORIZED", "CANCELLED"]
};

/**
 * Validates Telegram authorization state transitions.
 */
export function canTransitionAuthorization(
  from: TelegramAuthorizationMachineState,
  to: TelegramAuthorizationMachineState
): boolean {
  return transitions[from].includes(to);
}
