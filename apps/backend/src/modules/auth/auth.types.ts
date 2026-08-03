import type { Role } from "@atlas/shared";

export interface RequestUser {
  readonly id: string;
  readonly email: string;
  readonly name: string;
  readonly role: Role;
  readonly workspaceId: string | null;
  readonly sessionId: string;
}

declare module "fastify" {
  interface FastifyRequest {
    user?: RequestUser;
  }
}
