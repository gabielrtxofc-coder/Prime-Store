/**
 * Primas criptográficas compartilhadas pelas Edge Functions.
 *
 * Não importa nenhuma dependência externa: usa apenas WebCrypto, disponível
 * tanto no runtime Deno (Supabase Edge Functions) quanto no Node 22 (testes).
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const ENVELOPE_VERSION = 1;
const IV_LENGTH = 12;

export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Chave aleatória de alta entropia (padrão: 32 bytes = 256 bits). */
export function randomToken(bytes = 32): string {
  return toBase64(crypto.getRandomValues(new Uint8Array(bytes)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return toHex(new Uint8Array(digest));
}

/** Extrai uma subchave a partir do segredo mestre (HKDF-SHA256). */
export async function deriveKey(secret: Uint8Array, info: string): Promise<CryptoKey> {
  const baseKey = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: encoder.encode(info) },
    baseKey,
    256,
  );
  return crypto.subtle.importKey('raw', bits, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

/** HMAC-SHA256 hexadecimal, usado para detectar credenciais duplicadas. */
export async function hmacHex(secret: Uint8Array, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    secret,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(value));
  return toHex(new Uint8Array(signature));
}

/** Envelope: [versão(1) | iv(12) | ciphertext+tag]. */
export async function encryptText(key: CryptoKey, plaintext: string): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoder.encode(plaintext)),
  );
  const payload = new Uint8Array(1 + IV_LENGTH + ciphertext.length);
  payload[0] = ENVELOPE_VERSION;
  payload.set(iv, 1);
  payload.set(ciphertext, 1 + IV_LENGTH);
  return payload;
}

export async function decryptText(key: CryptoKey, payload: Uint8Array): Promise<string> {
  if (payload.length <= 1 + IV_LENGTH) {
    throw new Error('invalid_ciphertext');
  }
  if (payload[0] !== ENVELOPE_VERSION) {
    throw new Error('unsupported_envelope_version');
  }
  const iv = payload.slice(1, 1 + IV_LENGTH);
  const ciphertext = payload.slice(1 + IV_LENGTH);
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
  return decoder.decode(plaintext);
}

export interface SecretMaterial {
  encryptionKey: CryptoKey;
  fingerprintSecret: Uint8Array;
}

/**
 * Deriva as duas subchaves usadas pelo sistema a partir do segredo mestre
 * (`PRIME_ENCRYPTION_KEY`, base64 de 32 bytes). Domínios separados impedem que
 * um fingerprint revele algo sobre o ciphertext.
 */
export async function loadSecretMaterial(masterKeyBase64: string): Promise<SecretMaterial> {
  const raw = fromBase64(masterKeyBase64);
  if (raw.length < 32) {
    throw new Error('invalid_master_key');
  }
  return {
    encryptionKey: await deriveKey(raw, 'prime-store/credentials/v1'),
    fingerprintSecret: await deriveKeyBytes(raw, 'prime-store/fingerprint/v1'),
  };
}

async function deriveKeyBytes(secret: Uint8Array, info: string): Promise<Uint8Array> {
  const baseKey = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: encoder.encode(info) },
    baseKey,
    256,
  );
  return new Uint8Array(bits);
}

/** Fingerprint estável (sem segredo reversível) de uma credencial. */
export async function credentialFingerprint(
  material: SecretMaterial,
  email: string,
  password: string,
): Promise<string> {
  return hmacHex(material.fingerprintSecret, `${email.trim().toLowerCase()}\n${password}`);
}

/** Comparação em tempo constante para tokens/assinaturas. */
export function safeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}
