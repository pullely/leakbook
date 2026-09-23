import { isUuid, uuidFromPublicId, uuidToHex, type Uuid } from "@saas/db/ids";

export function generateRequestId(): string {
  const buf = new Uint8Array(12);
  crypto.getRandomValues(buf);
  let hex = "";
  for (let i = 0; i < buf.length; i++) hex += buf[i]!.toString(16).padStart(2, "0");
  return `req_${hex}`;
}

export const orgPublicId = (uuid: string): string => `org_${uuidToHex(uuid)}`;
export const parseOrgPublicId = (id: string): Uuid | null => uuidFromPublicId(id, "org");

export const sitePublicId = (uuid: string): string => `ste_${uuidToHex(uuid)}`;
export const parseSitePublicId = (id: string): Uuid | null => uuidFromPublicId(id, "ste");

export const appliancePublicId = (uuid: string): string => `apl_${uuidToHex(uuid)}`;
export const parseAppliancePublicId = (id: string): Uuid | null => uuidFromPublicId(id, "apl");

export const eventPublicId = (uuid: string): string => `sev_${uuidToHex(uuid)}`;
export const parseEventPublicId = (id: string): Uuid | null => uuidFromPublicId(id, "sev");

/**
 * The actor id in the shape a UUID column takes: pass a UUID through, decode a
 * `usr_<hex>` public id, and write null rather than garbage for anything else.
 */
export function actorSubjectUuid(subjectId: string): string | null {
  if (isUuid(subjectId)) return subjectId;
  return uuidFromPublicId(subjectId);
}

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";
const QR_TOKEN_RE = /^[a-z2-7]{32}$/;

/**
 * A QR label token: 20 bytes (160 bits) from the platform CSPRNG, base32
 * (RFC 4648 alphabet, lowercase, no padding) — exactly 32 characters. It is
 * not an id and carries no structure, so a label reveals nothing.
 */
export function generateQrToken(): string {
  const bytes = new Uint8Array(20);
  crypto.getRandomValues(bytes);
  let out = "";
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(buffer >>> (bits - 5)) & 31];
      bits -= 5;
    }
    buffer &= (1 << bits) - 1;
  }
  return out;
}

export function isQrToken(value: string): boolean {
  return QR_TOKEN_RE.test(value);
}
