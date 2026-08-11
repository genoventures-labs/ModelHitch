/**
 * Where end-user API keys live for the BYOK flow. ModelHitch reads keys from
 * here when the app doesn't pass one explicitly — the key never needs to touch
 * your backend.
 */
export interface KeyStore {
  get(providerId: string): Promise<string | null>;
  set(providerId: string, apiKey: string): Promise<void>;
  delete(providerId: string): Promise<void>;
}
