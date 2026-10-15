import { md5 } from '@noble/hashes/legacy.js';
import { bytesToHex, randomBytes, utf8ToBytes } from '@noble/hashes/utils.js';

// HTTP Digest (RFC 7616, MD5 + qop=auth), the scheme beldexd and
// beldex-wallet-rpc use for --rpc-login.

export interface DigestChallenge {
  realm: string;
  nonce: string;
  qop?: string;
  opaque?: string;
  algorithm?: string;
}

const PARAM_PATTERN = /(\w+)=(?:"([^"]*)"|([^\s,]+))/g;

export function parseDigestChallenge(header: string | null): DigestChallenge | null {
  if (!header || !/^Digest\s/i.test(header)) return null;
  const params: Record<string, string> = {};
  for (const match of header.matchAll(PARAM_PATTERN)) {
    const key = match[1];
    if (key) params[key.toLowerCase()] = match[2] ?? match[3] ?? '';
  }
  if (!params.realm || !params.nonce) return null;
  return {
    realm: params.realm,
    nonce: params.nonce,
    ...(params.qop ? { qop: params.qop.split(',')[0]?.trim() } : {}),
    ...(params.opaque ? { opaque: params.opaque } : {}),
    ...(params.algorithm ? { algorithm: params.algorithm } : {}),
  };
}

const hex = (value: string): string => bytesToHex(md5(utf8ToBytes(value)));

export function buildDigestAuthorization(params: {
  challenge: DigestChallenge;
  username: string;
  password: string;
  method: string;
  uri: string;
  nonceCount: number;
  cnonce?: string;
}): string {
  const { challenge, username, password, method, uri } = params;
  const nc = params.nonceCount.toString(16).padStart(8, '0');
  const cnonce = params.cnonce ?? bytesToHex(randomBytes(8));
  const ha1 = hex(`${username}:${challenge.realm}:${password}`);
  const ha2 = hex(`${method}:${uri}`);
  const response = challenge.qop
    ? hex(`${ha1}:${challenge.nonce}:${nc}:${cnonce}:${challenge.qop}:${ha2}`)
    : hex(`${ha1}:${challenge.nonce}:${ha2}`);

  const parts = [
    `username="${username}"`,
    `realm="${challenge.realm}"`,
    `nonce="${challenge.nonce}"`,
    `uri="${uri}"`,
    `algorithm=MD5`,
    `response="${response}"`,
  ];
  if (challenge.qop) parts.push(`qop=${challenge.qop}`, `nc=${nc}`, `cnonce="${cnonce}"`);
  if (challenge.opaque) parts.push(`opaque="${challenge.opaque}"`);
  return `Digest ${parts.join(', ')}`;
}
