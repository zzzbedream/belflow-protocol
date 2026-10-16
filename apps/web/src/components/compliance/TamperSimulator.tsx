'use client';

import { verifyPackageIntegrity, type AuditProofPackage } from '@belflow/sdk';
import { FlaskConical, ShieldAlert, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Textarea } from '@/components/ui/Field';
import { apiPost, errorMessage } from '@/lib/api';

interface InspectResult {
  integrity: boolean;
  chain: { isValid: boolean; failures: string[]; assetVerificationLevel: string | null } | null;
  error: string | null;
}

interface TamperSimulatorProps {
  proofId: string;
  pkg: AuditProofPackage;
  txKey: string | null;
  passcode: string;
}

/**
 * Lets an auditor paste a (possibly edited) proof JSON, or tamper the asset in
 * one click, and see both checks fail: the SHA-256 package hash in the browser
 * and check_tx_key + asset attribution on the node.
 */
export function TamperSimulator({ proofId, pkg, txKey, passcode }: TamperSimulatorProps) {
  const [text, setText] = useState(() => JSON.stringify(pkg, null, 2));
  const [result, setResult] = useState<InspectResult | null>(null);
  const [isBusy, setIsBusy] = useState(false);

  const tamper = () => {
    const forgedAsset = pkg.tokenId === 'BDX' ? 'f'.repeat(64) : 'BDX';
    setText(JSON.stringify({ ...pkg, tokenId: forgedAsset, tokenTicker: forgedAsset === 'BDX' ? 'BDX' : 'FAKE' }, null, 2));
    setResult(null);
  };

  const inspect = async () => {
    setIsBusy(true);
    setResult(null);
    try {
      const candidate = JSON.parse(text) as AuditProofPackage;
      const integrity = verifyPackageIntegrity(candidate);
      const chain = txKey
        ? await apiPost<InspectResult['chain']>('/api/audit/inspect', {
            proofId,
            txKey,
            tokenId: candidate.tokenId,
            amountAtomic: candidate.amountAtomic,
            ...(passcode ? { passcode } : {}),
          })
        : null;
      setResult({ integrity, chain, error: null });
    } catch (cause) {
      setResult({ integrity: false, chain: null, error: errorMessage(cause) });
    } finally {
      setIsBusy(false);
    }
  };

  const rejected = result && (!result.integrity || (result.chain && !result.chain.isValid));

  return (
    <details className="no-print rounded-[8px] border border-rule bg-paper-2 px-3 py-2 text-xs text-ink-2" data-testid="tamper-simulator">
      <summary className="flex cursor-pointer items-center gap-1.5 font-medium text-ink">
        <FlaskConical className="size-3.5" aria-hidden /> Inspect or tamper the proof JSON
      </summary>
      <div className="mt-3 space-y-3">
        <Textarea value={text} onChange={(e) => setText(e.target.value)} className="figures min-h-40 text-[0.7rem]" aria-label="Proof JSON" />
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="danger" onClick={tamper} data-testid="tamper-asset">
            Simulate tampered asset
          </Button>
          <Button size="sm" variant="outline" onClick={inspect} disabled={isBusy} data-testid="inspect-proof">
            {isBusy ? 'Checking…' : 'Verify this JSON'}
          </Button>
        </div>
        {result && (
          <div className={rejected ? 'rounded-[8px] bg-danger-soft p-3' : 'rounded-[8px] bg-verified-soft p-3'} data-testid="inspect-result">
            <p className="flex items-center gap-2 font-semibold text-ink">
              {rejected ? <ShieldAlert className="size-4 text-danger" aria-hidden /> : <ShieldCheck className="size-4 text-verified" aria-hidden />}
              {rejected ? 'Rejected' : 'Authentic'}
            </p>
            <ul className="mt-2 space-y-1">
              <li>
                Package hash: <Badge tone={result.integrity ? 'verified' : 'danger'}>{result.integrity ? 'intact' : 'PACKAGE_TAMPERED'}</Badge>
              </li>
              {result.chain && (
                <li>
                  On-chain claim:{' '}
                  {result.chain.isValid ? (
                    <Badge tone="verified">{result.chain.assetVerificationLevel ?? 'valid'}</Badge>
                  ) : (
                    result.chain.failures.map((failure) => (
                      <Badge key={failure} tone="danger" className="mr-1">
                        {failure}
                      </Badge>
                    ))
                  )}
                </li>
              )}
              {result.error && <li className="text-danger">{result.error}</li>}
            </ul>
          </div>
        )}
      </div>
    </details>
  );
}
