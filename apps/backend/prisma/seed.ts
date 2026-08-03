import { pathToFileURL } from "node:url";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

const fixtureWorkspaces = {
  acme: {
    fixtureKey: "dev.workspace.acme",
    name: "Acme Operations",
    slug: "acme"
  },
  globex: {
    fixtureKey: "dev.workspace.globex",
    name: "Globex Support",
    slug: "globex"
  }
} as const;

const fixtureUsers = {
  acmeCoadmin: {
    fixtureKey: "dev.user.acme-coadmin",
    email: "coadmin@acme.local",
    name: "Acme Coadmin",
    role: "COADMIN" as const
  },
  acmeStaff: {
    fixtureKey: "dev.user.acme-staff",
    email: "staff@acme.local",
    name: "Acme Staff",
    role: "STAFF" as const
  },
  globexCoadmin: {
    fixtureKey: "dev.user.globex-coadmin",
    email: "coadmin@globex.local",
    name: "Globex Coadmin",
    role: "COADMIN" as const
  }
} as const;

/**
 * Seeds optional development fixture workspaces and users.
 */
export async function seedDatabase(client: Pick<PrismaClient, "workspace" | "user">, env: NodeJS.ProcessEnv): Promise<void> {
  if (env.NODE_ENV === "production") {
    throw new Error("Database seed is disabled in production.");
  }

  if (env.ENABLE_DEV_FIXTURES !== "true") {
    console.info("Development fixtures skipped. Set ENABLE_DEV_FIXTURES=true outside production to seed demo workspace users.");
    return;
  }

  const acme = await client.workspace.upsert({
    where: { slug: fixtureWorkspaces.acme.slug },
    update: {
      name: fixtureWorkspaces.acme.name,
      isDevelopmentFixture: true,
      fixtureKey: fixtureWorkspaces.acme.fixtureKey
    },
    create: {
      name: fixtureWorkspaces.acme.name,
      slug: fixtureWorkspaces.acme.slug,
      isDevelopmentFixture: true,
      fixtureKey: fixtureWorkspaces.acme.fixtureKey
    }
  });

  const globex = await client.workspace.upsert({
    where: { slug: fixtureWorkspaces.globex.slug },
    update: {
      name: fixtureWorkspaces.globex.name,
      isDevelopmentFixture: true,
      fixtureKey: fixtureWorkspaces.globex.fixtureKey
    },
    create: {
      name: fixtureWorkspaces.globex.name,
      slug: fixtureWorkspaces.globex.slug,
      isDevelopmentFixture: true,
      fixtureKey: fixtureWorkspaces.globex.fixtureKey
    }
  });

  const developmentPassword = await bcrypt.hash("ChangeMe123!", 12);
  await client.user.upsert({
    where: { email: fixtureUsers.acmeCoadmin.email },
    update: {
      workspaceId: acme.id,
      name: fixtureUsers.acmeCoadmin.name,
      role: fixtureUsers.acmeCoadmin.role,
      status: "ACTIVE",
      passwordHash: developmentPassword,
      isDevelopmentFixture: true,
      fixtureKey: fixtureUsers.acmeCoadmin.fixtureKey
    },
    create: {
      workspaceId: acme.id,
      email: fixtureUsers.acmeCoadmin.email,
      name: fixtureUsers.acmeCoadmin.name,
      role: fixtureUsers.acmeCoadmin.role,
      passwordHash: developmentPassword,
      isDevelopmentFixture: true,
      fixtureKey: fixtureUsers.acmeCoadmin.fixtureKey
    }
  });

  await client.user.upsert({
    where: { email: fixtureUsers.acmeStaff.email },
    update: {
      workspaceId: acme.id,
      name: fixtureUsers.acmeStaff.name,
      role: fixtureUsers.acmeStaff.role,
      status: "ACTIVE",
      passwordHash: developmentPassword,
      isDevelopmentFixture: true,
      fixtureKey: fixtureUsers.acmeStaff.fixtureKey
    },
    create: {
      workspaceId: acme.id,
      email: fixtureUsers.acmeStaff.email,
      name: fixtureUsers.acmeStaff.name,
      role: fixtureUsers.acmeStaff.role,
      passwordHash: developmentPassword,
      isDevelopmentFixture: true,
      fixtureKey: fixtureUsers.acmeStaff.fixtureKey
    }
  });

  await client.user.upsert({
    where: { email: fixtureUsers.globexCoadmin.email },
    update: {
      workspaceId: globex.id,
      name: fixtureUsers.globexCoadmin.name,
      role: fixtureUsers.globexCoadmin.role,
      status: "ACTIVE",
      passwordHash: developmentPassword,
      isDevelopmentFixture: true,
      fixtureKey: fixtureUsers.globexCoadmin.fixtureKey
    },
    create: {
      workspaceId: globex.id,
      email: fixtureUsers.globexCoadmin.email,
      name: fixtureUsers.globexCoadmin.name,
      role: fixtureUsers.globexCoadmin.role,
      passwordHash: developmentPassword,
      isDevelopmentFixture: true,
      fixtureKey: fixtureUsers.globexCoadmin.fixtureKey
    }
  });
}

/**
 * Runs seed initialization from the command line.
 */
async function main(): Promise<void> {
  await seedDatabase(prisma, process.env);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main()
    .finally(async () => {
      await prisma.$disconnect();
    })
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
