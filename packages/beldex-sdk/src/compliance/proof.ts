import { ValidationError } from '../errors';
import { formatUnits } from '../units';
import { buildPaymentDeclaration, canonicalJson, sha256Hex } from './declaration';

/** Portable selective-disclosure receipt for one output of one transaction. */
export interface AuditProofPackage {
  format: 'belflow-audit-proof';
  version: 1;
  proofId: string;
  network: string;
  txHash: string;
  recipientAddress: string;
  recipientBns?: string;
  tokenId: string;
  tokenTicker: string;
  decimals: number;
  amountAtomic: string;
  disclosedAmount: string;
  invoiceReference?: string;
  /** The canonical belflow-proof-v1 declaration signed by the issuer. */
  declaration: string;
  issuerAddress?: string;
  issuerSignature?: string;
  /** Included only in the auditor's copy; never stored server-side in clear. */
  txKey?: string;
  createdAt: number;
  /** SHA-256 of the canonical JSON of every other field. */
  packageHash: string;
}

export type AuditProofInput = Omit<
  AuditProofPackage,
  'format' | 'version' | 'declaration' | 'disclosedAmount' | 'packageHash'
>;

export function buildAuditProofPackage(input: AuditProofInput): AuditProofPackage {
  if (!/^\d+$/.test(input.amountAtomic)) throw new ValidationError('amountAtomic must be an integer string.');
  const declaration = buildPaymentDeclaration({
    txHash: input.txHash,
    assetId: input.tokenId,
    amountAtomic: BigInt(input.amountAtomic),
    recipientAddress: input.recipientAddress,
  });
  const body = {
    ...input,
    format: 'belflow-audit-proof' as const,
    version: 1 as const,
    declaration,
    disclosedAmount: formatUnits(BigInt(input.amountAtomic), input.decimals),
  };
  return { ...body, packageHash: hashPackage(body) };
}

function hashPackage(body: Omit<AuditProofPackage, 'packageHash'>): string {
  const { txKey: _txKey, ...hashed } = body;
  return sha256Hex(canonicalJson(hashed));
}

/** True when no field was altered after the package was built. The tx key is excluded from the hash. */
export function verifyPackageIntegrity(pkg: AuditProofPackage): boolean {
  const { packageHash, ...body } = pkg;
  return hashPackage(body) === packageHash;
}
