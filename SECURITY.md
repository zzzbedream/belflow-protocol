# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub: **Security → Report a vulnerability** on this repository (private vulnerability reporting). Do not open a public issue for a suspected vulnerability.

A useful report includes:
- the affected package (`@belflow/sdk`, `@belflow/x402` or the demo app) and commit;
- the steps to reproduce;
- the impact you expect, for example a payment accepted for the wrong token or amount, a replayed proof, or leaked key material.

We acknowledge reports, agree on a fix and a disclosure date with the reporter, and credit them unless they prefer otherwise.

## Scope

- **In scope.** The SDK's verification logic (`packages/beldex-sdk/src/compliance`, `src/zyphora`), the RPC clients, the x402 middleware and the demo app's server routes.
- **Out of scope.** Vulnerabilities in Beldex itself (`beldexd`, `beldex-wallet-rpc`, consensus). Report those to the Beldex team.

## Supported versions

Only the latest commit on `main` is supported until the first npm release.
