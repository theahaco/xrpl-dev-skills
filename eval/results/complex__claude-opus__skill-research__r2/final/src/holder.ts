import { type Client, MPTokenAuthorizeFlags, type Wallet } from 'xrpl'

import { toPositiveBaseUnits } from './amount.js'
import { type Logger, TransactionSubmitter, type ValidatedTransaction } from './submitter.js'

/**
 * Actions a token holder takes on their own account. This is not part of the
 * issuer backend: the demo and tests use it to act as the holders.
 */
export class MptHolder {
  readonly #submitter: TransactionSubmitter

  constructor(
    client: Client,
    readonly wallet: Wallet,
    readonly issuanceId: string,
    readonly assetScale: number,
    logger?: Logger,
  ) {
    this.#submitter = new TransactionSubmitter(client, wallet, logger === undefined ? {} : { logger })
  }

  get address(): string {
    return this.wallet.classicAddress
  }

  /** Creates the holder's MPToken entry (costs one owner reserve). The issuer must still approve it. */
  optIn(): Promise<ValidatedTransaction> {
    return this.#submitter.submit({
      TransactionType: 'MPTokenAuthorize',
      Account: this.address,
      MPTokenIssuanceID: this.issuanceId,
    })
  }

  /** Deletes the holder's MPToken entry. Only possible with a zero balance. */
  optOut(): Promise<ValidatedTransaction> {
    return this.#submitter.submit({
      TransactionType: 'MPTokenAuthorize',
      Account: this.address,
      MPTokenIssuanceID: this.issuanceId,
      Flags: MPTokenAuthorizeFlags.tfMPTUnauthorize,
    })
  }

  send(destination: string, amount: string): Promise<ValidatedTransaction> {
    return this.#submitter.submit({
      TransactionType: 'Payment',
      Account: this.address,
      Destination: destination,
      Amount: {
        mpt_issuance_id: this.issuanceId,
        value: toPositiveBaseUnits(amount, this.assetScale).toString(),
      },
    })
  }
}
