'use client';

import type { AuditProofPackage } from '@belflow/sdk';
import { FileCheck2, KeyRound } from 'lucide-react';
import { useEffect, useState } from 'react';
import { AuditProofCard, type IssuedProof } from '@/components/compliance/AuditProofCard';
import { PageHeader } from '@/components/shell/PageHeader';
import { Amount } from '@/components/ui/Amount';
import { Button } from '@/components/ui/Button';
import { cn } from '@/components/ui/cn';
import { Field, Input } from '@/components/ui/Field';
import { HashChip } from '@/components/ui/HashChip';
import { Notice } from '@/components/ui/Notice';
import { Panel } from '@/components/ui/Panel';
import { apiPost, errorMessage } from '@/lib/api';
import { encryptForLink, generateLinkKey } from '@/lib/crypto';
import { loadReceipts, type PaymentReceipt } from '@/lib/vault';
import { useBeldexStore } from '@/store/useBeldexStore';

interface CreateProofResponse {
  proofId: string;
  package: AuditProofPackage;
  assetVerificationLevel: string | null;
  blockHeight: number | null;
}

async function issueProof(receipt: PaymentReceipt, passcode: string): Promise<IssuedProof> {
  const linkKey = await generateLinkKey();
  const txKeyEncrypted = await encryptForLink(linkKey, receipt.txKey);
  const created = await apiPost<CreateProofResponse>('/api/audit', {
    network: receipt.network,
    txHash: receipt.txHash,
    txKey: receipt.txKey,
    txKeyEncrypted,
    recipientAddress: receipt.recipientAddress,
    ...(receipt.recipientBns ? { recipientBns: receipt.recipientBns } : {}),
    tokenId: receipt.tokenId,
    amount: receipt.amount,
    ...(receipt.memo ? { invoiceReference: receipt.memo.slice(0, 80) } : {}),
    ...(passcode ? { passcode } : {}),
  });
  return {
    proofId: created.proofId,
    link: `${window.location.origin}/verify/${created.proofId}#k=${linkKey}`,
    txHash: receipt.txHash,
    recipient: receipt.recipientBns ?? receipt.recipientAddress,
    amount: created.package.disclosedAmount,
    ticker: created.package.tokenTicker,
    assetVerificationLevel: created.assetVerificationLevel,
    blockHeight: created.blockHeight,
    packageJson: JSON.stringify({ ...created.package, txKey: receipt.txKey }, null, 2),
  };
}

export default function CompliancePage() {
  const network = useBeldexStore((state) => state.network);
  const tick = useBeldexStore((state) => state.refreshTick);
  const [receipts, setReceipts] = useState<PaymentReceipt[] | null>(null);
  const [vaultError, setVaultError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [passcode, setPasscode] = useState('');
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [proof, setProof] = useState<IssuedProof | null>(null);

  useEffect(() => {
    loadReceipts().then(
      (all) => setReceipts(all.filter((receipt) => receipt.network === network)),
      (cause: unknown) => setVaultError(errorMessage(cause)),
    );
  }, [network, tick]);

  const current = receipts?.find((receipt) => receipt.id === selected) ?? null;

  const handleGenerate = async () => {
    if (!current) return;
    setIsBusy(true);
    setError(null);
    setProof(null);
    try {
      setProof(await issueProof(current, passcode));
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setIsBusy(false);
    }
  };

  return (
    <>
      <PageHeader
        index="05"
        title="Selective compliance"
        lede="Prove one payment to an accountant or tax authority with its tx secret key. check_tx_key confirms the amount reached that address; nothing else in the treasury is revealed."
      />
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
        <Panel kicker="Encrypted vault" title="Payments with tx keys">
          {vaultError && <Notice tone="error">{vaultError}</Notice>}
          {receipts && receipts.length === 0 && (
            <p className="text-sm text-ink-3">No receipts in this browser for {network}. Run a payroll first; its tx keys are stored here, encrypted.</p>
          )}
          <ul className="space-y-2" data-testid="receipt-list">
            {receipts?.map((receipt) => {
              const isSelected = receipt.id === selected;
              return (
                <li key={receipt.id}>
                  <button
                    type="button"
                    onClick={() => {
                      setSelected(receipt.id);
                      setProof(null);
                    }}
                    aria-pressed={isSelected}
                    className={cn(
                      'grid w-full grid-cols-[1fr_auto] items-center gap-3 rounded-[8px] border px-3 py-2.5 text-left transition-colors duration-150',
                      isSelected ? 'border-vault bg-vault-soft' : 'border-rule hover:border-rule-strong hover:bg-paper-2',
                    )}
                  >
                    <span className="min-w-0">
                      <span className="block truncate font-medium text-ink">{receipt.recipientBns ?? receipt.recipientInput}</span>
                      <span className="block truncate text-xs text-ink-3">{receipt.memo ?? `tx ${receipt.txHash.slice(0, 12)}…`}</span>
                    </span>
                    <Amount value={receipt.amount} ticker={receipt.tokenTicker} />
                  </button>
                </li>
              );
            })}
          </ul>
        </Panel>

        <div className="space-y-6">
          <Panel kicker="Disclosure" title="Generate proof" tone="raised">
            {!current ? (
              <p className="flex items-center gap-2 text-sm text-ink-3">
                <FileCheck2 className="size-4" aria-hidden /> Select a payment to disclose.
              </p>
            ) : (
              <div className="space-y-4">
                <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
                  <dt className="text-ink-3">To</dt>
                  <dd className="truncate">{current.recipientBns ?? current.recipientAddress}</dd>
                  <dt className="text-ink-3">Tx</dt>
                  <dd>
                    <HashChip value={current.txHash} />
                  </dd>
                </dl>
                <Field label="Auditor passcode (optional)" htmlFor="passcode" hint="Adds a second factor to the link. Stored as a scrypt hash.">
                  <Input id="passcode" type="password" minLength={8} value={passcode} onChange={(e) => setPasscode(e.target.value)} autoComplete="new-password" />
                </Field>
                <Button size="lg" variant="vault" className="w-full" onClick={handleGenerate} disabled={isBusy || (passcode.length > 0 && passcode.length < 8)} data-testid="generate-proof">
                  <KeyRound className="size-4" aria-hidden />
                  {isBusy ? 'Verifying on chain…' : 'Generate selective audit proof'}
                </Button>
              </div>
            )}
            {error && <Notice tone="error" className="mt-4">{error}</Notice>}
          </Panel>
          {proof && <AuditProofCard proof={proof} />}
        </div>
      </div>
    </>
  );
}
