# Atlas

Atlas is a production-grade multi-tenant Telegram team workspace. Sprint 1 establishes the platform foundation: authentication, tenancy, role permissions, session/device tracking, audit logging, WebSocket infrastructure, database schema, and an operational dashboard shell.

## Architecture

- `apps/backend`: Fastify API, Prisma, Redis, BullMQ-ready infrastructure, WebSocket gateway.
- `apps/frontend`: Next.js 16, React 19, Tailwind CSS, shadcn-style primitives, TanStack Query, Zustand, React Hook Form, Zod.
- `packages/shared`: Cross-runtime contracts, validation schemas, RBAC helpers.
- `packages/types`: Shared TypeScript type exports.
- `packages/config`: Shared TypeScript and Tailwind configuration.
- `packages/ui`: Shared UI utility package.

## Local Setup

1. Install dependencies with `pnpm install`.
2. Copy `.env.example` to `.env` and set production-grade platform secrets.
3. Start PostgreSQL and Redis.
4. Run `pnpm db:generate`, `pnpm db:migrate`, and `pnpm db:seed`.
5. Run `pnpm dev`.

Telegram API credentials are workspace-owned Developer Apps created from the dashboard. Do not place tenant Telegram API IDs or hashes in `.env`.

The frontend defaults to `http://localhost:3000`; the backend defaults to `http://localhost:4000`.
