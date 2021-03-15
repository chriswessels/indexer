import { BigNumber, utils } from 'ethers'
import {
  indexerError,
  IndexerErrorCode,
  PaymentModels,
  ReceiptAttributes,
  Transfer,
  VectorClient,
} from '@graphprotocol/indexer-common'
import { Address, Logger, timer, toAddress } from '@graphprotocol/common-ts'
import { Sequelize, Transaction } from 'sequelize'
import { INodeService } from '@connext/vector-types'
import pRetry from 'p-retry'

// Takes a valid big-endian hexadecimal string and parses it as a BigNumber
function readNumber(data: string, start: number, end: number): BigNumber {
  return BigNumber.from('0x' + data.slice(start, end))
}

function readBinary(data: string, start: number, end: number): Uint8Array {
  return utils.arrayify('0x' + data.slice(start, end))
}

const paymentValidator = /^[0-9A-Fa-f]{266}$/

// Cache which avoids concurrently getting the same thing more than once.
class AsyncCache<K, V> {
  private readonly _attempts: Map<K, Promise<V>> = new Map()
  private readonly _fn: (k: K) => Promise<V>

  constructor(fn: (k: K) => Promise<V>) {
    this._fn = fn
  }

  get(k: K): Promise<V> {
    const cached = this._attempts.get(k)
    if (cached) {
      return cached
    }

    // This shares concurrent attempts, but still retries on failure.
    const attempt = (async () => {
      try {
        return await this._fn(k)
      } catch (e) {
        // By removing the cached attempt we ensure this is retried
        this._attempts.delete(k)
        throw e
      }
    })()
    this._attempts.set(k, attempt)
    return attempt
  }
}

async function getTransfer(
  node: INodeService,
  channelAddress: string,
  routingId: string,
  vectorTransferDefinition: Address,
): Promise<Pick<Transfer, 'signer' | 'allocation'>> {
  // Get the transfer
  const result = await node.getTransferByRoutingId({ channelAddress, routingId })

  if (result.isError) {
    throw result.getError()
  }

  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  const transfer = result.getValue()!

  // Security: Ensure that the verifying contract of the transfer
  // is the expected one. Otherwise we may be approving data which does
  // not unlock expected funds.
  if (toAddress(transfer.transferDefinition) !== vectorTransferDefinition) {
    throw new Error(
      `Transfer "${transfer.transferId}" has unsupported transfer definition "${transfer.transferDefinition}"`,
    )
  }

  return {
    signer: toAddress(transfer.transferState.signer),
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    allocation: toAddress(transfer.meta!.allocation),
  }
}

function validateSignature(
  transfer: Pick<Transfer, 'signer' | 'allocation'>,
  receiptData: string,
): string {
  const signedData = readBinary(receiptData, 64, 136)
  const signature = '0x' + receiptData.slice(136, 266)
  const address = utils.recoverAddress(utils.keccak256(signedData), signature)
  if (toAddress(address) !== transfer.signer) {
    throw indexerError(
      IndexerErrorCode.IE031,
      `Invalid signature: recovered signer "${address}" but expected signer "${transfer.signer}"`,
    )
  }
  return signature
}

export class ReceiptManager {
  private readonly _sequelize: Sequelize
  private readonly _paymentModels: PaymentModels
  private readonly _cache: Map<string, Readonly<ReceiptAttributes>> = new Map()
  private readonly _flushQueue: string[] = []
  private readonly _transferCache: AsyncCache<
    string,
    Pick<Transfer, 'signer' | 'allocation'>
  >

  constructor(
    sequelize: Sequelize,
    paymentModels: PaymentModels,
    logger: Logger,
    vector: VectorClient,
    vectorTransferDefinition: Address,
  ) {
    logger = logger.child({ component: 'ReceiptManager' })

    this._sequelize = sequelize
    this._paymentModels = paymentModels
    this._transferCache = new AsyncCache((routingId: string) =>
      getTransfer(
        vector.node,
        vector.channelAddress,
        routingId,
        vectorTransferDefinition,
      ),
    )

    timer(30_000).pipe(async () => {
      try {
        await this._flushOutstanding()
      } catch (err) {
        logger.error(
          `Failed to sync payment to the db. If this does not correct itself, revenue may be lost.`,
          { err },
        )
      }
    })
  }

  // Saves the payment and returns the allocation for signing
  async add(receiptData: string): Promise<string> {
    // Security: Input validation
    if (!paymentValidator.test(receiptData)) {
      throw indexerError(IndexerErrorCode.IE031, 'Expecting 266 hex characters')
    }

    const vectorTransferId = '0x' + receiptData.slice(0, 64)

    // This should always work for valid transfers (aside from eg: network failures)
    // The Gateway initiates a transfer, but won't use it until there is a double-signed
    // commitment. That means our Vector node should know about it.
    const transfer = await this._transferCache.get(vectorTransferId)

    const signature = validateSignature(transfer, receiptData)

    const paymentAmount = readNumber(receiptData, 64, 128)
    const id = readNumber(receiptData, 128, 136).toNumber()

    const receipt: ReceiptAttributes = {
      paymentAmount: paymentAmount.toString(),
      id,
      signature,
      signer: transfer.signer,
    }
    this._queue(receipt)
    return transfer.allocation

    // TODO: (Security) Additional validations are required to remove trust from
    // the Gateway which are deferred until we can fully remove trust which requires:
    //   * A receiptID based routing solution so that some invariants can be tested
    //     in memory instead of hitting the database for performance (eg: collateral,
    //     and that payments are increasing).
    //   * A ZKP to ensure all receipts can be collected without running out of gas.
    //
    // Validations include:
    //   * The address corresponds to an *unresolved* transfer.
    //   * The unresolved transfer has sufficient collateral to pay for the query.
    //   * Recovering the signature for the binary data in chars 20..56 = the specified address.
    //   * The increase in payment amount from the last known valid state covers the cost of the query
    //   * This receipt ID is not being "forked" by concurrent usage.
  }

  /// Flushes all receipts that have been registered by this moment in time.
  private async _flushOutstanding(): Promise<void> {
    let count = this._flushQueue.length

    while (count > 0) {
      count -= 1

      // Swap and pop
      const qualifiedId = this._flushQueue[count]
      this._flushQueue[count] = this._flushQueue[this._flushQueue.length - 1]
      this._flushQueue.pop()

      // An invariant of this class is that _flushQueue indexes
      // _cache. So, the ! is being used as intended.
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const receipt = this._cache.get(qualifiedId)!
      this._cache.delete(qualifiedId)

      const transact = async () => {
        // Put this in a transaction because this has a write which is
        // dependent on a read and must be atomic or payments could be dropped.
        await this._sequelize.transaction(
          { isolationLevel: Transaction.ISOLATION_LEVELS.REPEATABLE_READ },
          async (transaction: Transaction) => {
            const [state, isNew] = await this._paymentModels.receipts.findOrBuild({
              where: { id: receipt.id, signer: receipt.signer },
              defaults: {
                id: receipt.id,
                signature: receipt.signature,
                signer: receipt.signer,
                paymentAmount: receipt.paymentAmount,
              },
              transaction,
            })

            // Don't save over receipts that are already advanced
            if (!isNew) {
              const storedPaymentAmount = BigNumber.from(
                state.getDataValue('paymentAmount'),
              )
              if (storedPaymentAmount.gte(receipt.paymentAmount)) {
                return
              }
            }

            // Make sure the new payment amount and signature are set
            state.set('paymentAmount', receipt.paymentAmount)
            state.set('signature', receipt.signature)

            // Save the new or updated receipt to the db
            await state.save({ transaction })
          },
        )
      }

      // Save to the db
      try {
        await pRetry(
          async () => {
            try {
              await transact()
            } catch (err) {
              // Only retry if the error is a 40001 error, aka 'could not serialize
              // access due to concurrent update'
              if (err.parent.code !== '40001') {
                throw new pRetry.AbortError(err)
              }
            }
          },
          { retries: 20 },
        )
      } catch (err) {
        // If we fail for whatever reason, keep this data in the cache to flush
        // the next time around.
        //
        // This needs to go back through the normal add method,
        // rather than just inserting back into the queue.
        // The receipt may have advanced while we were trying to flush
        // it and we don't want to overwrite new data with stale data.
        this._queue(receipt)
        throw err
      }
    }
  }

  _queue(receipt: ReceiptAttributes): void {
    // This is collision resistant only because address has a fixed length.
    const qualifiedId = `${receipt.signer}${receipt.id}`
    const latest = this._cache.get(qualifiedId)
    if (
      latest === undefined ||
      BigNumber.from(latest.paymentAmount).lt(receipt.paymentAmount)
    ) {
      if (latest === undefined) {
        this._flushQueue.push(qualifiedId)
      }
      this._cache.set(qualifiedId, receipt)
    }
  }
}
