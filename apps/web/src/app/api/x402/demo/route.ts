import { withX402 } from '@belflow/x402';
import { NextResponse } from 'next/server';
import { rateLimit, toErrorResponse } from '@/server/http';
import { networkSchema } from '@/server/runtime';
import { x402Config } from '@/server/x402';

export const dynamic = 'force-dynamic';

const premiumResource = withX402(
  (_request, payment) =>
    NextResponse.json({
      resource: 'latam-fx-signal',
      generatedAt: new Date().toISOString(),
      data: {
        model: 'belflow-oracle-v1',
        signals: [
          { pair: 'USD/CLP', bias: 'neutral', confidence: 0.62 },
          { pair: 'USD/BRL', bias: 'bearish', confidence: 0.58 },
          { pair: 'USD/COP', bias: 'bullish', confidence: 0.55 },
        ],
        note: 'Synthetic demo payload. Paid privately: no explorer shows who bought it or for how much.',
      },
      payment: {
        txHash: payment.txHash,
        agent: payment.agentBns ?? null,
        settledFromMempool: payment.verification.inPool,
        flash: payment.verification.isFlash,
        assetVerificationLevel: payment.verification.assetVerificationLevel,
      },
    }),
  (request) => x402Config(networkSchema.parse(new URL(request.url).searchParams.get('network') ?? 'mock-devnet')),
);

/** Premium resource protected by HTTP 402 Payment Required (x402-beldex). */
export async function GET(request: Request): Promise<Response> {
  try {
    rateLimit(request, 'x402:demo', 120);
    return await premiumResource(request);
  } catch (error) {
    return toErrorResponse(error);
  }
}
