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
  "customer:search-external"
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
    "crm:conversation:assign",
    "crm:conversation:claim",
    "crm:conversation:status",
    "crm:tag:manage",
    "crm:tag:apply",
    "crm:note:write",
    "crm:contact:read",
    ...PRIVILEGED_CUSTOMER_PRIVACY
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
    "crm:contact:read"
    // Staff intentionally has no customer:* direct-contact / export / external-search permissions.
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
