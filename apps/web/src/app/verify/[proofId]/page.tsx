'use client';

import type { AuditProofPackage } from '@belflow/sdk';
import { Download, Printer, ShieldAlert, ShieldCheck } from 'lucide-react';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { downloadJson } from '@/components/compliance/AuditProofCard';
import { TamperSimulator } from '@/components/compliance/TamperSimulator';
import { XRayScanner, type ScanState } from '@/components/kinetic/XRayScanner';
import { Amount } from '@/components/ui/Amount';
import { Badge, statusTone } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Field, Input } from '@/components/ui/Field';
import { HashChip } from '@/components/ui/HashChip';
import { Notice } from '@/components/ui/Notice';
import { apiPost, errorMessage } from '@/lib/api';
import { decryptFromLink, linkKeyFromHash } from '@/lib/crypto';

interface ProofView {
  proofId: string;
  network: string;
  package: AuditProofPackage;
  txKeyEncrypted: string;
  createdAt: string;
}

interface Verification {
  isValid: boolean;
  assetVerificationLevel: string | null;
  blockHeight: number | null;
  confirmations: number;
  inPool: boolean;
  receivedAmount: string;
  failures: string[];
  notes: string[];
  packageIntact: boolean;
  checkedAt: string;
}

const LEVEL_TEXT: Record<string, string> = {
  CRYPTOGRAPHIC_FULL: 'The node attributed the received output to this asset.',
  DAEMON_EXTRACTED: 'The asset tag was read from the decoded transaction on the node.',
  ISSUER_SIGNED_DECLARATION: 'Amount proven by check_tx_key; the asset is bound by the payer’s wallet signature.',
};

async function fetchProof(proofId: string, passcode: string): Promise<{ proof?: ProofView; needsPasscode?: boolean }> {
  const response = await fetch(`/api/audit/${proofId}`, { headers: passcode ? { 'X-Auditor-Passcode': passcode } : {}, cache: 'no-store' });
  const body = (await response.json()) as { data: ProofView | { requiresPasscode: true } | null; error: { message: string } | null };
  if (response.status === 401) return { needsPasscode: true };
  if (!response.ok || !body.data) throw new Error(body.error?.message ?? 'Proof not found.');
  return { proof: body.data as ProofView };
}

export default function AuditorPortal() {
  const { proofId } = useParams<{ proofId: string }>();
  const [passcode, setPasscode] = useState('');
  const [needsPasscode, setNeedsPasscode] = useState(false);
  const [proof, setProof] = useState<ProofView | null>(null);
  const [txKey, setTxKey] = useState<string | null>(null);
  const [verification, setVerification] = useState<Verification | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isChecking, setIsChecking] = useState(false);

  const load = useCallback(
    async (code: string) => {
      setError(null);
      try {
        const result = await fetchProof(proofId, code);
        if (result.needsPasscode) {
          setNeedsPasscode(true);
          if (code) setError('Wrong passcode.');
          return;
        }
        setNeedsPasscode(false);
        setProof(result.proof ?? null);
      } catch (cause) {
        setError(errorMessage(cause));
      }
    },
    [proofId],
  );

  useEffect(() => {
    void load('');
  }, [load]);

  useEffect(() => {
    if (!proof) return;
    const key = linkKeyFromHash(window.location.hash);
    if (!key) {
      setError('This link has no decryption key (#k=…). Ask the issuer for the full link.');
      return;
    }
    decryptFromLink(key, proof.txKeyEncrypted).then(setTxKey, () => setError('The link key cannot decrypt this proof.'));
  }, [proof]);

  const verify = useCallback(async () => {
    if (!txKey) return;
    setIsChecking(true);
    setError(null);
    try {
      setVerification(await apiPost<Verification>('/api/audit/verify', { proofId, txKey, ...(passcode ? { passcode } : {}) }));
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setIsChecking(false);
    }
  }, [proofId, txKey, passcode]);

  useEffect(() => {
    if (txKey) void verify();
    // Run once when the key becomes available.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [txKey]);

  const handlePasscode = (event: FormEvent) => {
    event.preventDefault();
    void load(passcode);
  };

  const pkg = proof?.package;
  const scan: ScanState = isChecking
    ? 'scanning'
    : !verification
      ? 'sealed'
      : verification.isValid
        ? 'revealed'
        : verification.failures.includes('ASSET_MISMATCH')
          ? 'mismatch'
          : 'rejected';

  return (
    <main className="relative z-10 mx-auto max-w-3xl px-4 py-10">
      <header className="no-print flex items-center justify-between">
        <p className="text-[1.2rem] font-semibold tracking-[-0.04em]">
          Bel<span className="text-vault">Flow</span> <span className="figures text-[0.65rem] uppercase tracking-[0.2em] text-ink-3">auditor portal</span>
        </p>
        {pkg && (
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={() => window.print()}>
              <Printer className="size-3.5" aria-hidden /> PDF
            </Button>
            <Button size="sm" variant="ghost" onClick={() => downloadJson(`belflow-proof-${proofId}.json`, JSON.stringify({ ...pkg, ...(txKey ? { txKey } : {}) }, null, 2))}>
              <Download className="size-3.5" aria-hidden /> JSON
            </Button>
          </div>
        )}
      </header>

      {needsPasscode && (
        <form onSubmit={handlePasscode} className="mt-8 space-y-3 rounded-[12px] border border-rule bg-paper p-5">
          <Field label="Auditor passcode" htmlFor="passcode" hint="The issuer protected this proof with a passcode.">
            <Input id="passcode" type="password" value={passcode} onChange={(e) => setPasscode(e.target.value)} autoComplete="current-password" />
          </Field>
          <Button type="submit">Unlock proof</Button>
        </form>
      )}

      {error && <Notice tone="error" className="mt-6">{error}</Notice>}

      {pkg && (
        <article className="mt-8 overflow-hidden rounded-[14px] border border-rule bg-paper shadow-[var(--shadow)]" data-testid="auditor-proof">
          <div className="relative border-b border-dashed border-rule-strong px-6 pb-6 pt-7">
            {verification?.isValid && (
              <div className="animate-seal absolute right-6 top-6 grid size-28 place-items-center rounded-full border-[3px] border-verified text-center text-verified" data-testid="verified-seal">
                <div className="px-2">
                  <ShieldCheck className="mx-auto size-6" aria-hidden />
                  <p className="figures mt-1 text-[0.58rem] uppercase leading-tight tracking-[0.12em]">
                    Verified
                    <br />
                    {verification.blockHeight ? `block #${verification.blockHeight}` : 'mempool'}
                  </p>
                </div>
              </div>
            )}
            <p className="figures text-[0.66rem] uppercase tracking-[0.2em] text-ink-3">Payment receipt · {proof?.network}</p>
            <Amount value={pkg.disclosedAmount} ticker={pkg.tokenTicker} publicValue className="mt-2 text-5xl font-medium tracking-tight" />
            <p className="mt-2 max-w-md text-sm text-ink-2">
              Paid to <span className="font-medium text-ink">{pkg.recipientBns ?? 'the recipient below'}</span>
              {pkg.invoiceReference ? ` · ${pkg.invoiceReference}` : ''}
            </p>
          </div>

          <div className="space-y-5 px-6 py-5">
            <XRayScanner txHash={pkg.txHash} state={scan} disclosed={`${verification?.receivedAmount ?? pkg.disclosedAmount} ${pkg.tokenTicker}`} paid={pkg.tokenTicker} />
            {verification && (
              <div className={verification.isValid ? 'rounded-[10px] bg-verified-soft p-4' : 'rounded-[10px] bg-danger-soft p-4'}>
                <p className="flex items-center gap-2 font-semibold">
                  {verification.isValid ? <ShieldCheck className="size-5 text-verified" aria-hidden /> : <ShieldAlert className="size-5 text-danger" aria-hidden />}
                  {verification.isValid
                    ? `Cryptographically verified in block #${verification.blockHeight?.toLocaleString('en-US') ?? '—'}`
                    : 'Verification failed'}
                </p>
                <p className="mt-1 text-sm text-ink-2">
                  {verification.isValid
                    ? `${verification.receivedAmount} ${pkg.tokenTicker} · ${verification.confirmations} confirmations · nothing else disclosed`
                    : verification.failures.join(', ')}
                </p>
                {verification.assetVerificationLevel && (
                  <p className="mt-3 flex flex-wrap items-center gap-2 text-xs text-ink-2">
                    <Badge tone={statusTone(verification.assetVerificationLevel)}>{verification.assetVerificationLevel}</Badge>
                    {LEVEL_TEXT[verification.assetVerificationLevel]}
                  </p>
                )}
              </div>
            )}

            <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-[auto_1fr]">
              <dt className="text-ink-3">Transaction</dt>
              <dd><HashChip value={pkg.txHash} head={14} tail={10} /></dd>
              <dt className="text-ink-3">Recipient address</dt>
              <dd><HashChip value={pkg.recipientAddress} head={14} tail={10} /></dd>
              <dt className="text-ink-3">Asset</dt>
              <dd className="flex items-center gap-2">{pkg.tokenTicker} <HashChip value={pkg.tokenId} /></dd>
              <dt className="text-ink-3">Issuer</dt>
              <dd>{pkg.issuerAddress ? <HashChip value={pkg.issuerAddress} head={14} tail={10} /> : '—'}</dd>
              <dt className="text-ink-3">Package hash</dt>
              <dd className="flex items-center gap-2">
                <HashChip value={pkg.packageHash} />
                {verification && <Badge tone={verification.packageIntact ? 'verified' : 'danger'}>{verification.packageIntact ? 'intact' : 'tampered'}</Badge>}
              </dd>
            </dl>

            <TamperSimulator proofId={proofId} pkg={pkg} txKey={txKey} passcode={passcode} />
            <details className="rounded-[8px] border border-rule bg-paper-2 px-3 py-2 text-xs text-ink-2">
              <summary className="cursor-pointer font-medium text-ink">Verify independently</summary>
              <p className="mt-2 leading-relaxed">
                Run <code className="figures">check_tx_key</code> on your own beldex-wallet-rpc with txid, tx_key and address from the JSON package. The signed declaration is:
              </p>
              <p className="figures mt-1 break-all">{pkg.declaration}</p>
            </details>
            <Button variant="outline" size="sm" className="no-print" onClick={verify} disabled={!txKey || isChecking}>
              Re-run verification
            </Button>
          </div>
        </article>
      )}
    </main>
  );
}
