import type { KeyStore } from '../core/keystore.js';

/** In-memory KeyStore — keys last for the lifetime of the process. */
export class MemoryKeyStore implements KeyStore {
  private keys = new Map<string, string>();

  async get(providerId: string): Promise<string | null> {
    return this.keys.get(providerId) ?? null;
  }

  async set(providerId: string, apiKey: string): Promise<void> {
    this.keys.set(providerId, apiKey);
  }

  async delete(providerId: string): Promise<void> {
    this.keys.delete(providerId);
  }
}
