import 'server-only';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { LocalMockChainApi, MockChain, parseUnits, BDX_DECIMALS, type MockChainState } from '@belflow/sdk';
import { serverEnv } from './env';

/** Well-known mock identities. Labels are deterministic account seeds. */
export const MOCK_ACCOUNTS = {
  treasury: { label: 'treasury', bns: 'tesoreria.bdx', faucetBdx: '250000' },
  customer: { label: 'customer', bns: 'cliente-demo.bdx', faucetBdx: '50000' },
  agent: { label: 'alpha-bot', bns: 'alpha-bot.bdx', faucetBdx: '5000' },
  oracle: { label: 'oracle-provider', bns: 'oracle-provider.bdx', faucetBdx: '0' },
} as const;

/** Employees seeded with BNS names so the payroll demo resolves .bdx out of the box. */
export const MOCK_EMPLOYEES = ['devteam', 'agente01', 'juan', 'maria', 'camila', 'mateo', 'valentina', 'lucas'] as const;

interface MockRuntime {
  chain: MockChain;
  api: LocalMockChainApi;
}

const globalForMock = globalThis as unknown as { belflowMock?: MockRuntime };

function stateFile(): string {
  return path.resolve(process.cwd(), serverEnv().BELFLOW_MOCK_STATE_FILE);
}

function load(seed: string): MockChain {
  try {
    const snapshot = JSON.parse(readFileSync(stateFile(), 'utf8')) as MockChainState;
    if (snapshot.seed === seed) return MockChain.fromSnapshot(snapshot);
  } catch {
    // First run or unreadable file: start a fresh deterministic chain.
  }
  return seedChain(new MockChain({ seed }));
}

/** Registers the demo identities, BNS names and faucet balances. */
export function seedChain(chain: MockChain): MockChain {
  for (const account of Object.values(MOCK_ACCOUNTS)) {
    const address = chain.createAccount(account.label);
    chain.registerBns(account.bns, address);
    if (account.faucetBdx !== '0') chain.faucet(address, parseUnits(account.faucetBdx, BDX_DECIMALS));
  }
  for (const name of MOCK_EMPLOYEES) {
    chain.registerBns(`${name}.bdx`, chain.createAccount(`employee:${name}`));
  }
  return chain;
}

function persist(chain: MockChain): void {
  const file = stateFile();
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  writeFileSync(temp, JSON.stringify(chain.snapshot()), 'utf8');
  renameSync(temp, file);
}

/** Process-wide mock chain shared by the bridge, the treasury and the verifiers. */
export function mockRuntime(): MockRuntime {
  if (!globalForMock.belflowMock) {
    const chain = load(serverEnv().BELFLOW_MOCK_SEED);
    persist(chain);
    globalForMock.belflowMock = { chain, api: new LocalMockChainApi(chain, persist) };
  }
  return globalForMock.belflowMock;
}

/** Deterministic address of a seeded mock identity. */
export function mockAddress(label: string): string {
  return mockRuntime().chain.createAccount(label);
}
