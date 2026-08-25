/**
 * INVESTIGATION ONLY — not production code.
 *
 * Probes GramJS `contacts.ResolveUsername` using one CONNECTED Atlas Telegram
 * user-account session from the local database.
 *
 * Usage (from repo root):
 *   node --env-file=.env apps/telegram-worker/scripts/investigate-username-resolve.mjs
 *
 * Writes sanitized results to scripts/investigate-username-resolve.results.json
 * (no session strings, no apiHash, no phone numbers).
 */
import { createDecipheriv, hkdfSync } from "node:crypto";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";
import { TelegramClient, Api } from "telegram";
import { StringSession } from "telegram/sessions/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RESULTS_PATH = join(__dirname, "investigate-username-resolve.results.json");
const algorithm = "aes-256-gcm";

const USERNAMES = [
  { label: "known_public_user", username: "durov" },
  { label: "bot", username: "BotFather" },
  { label: "channel", username: "telegram" },
  { label: "group_or_supergroup", username: "tginfo" },
  { label: "nonexistent", username: "atlas_username_that_does_not_exist_zzz_999" },
  { label: "invalid_format", username: "ab" },
  { label: "invalid_chars", username: "bad user!" }
];

function deriveKey(masterKey) {
  return Buffer.from(
    hkdfSync(
      "sha256",
      Buffer.from(masterKey, "utf8"),
      Buffer.from("atlas.telegram.session.v1", "utf8"),
      Buffer.from("telegram-session", "utf8"),
      32
    )
  );
}

function decryptEnvelope(envelope, masterKey) {
  const decipher = createDecipheriv(algorithm, deriveKey(masterKey), Buffer.from(envelope.iv, "base64url"));
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, "base64url")),
    decipher.final()
  ]).toString("utf8");
}

function summarizeEntity(entity) {
  if (!entity) return null;
  const className = entity.className ?? entity._ ?? typeof entity;
  return {
    className: String(className),
    id: entity.id != null ? String(entity.id) : null,
    username: entity.username ?? null,
    firstName: entity.firstName ?? null,
    lastName: entity.lastName ?? null,
    title: entity.title ?? null,
    bot: Boolean(entity.bot),
    verified: Boolean(entity.verified),
    scam: Boolean(entity.scam),
    fake: Boolean(entity.fake),
    accessHashPresent: entity.accessHash != null && String(entity.accessHash).length > 0
  };
}

function classifyPeer(resolved) {
  const peer = resolved?.peer;
  const peerClass = peer?.className ?? peer?._ ?? null;
  const user = resolved?.users?.[0] ?? null;
  const chat = resolved?.chats?.[0] ?? null;
  let entityType = "unknown";
  if (user) {
    entityType = user.bot ? "bot" : "user";
  } else if (chat) {
    const cn = String(chat.className ?? chat._ ?? "");
    if (cn.includes("Channel") && chat.megagroup) entityType = "supergroup";
    else if (cn.includes("Channel") && chat.broadcast) entityType = "channel";
    else if (cn.includes("Channel")) entityType = "channel_or_supergroup";
    else if (cn.includes("Chat")) entityType = "basic_group";
    else entityType = "chat";
  }
  return { peerClass, entityType, user: summarizeEntity(user), chat: summarizeEntity(chat) };
}

async function main() {
  const masterKey = process.env.TELEGRAM_SESSION_ENCRYPTION_KEY;
  if (!masterKey || masterKey.length < 64) {
    throw new Error("TELEGRAM_SESSION_ENCRYPTION_KEY missing or too short");
  }
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL missing");
  }

  const prisma = new PrismaClient();
  const startedAt = new Date().toISOString();
  /** @type {Record<string, unknown>} */
  const report = {
    startedAt,
    library: "telegram (GramJS)",
    libraryVersion: "2.26.22",
    method: "contacts.ResolveUsername",
    account: null,
    results: [],
    fatalError: null
  };

  let client = null;
  try {
    const account = await prisma.telegramAccount.findFirst({
      where: {
        status: "CONNECTED",
        sessionEncrypted: { not: null },
        developerApp: { status: "ACTIVE", deletedAt: null }
      },
      include: {
        developerApp: { select: { apiId: true, encryptedApiHash: true, displayName: true } }
      },
      orderBy: { lastConnectedAt: "desc" }
    });

    if (!account) {
      report.fatalError = "No CONNECTED TelegramAccount with session found in local DB";
      writeFileSync(RESULTS_PATH, JSON.stringify(report, null, 2));
      console.error(report.fatalError);
      process.exitCode = 2;
      return;
    }

    report.account = {
      id: account.id,
      displayName: account.displayName,
      telegramUserId: account.telegramUserId,
      telegramUsername: account.telegramUsername,
      developerAppDisplayName: account.developerApp.displayName,
      apiId: account.developerApp.apiId
    };

    const apiHash = decryptEnvelope(account.developerApp.encryptedApiHash, masterKey);
    const sessionPayload = JSON.parse(decryptEnvelope(account.sessionEncrypted, masterKey));
    const sessionText = typeof sessionPayload === "string" ? sessionPayload : sessionPayload.session;
    if (!sessionText) {
      throw new Error("Decrypted session payload missing session string");
    }

    client = new TelegramClient(new StringSession(sessionText), account.developerApp.apiId, apiHash, {
      connectionRetries: 3,
      autoReconnect: false
    });
    await client.connect();

    for (const probe of USERNAMES) {
      const username = probe.username.replace(/^@/, "");
      const started = Date.now();
      /** @type {Record<string, unknown>} */
      const row = {
        label: probe.label,
        username,
        ok: false,
        durationMs: 0,
        errorClass: null,
        errorCode: null,
        errorMessage: null,
        classification: null,
        rawKeys: null
      };

      try {
        const resolved = await client.invoke(new Api.contacts.ResolveUsername({ username }));
        row.ok = true;
        row.durationMs = Date.now() - started;
        row.classification = classifyPeer(resolved);
        row.rawKeys = {
          peer: resolved?.peer ? Object.keys(resolved.peer) : null,
          usersCount: Array.isArray(resolved?.users) ? resolved.users.length : 0,
          chatsCount: Array.isArray(resolved?.chats) ? resolved.chats.length : 0,
          className: resolved?.className ?? resolved?._ ?? null
        };
        console.log(`[OK] @${username} → ${row.classification.entityType}`);
      } catch (error) {
        row.durationMs = Date.now() - started;
        row.errorClass = error?.constructor?.name ?? typeof error;
        row.errorCode = error?.errorMessage ?? error?.code ?? null;
        row.errorMessage = String(error?.message ?? error).slice(0, 400);
        console.log(`[FAIL] @${username} → ${row.errorCode || row.errorClass}: ${row.errorMessage}`);
      }

      report.results.push(row);
      await new Promise((r) => setTimeout(r, 1200));
    }
  } catch (error) {
    report.fatalError = String(error?.message ?? error).slice(0, 500);
    console.error("Fatal:", report.fatalError);
    process.exitCode = 1;
  } finally {
    report.finishedAt = new Date().toISOString();
    writeFileSync(RESULTS_PATH, JSON.stringify(report, null, 2));
    console.log(`Wrote ${RESULTS_PATH}`);
    if (client) {
      try {
        await client.disconnect();
      } catch {
        // ignore
      }
    }
    await prisma.$disconnect();
  }
}

await main();
