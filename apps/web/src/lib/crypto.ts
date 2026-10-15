// AES-256-GCM helpers on WebCrypto. Ciphertext format: base64url(iv).base64url(ct).
// Keys that travel in links are raw 32-byte keys in base64url, placed in the
// URL fragment (#k=...) which browsers never send to the server.

const IV_BYTES = 12;
const KEY_BYTES = 32;

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(text.length / 4) * 4, '=');
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export async function generateLinkKey(): Promise<string> {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(KEY_BYTES)));
}

const LINK_KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/;

async function importRawKey(linkKey: string): Promise<CryptoKey> {
  if (!LINK_KEY_PATTERN.test(linkKey)) throw new Error('Invalid decryption key in link.');
  const raw = fromBase64Url(linkKey);
  if (raw.length !== KEY_BYTES) throw new Error('Invalid decryption key in link.');
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function encryptWithKey(key: CryptoKey, plaintext: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext));
  return `${toBase64Url(iv)}.${toBase64Url(new Uint8Array(ciphertext))}`;
}

export async function decryptWithKey(key: CryptoKey, payload: string): Promise<string> {
  const [iv, body] = payload.split('.');
  if (!iv || !body) throw new Error('Malformed ciphertext.');
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64Url(iv) }, key, fromBase64Url(body));
  return new TextDecoder().decode(plaintext);
}

export async function encryptForLink(linkKey: string, plaintext: string): Promise<string> {
  return encryptWithKey(await importRawKey(linkKey), plaintext);
}

export async function decryptFromLink(linkKey: string, payload: string): Promise<string> {
  return decryptWithKey(await importRawKey(linkKey), payload);
}

/** Reads `k` from the current URL fragment. */
export function linkKeyFromHash(hash: string): string | null {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  const key = params.get('k');
  return key && LINK_KEY_PATTERN.test(key) ? key : null;
}
