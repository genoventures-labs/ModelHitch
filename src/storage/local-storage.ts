import type { KeyStore } from '../core/keystore.js';

const PREFIX = 'modelhitch:key:';

/**
 * Browser KeyStore backed by localStorage. Keys never leave the user's device,
 * which is the point of the client-side BYOK flow.
 */
export class LocalStorageKeyStore implements KeyStore {
  private readonly storage: Storage;

  constructor(storage: Storage = globalThis.localStorage) {
    this.storage = storage;
  }

  async get(providerId: string): Promise<string | null> {
    return this.storage.getItem(PREFIX + providerId);
  }

  async set(providerId: string, apiKey: string): Promise<void> {
    this.storage.setItem(PREFIX + providerId, apiKey);
  }

  async delete(providerId: string): Promise<void> {
    this.storage.removeItem(PREFIX + providerId);
  }
}
