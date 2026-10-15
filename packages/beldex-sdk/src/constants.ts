// Protocol constants. Values marked "verify" were read from the
// Beldex-Coin/beldex feature-confidential-asset branch (cryptonote_config.h)
// or from the public testnet explorer in October 2026 and can change before
// mainnet. Keep them in one place so a fork upgrade is a one-file change.

export const NATIVE_TOKEN_ID = 'BDX';
export const BDX_DECIMALS = 9;

/** TX_OUTPUT_DECOYS = 9, so a ring has 10 members. */
export const RING_SIZE = 10;

/** TX_BULLETPROOF_PLUS_MAX_OUTPUTS = 16. One slot is reserved for change. */
export const MAX_TX_OUTPUTS = 16;
export const MAX_RECIPIENTS_PER_TX = MAX_TX_OUTPUTS - 1;

/** DEFAULT_TX_SPENDABLE_AGE_V17 = 2 blocks before change outputs can be spent again. */
export const CHANGE_UNLOCK_BLOCKS = 2;

/** Proto hard fork activation height on testnet (privacy tokens enabled). */
export const PROTO_TESTNET_FORK_HEIGHT = 4_242_200;

/** Base58 address prefixes (varint) per network. */
export const ADDRESS_PREFIXES = {
  mainnet: { standard: 0xd1, integrated: 19, subaddress: 42 },
  testnet: { standard: 53, integrated: 54, subaddress: 63 },
} as const;

/** Wallet RPC priority: 1 = unimportant, 5 = flash. */
export const PRIORITY_NORMAL = 1;
export const PRIORITY_FLASH = 5;

/** BNS record type for wallet addresses (0 bchat, 1 wallet, 2 belnet, 6 eth_addr). */
export const BNS_TYPE_WALLET = 1;

/**
 * Fee estimate defaults shown by the testnet explorer: 0.01 BDX per output and
 * 0.006666 BDX per kB. Real fees always come from the wallet's transfer
 * response or the daemon's fee estimate. These are only for previews.
 */
export const DEFAULT_FEE_PER_OUTPUT_ATOMIC = 10_000_000n;
export const DEFAULT_FEE_PER_KB_ATOMIC = 6_666_000n;

/**
 * Flash fee model used by the estimator (verify): flash transactions pay a
 * multiple of the base fee; the surcharge above the base fee is burned.
 */
export const FLASH_FEE_MULTIPLIER = 5n;

/** Approximate serialized size of a RingCT/Bulletproof+ transaction. */
export const TX_BASE_SIZE_BYTES = 1_500;
export const TX_SIZE_PER_OUTPUT_BYTES = 120;
export const TX_SIZE_PER_INPUT_BYTES = 700;
