import 'server-only';
import { BDX_DECIMALS, NATIVE_TOKEN_ID, parseUnits } from '@belflow/sdk';
import { recordActivity } from './activity';
import type { TokenDeployInput } from './assetDescriptor';
import { db } from './db';
import { HttpError } from './errors';
import { mockRuntime } from './mockChain';
import { getRuntime, type AppNetwork } from './runtime';

export interface TokenInfo {
  tokenId: string;
  ticker: string;
  name: string;
  decimals: number;
  isNativeBdx: boolean;
  creatorAddr?: string;
}

export const BDX_TOKEN: TokenInfo = { tokenId: NATIVE_TOKEN_ID, ticker: 'BDX', name: 'Beldex', decimals: BDX_DECIMALS, isNativeBdx: true };

/** BDX plus every Privacy Token known for the network (registry + mock chain). */
export async function listTokens(network: AppNetwork): Promise<TokenInfo[]> {
  const rows = await db.privacyTokenRegistry.findMany({ where: { network }, orderBy: { createdAt: 'asc' } });
  const tokens = new Map<string, TokenInfo>(
    rows.map((row) => [row.tokenId, { tokenId: row.tokenId, ticker: row.ticker, name: row.name, decimals: row.decimals, isNativeBdx: false, creatorAddr: row.creatorAddr }]),
  );
  if (network === 'mock-devnet') {
    for (const asset of mockRuntime().chain.listAssets()) {
      if (!tokens.has(asset.assetId)) {
        tokens.set(asset.assetId, { tokenId: asset.assetId, ticker: asset.ticker, name: asset.name, decimals: asset.decimals, isNativeBdx: false, creatorAddr: asset.owner });
      }
    }
  }
  return [BDX_TOKEN, ...tokens.values()];
}

export async function getToken(network: AppNetwork, tokenId: string): Promise<TokenInfo> {
  const token = (await listTokens(network)).find((t) => t.tokenId === tokenId);
  if (!token) throw new HttpError(400, `Unknown token ${tokenId} on ${network}.`, 'UNKNOWN_TOKEN');
  return token;
}

/** Finds a token by ticker (case-insensitive) or id. */
export async function findToken(network: AppNetwork, tickerOrId: string): Promise<TokenInfo | undefined> {
  const needle = tickerOrId.trim().toLowerCase();
  return (await listTokens(network)).find((t) => t.ticker.toLowerCase() === needle || t.tokenId.toLowerCase() === needle);
}

export async function toAtomic(network: AppNetwork, tokenId: string, amount: string): Promise<bigint> {
  return parseUnits(amount, (await getToken(network, tokenId)).decimals);
}

export async function deployToken(network: AppNetwork, input: TokenDeployInput): Promise<TokenInfo> {
  if ((await listTokens(network)).some((t) => t.ticker.toLowerCase() === input.ticker.toLowerCase())) {
    throw new HttpError(409, `A token with ticker ${input.ticker} already exists on ${network}.`, 'DUPLICATE_TICKER');
  }
  const runtime = await getRuntime(network);
  const token = await runtime.treasury.mintPrivacyToken({
    ticker: input.ticker,
    name: input.name,
    decimals: input.decimals,
    totalSupply: input.totalSupply,
  });
  await db.privacyTokenRegistry.create({
    data: {
      tokenId: token.tokenId,
      ticker: token.ticker,
      name: token.name,
      decimals: token.decimals,
      creatorAddr: runtime.treasuryAddress,
      network,
      deployTxHash: token.deployTxHash ?? null,
    },
  });
  if (token.deployTxHash) {
    await recordActivity({ network, kind: 'TOKEN_DEPLOY', txHash: token.deployTxHash, feeAtomic: token.deployFeeAtomic ?? '0', burnedAtomic: '0', tokenId: token.tokenId });
  }
  return { tokenId: token.tokenId, ticker: token.ticker, name: token.name, decimals: token.decimals, isNativeBdx: false, creatorAddr: runtime.treasuryAddress };
}
