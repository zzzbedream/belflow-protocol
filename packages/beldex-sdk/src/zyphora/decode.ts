// Wallet-free tx_key verification of Beldex privacy token outputs.
//
// On feature-privacy-token, check_tx_key already decodes tx_out_zyphora
// outputs and returns token_received, but it needs a wallet opened in
// beldex-wallet-rpc. This module performs the same decode
// (decode_zyphora_output in cryptonote_format_utils.cpp) for a verifier that
// only has txid + tx_key + recipient address and the transaction from a
// trusted daemon, e.g. a browser page or a serverless API. Every recovered
// amount is checked against the output's commitment.
import { decodeAddress } from '../address/address';
import { ValidationError } from '../errors';
import type { DaemonRpc } from '../rpc/daemon';
import { parseJsonSafe } from '../rpc/json';
import { commitToken, derivePublicKey, generateKeyDerivation, scalarToBytes, unblindTokenId, zyphoraDerivationToScalar } from './cryptonote';

export interface ZyphoraOutput {
  /** Position in tx.vout; part of every key derivation. */
  index: number;
  stealthAddress: string;
  amountCommitment: string;
  blindedTokenId: string;
  encryptedAmount: bigint;
}

export interface DecodedZyphoraOutput {
  index: number;
  /** Hex token id, the same 32 bytes wallet-rpc reports. */
  tokenId: string;
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

/**
 * Extracts tx_out_zyphora outputs from a get_transactions entry
 * (decode_as_json) or a decoded tx object. The JSON variant tag is "zyphora"
 * (VARIANT_TAG in cryptonote_basic.h).
 */
export function parseZyphoraOutputs(entry: Record<string, unknown>): ZyphoraOutput[] {
  let decoded: unknown = entry;
  if (typeof entry.as_json === 'string') decoded = parseJsonSafe<unknown>(entry.as_json);
  const vout = asRecord(decoded)?.vout;
  if (!Array.isArray(vout)) return [];
  const outputs: ZyphoraOutput[] = [];
  vout.forEach((raw, index) => {
    const zout = asRecord(asRecord(asRecord(raw)?.target)?.zyphora);
    if (!zout) return;
    const { stealth_address: stealth, amount_commitment: commitment, blinded_token_id: blinded } = zout;
    const encrypted = asUint64(zout.encrypted_amount);
    if (typeof stealth !== 'string' || typeof commitment !== 'string' || typeof blinded !== 'string' || encrypted === null) return;
    if (![stealth, commitment, blinded].every((value) => HEX32.test(value))) return;
    outputs.push({ index, stealthAddress: stealth.toLowerCase(), amountCommitment: commitment.toLowerCase(), blindedTokenId: blinded.toLowerCase(), encryptedAmount: encrypted });
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

function decodeOne(output: ZyphoraOutput, derivation: string): DecodedZyphoraOutput {
  const tokenBlind = zyphoraDerivationToScalar(derivation, output.index, 'token_blind');
  const tokenId = unblindTokenId(output.blindedTokenId, tokenBlind);
  const amountMask = zyphoraDerivationToScalar(derivation, output.index, 'amount_mask');
  const encMask = scalarToBytes(zyphoraDerivationToScalar(derivation, output.index, 'enc_amount'));
  const encMask64 = new DataView(encMask.buffer, encMask.byteOffset, 8).getBigUint64(0, true);
  const amount = output.encryptedAmount ^ encMask64;
  // The commitment is built on the output's own blinded id T (rct::commitToken).
  if (commitToken(amountMask, output.blindedTokenId, amount) !== output.amountCommitment) {
    throw new ValidationError(`Output ${output.index}: amount commitment does not match the decoded amount.`);
  }
  return { index: output.index, tokenId, amountAtomic: amount };
}

/**
 * Decodes the privacy token outputs that pay `address`, using the payer's
 * tx_key. Returns [] when none pays the address; throws when an output that
 * pays the address fails its commitment check (corrupted or forged data).
 */
export function decodeZyphoraWithTxKey(params: { outputs: ZyphoraOutput[]; txKey: string; address: string }): DecodedZyphoraOutput[] {
  const { viewPublicKey, spendPublicKey } = decodeAddress(params.address);
  const { main, additional } = splitTxKeys(params.txKey);
  const mainDerivation = generateKeyDerivation(viewPublicKey, main);
  const decoded: DecodedZyphoraOutput[] = [];
  for (const output of params.outputs) {
    const extra = additional[output.index];
    const candidates = [mainDerivation, extra ? generateKeyDerivation(viewPublicKey, extra) : null];
    const derivation = candidates.find((candidate) => candidate !== null && derivePublicKey(candidate, output.index, spendPublicKey) === output.stealthAddress);
    if (derivation) decoded.push(decodeOne(output, derivation));
  }
  return decoded;
}

/** Verification source for verifyPayment: reads the tx from a trusted daemon and decodes it with the tx_key. */
export function createZyphoraTxKeySource(daemon: DaemonRpc) {
  return async (txHash: string, txKey: string, address: string): Promise<DecodedZyphoraOutput[] | null> => {
    const [entry] = await daemon.getTransactions([txHash]);
    if (!entry) return null;
    const outputs = parseZyphoraOutputs(entry as unknown as Record<string, unknown>);
    return outputs.length > 0 ? decodeZyphoraWithTxKey({ outputs, txKey, address }) : null;
  };
}
