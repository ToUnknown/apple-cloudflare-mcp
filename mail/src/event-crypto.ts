import type { Subscription } from "./events";
async function encryptionKey(value: string | undefined) {
  if (!value || !/^[A-Za-z0-9+/]{43}=$/.test(value))
    throw new Error("Configure EVENTS_ENCRYPTION_KEY");
  const bytes = Buffer.from(value, "base64");
  if (bytes.length !== 32) throw new Error("Invalid encryption key");
  return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}
export async function seal(
  value: unknown,
  keyText: string | undefined,
  id: string,
): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await encryptionKey(keyText);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(id) },
    key,
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return Buffer.concat([Buffer.from(iv), Buffer.from(ciphertext)]).toString(
    "base64",
  );
}
export async function unseal<T = Subscription>(
  value: string,
  keyText: string | undefined,
  id: string,
): Promise<T> {
  const bytes = Buffer.from(value, "base64");
  const key = await encryptionKey(keyText);
  const data = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: bytes.subarray(0, 12),
      additionalData: new TextEncoder().encode(id),
    },
    key,
    bytes.subarray(12),
  );
  return JSON.parse(new TextDecoder().decode(data));
}
