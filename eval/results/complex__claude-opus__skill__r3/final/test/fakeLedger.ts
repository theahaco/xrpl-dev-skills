import type { Client } from 'xrpl';

/**
 * Minimal in-memory stand-in for the rippled API surface used by the module,
 * with just enough MPT semantics to exercise the issuer's control flow offline.
 * Behaviour mirrors what was observed on testnet (rippled 3.4.1).
 */
export interface FakeHolder {
  authorized: boolean;
  locked: boolean;
  balance: bigint;
}

type Req = Record<string, unknown> & { command: string };

export class FakeLedger {
  validated = 100;
  issuer = '';
  issuanceId = 'ABCDEF'.padEnd(48, '0');
  issuanceFlags = 0x66; // RequireAuth | CanLock | CanTransfer | CanClawback
  outstanding = 0n;
  holders = new Map<string, FakeHolder>();
  submitted: Record<string, unknown>[] = [];
  /** Override the engine result for the next submission(s). */
  nextSubmitResult: string[] = [];
  nextFinalResult: string[] = [];
  txBehaviour: 'validate' | 'never' = 'validate';
  private txs = new Map<string, { tx: Record<string, unknown>; result: string; ledger: number }>();

  asClient(): Client {
    return {
      autofill: async (tx: Record<string, unknown>) => ({ ...tx, Fee: '12', Sequence: this.submitted.length + 1 }),
      request: async (req: Req) => this.request(req),
    } as unknown as Client;
  }

  private rpcError(error: string, extra: Record<string, unknown> = {}): never {
    throw Object.assign(new Error(error), { data: { error, ...extra } });
  }

  private async request(req: Req): Promise<{ result: Record<string, unknown> }> {
    switch (req.command) {
      case 'ledger':
        return { result: { ledger_index: this.validated } };
      case 'ledger_entry': {
        if (req.mpt_issuance) {
          if (req.mpt_issuance !== this.issuanceId) this.rpcError('entryNotFound');
          return {
            result: {
              node: { Issuer: this.issuer, Flags: this.issuanceFlags, OutstandingAmount: String(this.outstanding), AssetScale: 0, MaximumAmount: '1000000' },
            },
          };
        }
        const { account } = req.mptoken as { account: string };
        const h = this.holders.get(account);
        if (!h) this.rpcError('entryNotFound');
        return { result: { node: { Flags: (h.locked ? 1 : 0) | (h.authorized ? 2 : 0), MPTAmount: String(h.balance) } } };
      }
      case 'submit': {
        const { decode, hashes } = await import('xrpl');
        const blob = req.tx_blob as string;
        const tx = decode(blob) as Record<string, unknown>;
        this.submitted.push(tx);
        const prelim = this.nextSubmitResult.shift() ?? 'tesSUCCESS';
        if (!prelim.startsWith('tem') && !prelim.startsWith('tef') && this.txBehaviour === 'validate') {
          this.validated += 1;
          const result = this.nextFinalResult.shift() ?? this.apply(tx);
          this.txs.set(hashes.hashSignedTx(blob), { tx, result, ledger: this.validated });
        }
        return { result: { engine_result: prelim } };
      }
      case 'tx': {
        const found = this.txs.get(req.transaction as string);
        if (!found) {
          this.validated += 5;
          this.rpcError('txnNotFound', { searched_all: true });
        }
        return { result: { validated: true, ledger_index: found.ledger, meta: { TransactionResult: found.result, delivered_amount: found.tx.Amount } } };
      }
      default:
        throw new Error(`unexpected command ${req.command}`);
    }
  }

  /** Apply MPT semantics; return the engine result. */
  private apply(tx: Record<string, unknown>): string {
    const holderAddr = (tx.Holder ?? tx.Destination) as string | undefined;
    const flags = (tx.Flags as number | undefined) ?? 0;
    switch (tx.TransactionType) {
      case 'MPTokenAuthorize': {
        const h = holderAddr ? this.holders.get(holderAddr) : undefined;
        if (!h) return 'tecOBJECT_NOT_FOUND';
        h.authorized = (flags & 1) === 0;
        return 'tesSUCCESS';
      }
      case 'MPTokenIssuanceSet': {
        if (tx.Holder) {
          const h = this.holders.get(tx.Holder as string);
          if (!h) return 'tecOBJECT_NOT_FOUND';
          h.locked = (flags & 1) !== 0;
        } else {
          this.issuanceFlags = flags & 1 ? this.issuanceFlags | 1 : this.issuanceFlags & ~1;
        }
        return 'tesSUCCESS';
      }
      case 'Payment': {
        const h = this.holders.get(holderAddr!);
        if (!h || !h.authorized) return 'tecNO_AUTH';
        const v = BigInt((tx.Amount as { value: string }).value);
        h.balance += v;
        this.outstanding += v;
        return 'tesSUCCESS';
      }
      case 'Clawback': {
        const h = this.holders.get(holderAddr!);
        if (!h || h.balance === 0n) return 'tecINSUFFICIENT_FUNDS';
        const v = BigInt((tx.Amount as { value: string }).value);
        const taken = v > h.balance ? h.balance : v;
        h.balance -= taken;
        this.outstanding -= taken;
        return 'tesSUCCESS';
      }
      default:
        return 'tesSUCCESS';
    }
  }
}
