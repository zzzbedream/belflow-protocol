'use client';

import { FileUp } from 'lucide-react';
import { useRef, useState, type DragEvent } from 'react';
import { Button } from '@/components/ui/Button';
import { cn } from '@/components/ui/cn';
import { Notice } from '@/components/ui/Notice';
import { PAYROLL_COLUMNS, SAMPLE_PAYROLL_CSV, parsePayrollCsv, type PayrollRow } from '@/lib/csv';

const MAX_FILE_BYTES = 512 * 1024;

/** Drop, pick or paste a payroll CSV (recipient_bns_or_address, amount, token_id, memo_reference). */
export function BatchCsvUploader({ onRows }: { onRows: (rows: PayrollRow[]) => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);

  const ingest = (text: string) => {
    const result = parsePayrollCsv(text);
    setErrors(result.errors);
    if (result.rows.length > 0) onRows(result.rows);
  };

  const readFile = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > MAX_FILE_BYTES) {
      setErrors(['CSV files are limited to 512 KB.']);
      return;
    }
    ingest(await file.text());
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsDragging(false);
    void readFile(event.dataTransfer.files[0]);
  };

  return (
    <div className="space-y-3">
      <div
        onDragOver={(event) => {
          event.preventDefault();
          setIsDragging(true);
        }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={handleDrop}
        className={cn(
          'flex flex-col items-center justify-center gap-2 rounded-[10px] border border-dashed px-6 py-8 text-center transition-colors duration-150',
          isDragging ? 'border-vault bg-vault-soft' : 'border-rule-strong bg-paper-2',
        )}
      >
        <FileUp className={cn('size-6', isDragging ? 'text-vault' : 'text-ink-3')} aria-hidden />
        <p className="text-sm text-ink">Drop a payroll CSV here</p>
        <p className="figures text-[0.68rem] text-ink-3">{PAYROLL_COLUMNS.join(' · ')}</p>
        <div className="mt-2 flex flex-wrap justify-center gap-2">
          <Button type="button" variant="outline" size="sm" onClick={() => inputRef.current?.click()}>
            Choose file
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={() => ingest(SAMPLE_PAYROLL_CSV)} data-testid="load-sample">
            Load sample payroll
          </Button>
        </div>
        <input
          ref={inputRef}
          type="file"
          accept=".csv,text/csv"
          className="sr-only"
          aria-label="Payroll CSV file"
          onChange={(event) => void readFile(event.target.files?.[0])}
        />
      </div>
      {errors.length > 0 && (
        <Notice tone="warning" title="Some rows were skipped">
          <ul className="list-disc pl-4">
            {errors.slice(0, 6).map((error) => (
              <li key={error}>{error}</li>
            ))}
          </ul>
        </Notice>
      )}
    </div>
  );
}
