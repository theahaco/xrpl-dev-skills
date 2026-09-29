import type { Client, Wallet } from 'xrpl'

import { ledgerAmount, parseAmount, type AmountInput } from './amount.js'
import { readHolder } from './ledger.js'
import { silentLogger, type Logger } from './logger.js'
import { TransactionSubmitter, type SubmitterOptions, type ValidatedTransaction } from './submitter.js'

/**
 * Holder-side operations, for custodial wallets, integration tests and the
 * demo. Holders normally sign these themselves; the issuer never needs
 * their keys.
 */
export class MptHolder {
  private readonly submitter: TransactionSubmitter

  constructor(
    private readonly client: Client,
    readonly wallet: Wallet,
    readonly issuanceId: string,
    options: { logger?: Logger; submitter?: SubmitterOptions } = {},
  ) {
    this.submitter = new TransactionSubmitter(client, wallet, options.logger ?? silentLogger, options.submitter)
  }

  get address(): string {
    return this.wallet.classicAddress
  }

  /** Creates the holder's MPToken entry, the prerequisite for issuer approval. Idempotent. */
  async optIn(): Promise<ValidatedTransaction | undefined> {
    if ((await readHolder(this.client, this.issuanceId, this.address)) !== undefined) return undefined
    return this.submitter.submit({
      TransactionType: 'MPTokenAuthorize',
      Account: this.address,
      MPTokenIssuanceID: this.issuanceId,
    })
  }

  async send(destination: string, amount: AmountInput): Promise<ValidatedTransaction> {
    return this.submitter.submit({
      TransactionType: 'Payment',
      Account: this.address,
      Destination: destination,
      Amount: { mpt_issuance_id: this.issuanceId, value: parseAmount(amount).toString() },
    })
  }

  async balance(): Promise<bigint> {
    return ledgerAmount((await readHolder(this.client, this.issuanceId, this.address))?.MPTAmount)
  }
}
