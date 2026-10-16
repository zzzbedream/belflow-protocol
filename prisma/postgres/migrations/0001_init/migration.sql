-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "PrivacyTokenRegistry" (
    "id" TEXT NOT NULL,
    "tokenId" TEXT NOT NULL,
    "ticker" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "decimals" INTEGER NOT NULL DEFAULT 6,
    "creatorAddr" TEXT NOT NULL,
    "network" TEXT NOT NULL DEFAULT 'testnet',
    "deployTxHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PrivacyTokenRegistry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConfidentialInvoice" (
    "id" TEXT NOT NULL,
    "network" TEXT NOT NULL DEFAULT 'testnet',
    "merchantAddress" TEXT NOT NULL,
    "merchantBns" TEXT,
    "tokenId" TEXT NOT NULL,
    "tokenTicker" TEXT NOT NULL,
    "tokenDecimals" INTEGER NOT NULL DEFAULT 9,
    "expectedAmount" TEXT NOT NULL,
    "encryptedMemo" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "paidTxHash" TEXT,
    "paidAt" TIMESTAMP(3),
    "assetVerificationLevel" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConfidentialInvoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SelectiveAuditRecord" (
    "id" TEXT NOT NULL,
    "network" TEXT NOT NULL DEFAULT 'testnet',
    "txHash" TEXT NOT NULL,
    "txKeyEncrypted" TEXT NOT NULL,
    "recipientAddress" TEXT NOT NULL,
    "recipientBns" TEXT,
    "disclosedAmount" TEXT NOT NULL,
    "amountAtomic" TEXT NOT NULL,
    "tokenId" TEXT NOT NULL,
    "tokenTicker" TEXT NOT NULL,
    "tokenDecimals" INTEGER NOT NULL,
    "invoiceId" TEXT,
    "auditorPasscode" TEXT,
    "issuerAddress" TEXT,
    "issuerSignature" TEXT,
    "packageJson" TEXT NOT NULL,
    "packageHash" TEXT NOT NULL,
    "assetVerificationLevel" TEXT,
    "verifiedBlockHeight" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SelectiveAuditRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "X402PaymentNonce" (
    "nonce" TEXT NOT NULL,
    "network" TEXT NOT NULL DEFAULT 'testnet',
    "resourcePath" TEXT NOT NULL,
    "requiredAmount" TEXT NOT NULL,
    "tokenTicker" TEXT NOT NULL,
    "tokenId" TEXT NOT NULL DEFAULT 'BDX',
    "recipientAddress" TEXT NOT NULL DEFAULT '',
    "isConsumed" BOOLEAN NOT NULL DEFAULT false,
    "consumedByTxHash" TEXT,
    "agentBns" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "issuedAtHeight" INTEGER,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "X402PaymentNonce_pkey" PRIMARY KEY ("nonce")
);

-- CreateTable
CREATE TABLE "PayrollBatchJob" (
    "id" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'CREATED',
    "payloadHash" TEXT NOT NULL,
    "useFlash" BOOLEAN NOT NULL DEFAULT false,
    "totalChunks" INTEGER NOT NULL,
    "recipientsCount" INTEGER NOT NULL,
    "chunksJson" TEXT NOT NULL DEFAULT '[]',
    "txHashesJson" TEXT NOT NULL DEFAULT '[]',
    "feeTotalAtomic" TEXT NOT NULL DEFAULT '0',
    "burnedAtomic" TEXT NOT NULL DEFAULT '0',
    "lockedUntilHeight" INTEGER,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PayrollBatchJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayrollTxRecord" (
    "txHash" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "chunkIndex" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PayrollTxRecord_pkey" PRIMARY KEY ("txHash")
);

-- CreateTable
CREATE TABLE "FaucetClaim" (
    "id" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "recipient" TEXT NOT NULL,
    "ipHash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "txHashesJson" TEXT NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FaucetClaim_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuthChallenge" (
    "nonce" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "statement" TEXT NOT NULL,
    "bindingHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuthChallenge_pkey" PRIMARY KEY ("nonce")
);

-- CreateTable
CREATE TABLE "ChainActivity" (
    "id" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "txHash" TEXT NOT NULL,
    "feeAtomic" TEXT NOT NULL DEFAULT '0',
    "burnedAtomic" TEXT NOT NULL DEFAULT '0',
    "tokenId" TEXT,
    "volumeAtomic" TEXT NOT NULL DEFAULT '0',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChainActivity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RevokedSession" (
    "jti" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RevokedSession_pkey" PRIMARY KEY ("jti")
);

-- CreateTable
CREATE TABLE "SettledTransaction" (
    "txHash" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SettledTransaction_pkey" PRIMARY KEY ("txHash")
);

-- CreateTable
CREATE TABLE "MockChainSnapshot" (
    "id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "json" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MockChainSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PrivacyTokenRegistry_tokenId_key" ON "PrivacyTokenRegistry"("tokenId");

-- CreateIndex
CREATE INDEX "PrivacyTokenRegistry_network_idx" ON "PrivacyTokenRegistry"("network");

-- CreateIndex
CREATE UNIQUE INDEX "ConfidentialInvoice_paidTxHash_key" ON "ConfidentialInvoice"("paidTxHash");

-- CreateIndex
CREATE INDEX "ConfidentialInvoice_network_status_idx" ON "ConfidentialInvoice"("network", "status");

-- CreateIndex
CREATE INDEX "SelectiveAuditRecord_txHash_idx" ON "SelectiveAuditRecord"("txHash");

-- CreateIndex
CREATE UNIQUE INDEX "X402PaymentNonce_consumedByTxHash_key" ON "X402PaymentNonce"("consumedByTxHash");

-- CreateIndex
CREATE INDEX "X402PaymentNonce_expiresAt_idx" ON "X402PaymentNonce"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "PayrollBatchJob_idempotencyKey_key" ON "PayrollBatchJob"("idempotencyKey");

-- CreateIndex
CREATE INDEX "PayrollBatchJob_network_status_idx" ON "PayrollBatchJob"("network", "status");

-- CreateIndex
CREATE INDEX "PayrollTxRecord_jobId_idx" ON "PayrollTxRecord"("jobId");

-- CreateIndex
CREATE INDEX "FaucetClaim_network_recipient_createdAt_idx" ON "FaucetClaim"("network", "recipient", "createdAt");

-- CreateIndex
CREATE INDEX "FaucetClaim_network_ipHash_createdAt_idx" ON "FaucetClaim"("network", "ipHash", "createdAt");

-- CreateIndex
CREATE INDEX "ChainActivity_network_kind_idx" ON "ChainActivity"("network", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "ChainActivity_network_kind_txHash_key" ON "ChainActivity"("network", "kind", "txHash");

