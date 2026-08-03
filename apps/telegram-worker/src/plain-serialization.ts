const primitiveTypes = new Set(["string", "number", "boolean", "undefined"]);

export class TelegramSerializationBoundaryError extends Error {
  public readonly code = "TELEGRAM_SERIALIZATION_BOUNDARY_REJECTED";

  public constructor(boundaryName: string, constructorName: string, fieldPath: string) {
    super(`Telegram serialization rejected boundary=${boundaryName} constructor=${constructorName} field=${fieldPath}`);
    this.name = "TelegramSerializationBoundaryError";
  }
}

/**
 * Rejects non-plain or circular values before they reach Redis, Prisma JSON, BullMQ results, or logs.
 */
export function assertPlainSerializable(value: unknown, boundaryName: string): void {
  inspectPlain(value, boundaryName, "$", new WeakSet<object>());
  JSON.stringify(value);
  if (typeof structuredClone === "function") {
    structuredClone(value);
  }
}

function inspectPlain(value: unknown, boundaryName: string, fieldPath: string, seen: WeakSet<object>): void {
  if (value === null || primitiveTypes.has(typeof value)) {
    return;
  }
  if (typeof value === "bigint" || typeof value === "symbol" || typeof value === "function") {
    throw new TelegramSerializationBoundaryError(boundaryName, typeof value, fieldPath);
  }
  if (typeof value !== "object") {
    return;
  }
  if (seen.has(value)) {
    throw new TelegramSerializationBoundaryError(boundaryName, constructorName(value), fieldPath);
  }
  seen.add(value);

  if (Array.isArray(value)) {
    value.forEach((entry, index) => inspectPlain(entry, boundaryName, `${fieldPath}[${index}]`, seen));
    return;
  }

  if (Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TelegramSerializationBoundaryError(boundaryName, constructorName(value), fieldPath);
  }

  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    inspectPlain(entry, boundaryName, `${fieldPath}.${key}`, seen);
  }
}

function constructorName(value: object): string {
  return value.constructor?.name || "Object";
}
