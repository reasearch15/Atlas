import type { PushDeviceDto } from "@atlas/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEVICE_ID_STORAGE_KEY,
  DISABLED_STORAGE_KEY,
  TOKEN_STORAGE_KEY,
  isPushDisabledOnThisDevice,
  isThisDeviceRegistered
} from "./push-client";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
    clear: () => values.clear()
  };
}

const device: PushDeviceDto = {
  id: "device-1",
  platform: "ANDROID",
  deviceName: "Chrome",
  appVersion: "web-1",
  lastSeenAt: "2026-08-06T00:00:00.000Z",
  createdAt: "2026-08-06T00:00:00.000Z",
  updatedAt: "2026-08-06T00:00:00.000Z",
  lastSuccessfulDeliveryAt: null,
  lastFailedDeliveryAt: null
};

describe("push device state", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubBrowser(storage = memoryStorage()) {
    vi.stubGlobal("window", { localStorage: storage });
    vi.stubGlobal("navigator", { userAgent: "Chrome" });
    return storage;
  }

  it("treats the device as unregistered when locally opted out", () => {
    const storage = stubBrowser();
    storage.setItem(TOKEN_STORAGE_KEY, "token");
    storage.setItem(DEVICE_ID_STORAGE_KEY, "device-1");
    storage.setItem(DISABLED_STORAGE_KEY, "1");

    expect(isPushDisabledOnThisDevice()).toBe(true);
    expect(isThisDeviceRegistered([device])).toBe(false);
  });

  it("treats the device as registered when token + device id match the server list", () => {
    const storage = stubBrowser();
    storage.setItem(TOKEN_STORAGE_KEY, "token");
    storage.setItem(DEVICE_ID_STORAGE_KEY, "device-1");

    expect(isThisDeviceRegistered([device])).toBe(true);
  });

  it("treats the device as unregistered when the server no longer lists it", () => {
    const storage = stubBrowser();
    storage.setItem(TOKEN_STORAGE_KEY, "token");
    storage.setItem(DEVICE_ID_STORAGE_KEY, "device-1");

    expect(isThisDeviceRegistered([])).toBe(false);
  });
});
