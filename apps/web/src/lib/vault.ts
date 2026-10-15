'use client';

import { decryptWithKey, encryptWithKey } from './crypto';

// Local encrypted vault for payroll receipts (tx secret keys). A
// non-extractable AES-GCM CryptoKey lives in IndexedDB; records are encrypted
// with it and stored in localStorage. Script on this origin can use the key
// but can never export it, and the server never sees the vault.

const DB_NAME = 'belflow-vault';
const STORE = 'keys';
const KEY_ID = 'vault-key-v1';
const RECORDS_KEY = 'belflow.vault.records.v1';

export interface PaymentReceipt {
  id: string;
  network: string;
  jobId: string;
  txHash: string;
  txKey: string;
  recipientId: string;
  recipientInput: string;
  recipientAddress: string;
  recipientBns?: string;
  amount: string;
  tokenId: string;
  tokenTicker: string;
  tokenDecimals: number;
  memo?: string;
  createdAt: number;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB unavailable.'));
  });
}

async function vaultKey(): Promise<CryptoKey> {
  const db = await openDb();
  const existing = await new Promise<CryptoKey | undefined>((resolve, reject) => {
    const get = db.transaction(STORE, 'readonly').objectStore(STORE).get(KEY_ID);
    get.onsuccess = () => resolve(get.result as CryptoKey | undefined);
    get.onerror = () => reject(get.error);
  });
  if (existing) return existing;
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(key, KEY_ID);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  return key;
}

function readCipherRecords(): string[] {
  try {
    const raw = localStorage.getItem(RECORDS_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

export async function loadReceipts(): Promise<PaymentReceipt[]> {
  const key = await vaultKey();
  const receipts: PaymentReceipt[] = [];
  for (const cipher of readCipherRecords()) {
    try {
      receipts.push(JSON.parse(await decryptWithKey(key, cipher)) as PaymentReceipt);
    } catch {
      // A record from a different vault key (cleared IndexedDB) cannot be read; skip it.
    }
  }
  return receipts.sort((a, b) => b.createdAt - a.createdAt);
}

/** Adds receipts, skipping ids already present. */
export async function saveReceipts(newReceipts: PaymentReceipt[]): Promise<void> {
  const key = await vaultKey();
  const existing = await loadReceipts();
  const known = new Set(existing.map((r) => r.id));
  const merged = [...existing, ...newReceipts.filter((r) => !known.has(r.id))];
  const ciphers = await Promise.all(merged.map((receipt) => encryptWithKey(key, JSON.stringify(receipt))));
  localStorage.setItem(RECORDS_KEY, JSON.stringify(ciphers));
}
