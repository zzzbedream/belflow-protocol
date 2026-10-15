// Privacy-cost comparison constants used by the dashboard.
// Sources are shown in the UI next to the numbers.

/** Railgun protocol fees: 0.25% on shield and 0.25% on unshield (L2BEAT, Oct 2026). */
export const RAILGUN_SHIELD_BPS = 25;
export const RAILGUN_UNSHIELD_BPS = 25;
export const RAILGUN_PROTOCOL_ROUND_TRIP_BPS = RAILGUN_SHIELD_BPS + RAILGUN_UNSHIELD_BPS;
/** Upper bound including off-chain relayer/broadcaster fees (BelFlow assumption, not a protocol constant). */
export const RAILGUN_WITH_RELAYER_BPS = 75;
/** Post-shield waiting period reported by third-party guides (unverified against official docs). */
export const RAILGUN_REPORTED_LOCK_MINUTES = 60;
/** Beldex privacy is native to every transaction: no shielding fee and no shielded-pool lock. */
export const BELDEX_SHIELDING_BPS = 0;

export const ECONOMICS_SOURCES = [
  { label: 'L2BEAT: Railgun fees', url: 'https://l2beat.com/privacy/projects/railgun' },
  { label: 'Beldex Confidential Assets testnet announcement', url: 'https://chainwire.org/2026/10/06/beldex-introduces-confidential-assets-for-privacy-preserving-tokens-on-testnet/' },
] as const;

const BPS_DENOMINATOR = 10_000n;

/** Fee a ZK-pool round trip would charge on `volumeAtomic`, in the same atomic units. */
export function zkPoolCostAtomic(volumeAtomic: bigint, bps: number): bigint {
  return (volumeAtomic * BigInt(bps)) / BPS_DENOMINATOR;
}

/** Tickers treated as USD-denominated for the savings card. */
export function isUsdStable(ticker: string): boolean {
  return /usd/i.test(ticker);
}
