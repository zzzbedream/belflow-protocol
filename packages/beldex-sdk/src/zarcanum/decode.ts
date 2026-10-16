// Stateless tx_key verification of Beldex Confidential Asset outputs.
//
// check_tx_key on feature-confidential-asset (bc6633953127) only scans
// txout_to_key outputs, so token payments (tx_out_zarcanum) cannot be proven
// with it. decode_zarcanum_output only needs the key derivation, and a payer's
// tx_key yields the same derivation as the recipient's view key (8 * r * A).
// This module performs that decode for a verifier holding txid + tx_key +
// recipient address, and checks every recovered amount against its commitment.
import { decodeAddress } from '../address/address';
import { ValidationError } from '../errors';
import type { DaemonRpc } from '../rpc/daemon';
import { parseJsonSafe } from '../rpc/json';
import { commitAsset, derivePublicKey, generateKeyDerivation, scalarToBytes, unblindAssetId, zarcanumDerivationToScalar } from './cryptonote';

export interface ZarcanumOutput {
  /** Position in tx.vout; part of every key derivation. */
  index: number;
  stealthAddress: string;
  amountCommitment: string;
  blindedAssetId: string;
  encryptedAmount: bigint;
}

export interface DecodedZarcanumOutput {
  index: number;
  /** Hex asset id, the same 32 bytes the wallet RPC reports. */
  assetId: string;
  amountAtomic: bigint;
}

const HEX32 = /^[0-9a-f]{64}$/i;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function asUint64(value: unknown): bigint | null {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === 'string' && /^\d{1,20}$/.test(value)) return BigInt(value);
  return null;
}

/** Extracts tx_out_zarcanum outputs from a get_transactions entry (decode_as_json) or a decoded tx object. */
export function parseZarcanumOutputs(entry: Record<string, unknown>): ZarcanumOutput[] {
  let decoded: unknown = entry;
  if (typeof entry.as_json === 'string') decoded = parseJsonSafe<unknown>(entry.as_json);
  const vout = asRecord(decoded)?.vout;
  if (!Array.isArray(vout)) return [];
  const outputs: ZarcanumOutput[] = [];
  vout.forEach((raw, index) => {
    const target = asRecord(asRecord(raw)?.target);
    const zout = asRecord(target?.zarcanum) ?? (target && 'blinded_asset_id' in target ? target : null);
    if (!zout) return;
    const { stealth_address: stealth, amount_commitment: commitment, blinded_asset_id: blinded } = zout;
    const encrypted = asUint64(zout.encrypted_amount);
    if (typeof stealth !== 'string' || typeof commitment !== 'string' || typeof blinded !== 'string' || encrypted === null) return;
    if (![stealth, commitment, blinded].every((value) => HEX32.test(value))) return;
    outputs.push({ index, stealthAddress: stealth.toLowerCase(), amountCommitment: commitment.toLowerCase(), blindedAssetId: blinded.toLowerCase(), encryptedAmount: encrypted });
  });
  return outputs;
}

/** Splits a wallet tx_key string: the main key followed by one additional key per output (subaddresses). */
function splitTxKeys(txKey: string): { main: string; additional: string[] } {
  const keys = txKey.trim().toLowerCase();
  if (keys.length < 64 || keys.length % 64 !== 0 || !/^[0-9a-f]+$/.test(keys)) throw new ValidationError('tx_key must be one or more 64-hex-character keys.');
  const all = keys.match(/.{64}/g) as string[];
  return { main: all[0] as string, additional: all.slice(1) };
}

function decodeOne(output: ZarcanumOutput, derivation: string): DecodedZarcanumOutput {
  const assetBlind = zarcanumDerivationToScalar(derivation, output.index, 'asset_blind');
  const assetId = unblindAssetId(output.blindedAssetId, assetBlind);
  const amountMask = zarcanumDerivationToScalar(derivation, output.index, 'amount_mask');
  const encMask = scalarToBytes(zarcanumDerivationToScalar(derivation, output.index, 'enc_amount'));
  const encMask64 = new DataView(encMask.buffer, encMask.byteOffset, 8).getBigUint64(0, true);
  const amount = output.encryptedAmount ^ encMask64;
  if (commitAsset(amountMask, assetId, amount) !== output.amountCommitment) {
    throw new ValidationError(`Output ${output.index}: amount commitment does not match the decoded amount and asset.`);
  }
  return { index: output.index, assetId, amountAtomic: amount };
}

/**
 * Decodes the Confidential Asset outputs that pay `address`, using the payer's
 * tx_key. Returns [] when none pays the address; throws when an output that
 * pays the address fails its commitment check (corrupted or forged data).
 */
export function decodeZarcanumWithTxKey(params: { outputs: ZarcanumOutput[]; txKey: string; address: string }): DecodedZarcanumOutput[] {
  const { viewPublicKey, spendPublicKey } = decodeAddress(params.address);
  const { main, additional } = splitTxKeys(params.txKey);
  const mainDerivation = generateKeyDerivation(viewPublicKey, main);
  const decoded: DecodedZarcanumOutput[] = [];
  for (const output of params.outputs) {
    const extra = additional[output.index];
    const candidates = [mainDerivation, extra ? generateKeyDerivation(viewPublicKey, extra) : null];
    const derivation = candidates.find((candidate) => candidate !== null && derivePublicKey(candidate, output.index, spendPublicKey) === output.stealthAddress);
    if (derivation) decoded.push(decodeOne(output, derivation));
  }
  return decoded;
}

/** Verification source for verifyPayment: reads the tx from a daemon and decodes it with the tx_key. */
export function createZarcanumTxKeySource(daemon: DaemonRpc) {
  return async (txHash: string, txKey: string, address: string): Promise<DecodedZarcanumOutput[] | null> => {
    const [entry] = await daemon.getTransactions([txHash]);
    if (!entry) return null;
    const outputs = parseZarcanumOutputs(entry as unknown as Record<string, unknown>);
    return outputs.length > 0 ? decodeZarcanumWithTxKey({ outputs, txKey, address }) : null;
  };
}
