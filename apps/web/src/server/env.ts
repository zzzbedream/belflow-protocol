import 'server-only';
import { z } from 'zod';

const optionalUrl = z
  .string()
  .trim()
  .transform((value) => (value === '' ? undefined : value))
  .pipe(z.url().optional());

const optionalText = z
  .string()
  .trim()
  .transform((value) => (value === '' ? undefined : value))
  .optional();

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 characters.'),
  BELFLOW_PUBLIC_ORIGIN: z.url().default('http://localhost:3000'),
  BELFLOW_MOCK_SEED: z.string().min(1).default('belflow-mock-devnet'),
  BELFLOW_MOCK_STATE_FILE: z.string().min(1).default('.data/mock-chain.json'),
  BELDEX_DAEMON_RPC_URL: optionalUrl.default(''),
  BELDEX_WALLET_RPC_URL: optionalUrl.default(''),
  BELDEX_WALLET_RPC_USER: optionalText,
  BELDEX_WALLET_RPC_PASSWORD: optionalText,
  BELDEX_ASSET_DESCRIPTOR_DIR: optionalText,
  BELDEX_EXPLORER_API_URL: z.url().default('https://testnet.beldex.dev/api'),
  BELFLOW_TREASURY_ENABLED: z
    .string()
    .default('false')
    .transform((value) => value === 'true'),
  TREASURY_OPERATOR_ADDRESS: optionalText,
  BELFLOW_FAUCET_ENABLED: z
    .string()
    .default('false')
    .transform((value) => value === 'true'),
  BELFLOW_FAUCET_ACCOUNT_INDEX: z.coerce.number().int().min(0).max(1000).default(1),
  X402_PRICE: z.string().regex(/^\d+(\.\d+)?$/).default('0.50'),
  X402_TOKEN_TICKER: z.string().min(2).max(12).default('bUSD'),
  X402_RECIPIENT_BNS: z.string().default('oracle-provider.bdx'),
});

export type ServerEnv = z.infer<typeof schema>;

let cached: ServerEnv | null = null;

/** Validated server configuration. Fails fast with a readable message. */
export function serverEnv(): ServerEnv {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
    throw new Error(`Invalid BelFlow configuration: ${issues}`);
  }
  cached = parsed.data;
  return cached;
}

export function testnetConfigured(env: ServerEnv = serverEnv()): boolean {
  return Boolean(env.BELDEX_WALLET_RPC_URL);
}
