export const roles = ["PLATFORM_ADMIN", "COADMIN", "STAFF"] as const;

export type Role = (typeof roles)[number];

export const permissions = [
  "workspace:read",
  "workspace:update",
  "staff:read",
  "staff:write",
  "session:read",
  "session:revoke",
  "audit:read",
  "dashboard:read",
  "developer-app:read",
  "developer-app:manage",
  "telegram:account:read",
  "telegram:account:manage",
  "telegram:chat:read",
  "telegram:message:read",
  "telegram:message:send",
  "telegram:message:delete",
  "crm:conversation:assign",
  "crm:conversation:claim",
  "crm:conversation:status",
  "crm:tag:manage",
  "crm:tag:apply",
  "crm:note:write",
  "crm:contact:read",
  "customer:phone:view",
  "customer:telegram-username:view",
  "customer:external-ids:view",
  "customer:email:view",
  "customer:export",
  "customer:search-external",
  "leaderboard:read",
  "leaderboard:deposit",
  "leaderboard:referral:set",
  "leaderboard:promotion",
  "leaderboard:give-info",
  "leaderboard:settings",
  "leaderboard:reverse",
  "leaderboard:referral:override",
  "leaderboard:finalize",
  "leaderboard:payout:mark",
  "leaderboard:eligibility:review",
  "leaderboard:telegram:manage",
  "leaderboard:telegram:verify",
  "leaderboard:eligibility:verify",
  "leaderboard:wheel:spin",
  "leaderboard:wheel:manage"
] as const;

export type Permission = (typeof permissions)[number];

const PRIVILEGED_CUSTOMER_PRIVACY: readonly Permission[] = [
  "customer:phone:view",
  "customer:telegram-username:view",
  "customer:external-ids:view",
  "customer:email:view",
  "customer:export",
  "customer:search-external"
];

export const rolePermissions = {
  PLATFORM_ADMIN: [...permissions],
  COADMIN: [
    "workspace:read",
    "workspace:update",
    "staff:read",
    "staff:write",
    "session:read",
    "session:revoke",
    "audit:read",
    "dashboard:read",
    "developer-app:read",
    "developer-app:manage",
    "telegram:account:read",
    "telegram:account:manage",
    "telegram:chat:read",
    "telegram:message:read",
    "telegram:message:send",
    "telegram:message:delete",
    "crm:conversation:assign",
    "crm:conversation:claim",
    "crm:conversation:status",
    "crm:tag:manage",
    "crm:tag:apply",
    "crm:note:write",
    "crm:contact:read",
    ...PRIVILEGED_CUSTOMER_PRIVACY,
    "leaderboard:read",
    "leaderboard:deposit",
    "leaderboard:referral:set",
    "leaderboard:promotion",
    "leaderboard:give-info",
    "leaderboard:settings",
    "leaderboard:reverse",
    "leaderboard:referral:override",
    "leaderboard:finalize",
    "leaderboard:payout:mark",
    "leaderboard:eligibility:review",
    "leaderboard:telegram:manage",
    "leaderboard:telegram:verify",
    "leaderboard:eligibility:verify",
    "leaderboard:wheel:spin",
    "leaderboard:wheel:manage"
  ],
  STAFF: [
    "workspace:read",
    "session:read",
    "session:revoke",
    "dashboard:read",
    "telegram:account:read",
    "telegram:chat:read",
    "telegram:message:read",
    "telegram:message:send",
    "crm:conversation:claim",
    "crm:conversation:status",
    "crm:tag:apply",
    "crm:note:write",
    "crm:contact:read",
    "leaderboard:read",
    "leaderboard:deposit",
    "leaderboard:referral:set",
    "leaderboard:promotion",
    "leaderboard:give-info",
    "leaderboard:wheel:spin"
    // Staff intentionally has no customer:* or Phase 3 leaderboard admin permissions.
  ]
} satisfies Record<Role, readonly Permission[]>;

/**
 * Checks whether a role grants a permission.
 */
export function hasPermission(role: Role, permission: Permission): boolean {
  return (rolePermissions[role] as readonly Permission[]).includes(permission);
}

/**
 * Returns true when the role can cross workspace boundaries.
 */
export function isPlatformRole(role: Role): boolean {
  return role === "PLATFORM_ADMIN";
}
