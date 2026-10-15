import Papa from 'papaparse';
import { z } from 'zod';

/** Required CSV columns (PRD): recipient_bns_or_address, amount, token_id, memo_reference. */
export const PAYROLL_COLUMNS = ['recipient_bns_or_address', 'amount', 'token_id', 'memo_reference'] as const;
export const MAX_PAYROLL_ROWS = 500;

export interface PayrollRow {
  id: string;
  recipientInput: string;
  amount: string;
  token: string;
  memo: string;
}

export interface CsvParseResult {
  rows: PayrollRow[];
  errors: string[];
}

const rowSchema = z.object({
  recipient_bns_or_address: z.string().trim().min(1, 'recipient is empty').max(120),
  amount: z.string().trim().regex(/^\d{1,20}(\.\d{1,12})?$/, 'amount must be a positive decimal'),
  token_id: z.string().trim().min(2, 'token_id is empty').max(64),
  memo_reference: z
    .string()
    .trim()
    .max(140)
    .regex(/^[^\u0000-\u001f]*$/, 'memo has control characters')
    .optional()
    .default(''),
});

/** Parses and validates a payroll CSV. Row ids are stable (row number based). */
export function parsePayrollCsv(text: string): CsvParseResult {
  const parsed = Papa.parse<Record<string, string>>(text.trim(), {
    header: true,
    skipEmptyLines: 'greedy',
    transformHeader: (header) => header.trim().toLowerCase(),
  });
  const errors: string[] = parsed.errors.slice(0, 5).map((error) => `Row ${(error.row ?? 0) + 2}: ${error.message}`);
  const headers = parsed.meta.fields ?? [];
  const missing = PAYROLL_COLUMNS.filter((column) => column !== 'memo_reference' && !headers.includes(column));
  if (missing.length > 0) return { rows: [], errors: [`Missing column(s): ${missing.join(', ')}.`] };
  if (parsed.data.length > MAX_PAYROLL_ROWS) return { rows: [], errors: [`At most ${MAX_PAYROLL_ROWS} rows per payroll.`] };

  const rows: PayrollRow[] = [];
  parsed.data.forEach((raw, index) => {
    const result = rowSchema.safeParse(raw);
    if (!result.success) {
      errors.push(`Row ${index + 2}: ${result.error.issues.map((issue) => issue.message).join(', ')}`);
      return;
    }
    rows.push({
      id: `row-${index + 1}`,
      recipientInput: result.data.recipient_bns_or_address,
      amount: result.data.amount,
      token: result.data.token_id,
      memo: result.data.memo_reference,
    });
  });
  return { rows, errors };
}

export const SAMPLE_PAYROLL_CSV = `recipient_bns_or_address,amount,token_id,memo_reference
devteam.bdx,1250.00,bUSD,OCT-2026 engineering
juan.bdx,980.50,bUSD,OCT-2026 support
maria.bdx,1100.00,bUSD,OCT-2026 design
camila.bdx,45.25,BDX,OCT-2026 expenses
`;
