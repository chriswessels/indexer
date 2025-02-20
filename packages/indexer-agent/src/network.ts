import {
  Logger,
  NetworkContracts,
  SubgraphDeploymentID,
  formatGRT,
  parseGRT,
  timer,
  Eventual,
  Address,
  toAddress,
  mutable,
} from '@graphprotocol/common-ts'
import {
  Allocation,
  AllocationStatus,
  Epoch,
  IndexingRuleAttributes,
  IndexingDecisionBasis,
  INDEXING_RULE_GLOBAL,
  parseGraphQLAllocation,
  parseGraphQLEpochs,
  uniqueAllocationID,
  indexerError,
  IndexerErrorCode,
  INDEXER_ERROR_MESSAGES,
  IndexerError,
  NetworkSubgraph,
} from '@graphprotocol/indexer-common'
import {
  ContractTransaction,
  ContractReceipt,
  BigNumber,
  providers,
  Wallet,
  utils,
  Signer,
  BigNumberish,
} from 'ethers'
import { strict as assert } from 'assert'
import gql from 'graphql-tag'
import geohash from 'ngeohash'
import delay from 'delay'

const allocationIdProof = (
  signer: Signer,
  indexerAddress: string,
  allocationId: string,
): Promise<string> => {
  const messageHash = utils.solidityKeccak256(
    ['address', 'address'],
    [indexerAddress, allocationId],
  )
  const messageHashBytes = utils.arrayify(messageHash)
  return signer.signMessage(messageHashBytes)
}

interface TransactionConfig extends providers.TransactionRequest {
  attempt: number
  nonceOffset: number
  gasBump: number
}

export class Network {
  networkSubgraph: NetworkSubgraph
  contracts: NetworkContracts
  indexerAddress: Address
  indexerUrl: string
  indexerGeoCoordinates: [string, string]
  wallet: Wallet
  logger: Logger
  ethereum: providers.StaticJsonRpcProvider
  paused: Eventual<boolean>
  isOperator: Eventual<boolean>
  restakeRewards: boolean
  queryFeesCollectedClaimThreshold: BigNumber
  poiDisputeMonitoring: boolean
  poiDisputableEpochs: number
  gasIncreaseTimeout: number
  gasIncreaseFactor: number
  baseFeePerGasMax: number
  maxTransactionAttempts: number

  private constructor(
    logger: Logger,
    wallet: Wallet,
    indexerAddress: Address,
    indexerUrl: string,
    geoCoordinates: [string, string],
    contracts: NetworkContracts,
    networkSubgraph: NetworkSubgraph,
    ethereum: providers.StaticJsonRpcProvider,
    paused: Eventual<boolean>,
    isOperator: Eventual<boolean>,
    restakeRewards: boolean,
    queryFeesCollectedClaimThreshold: BigNumber,
    poiDisputeMonitoring: boolean,
    poiDisputableEpochs: number,
    gasIncreaseTimeout: number,
    gasIncreaseFactor: number,
    baseFeePerGasMax: number,
    maxTransactionAttempts: number,
  ) {
    this.logger = logger
    this.wallet = wallet
    this.indexerAddress = indexerAddress
    this.indexerUrl = indexerUrl
    this.indexerGeoCoordinates = geoCoordinates
    this.contracts = contracts
    this.networkSubgraph = networkSubgraph
    this.ethereum = ethereum
    this.paused = paused
    this.isOperator = isOperator
    this.restakeRewards = restakeRewards
    this.queryFeesCollectedClaimThreshold = queryFeesCollectedClaimThreshold
    this.poiDisputeMonitoring = poiDisputeMonitoring
    this.poiDisputableEpochs = poiDisputableEpochs
    this.gasIncreaseTimeout = gasIncreaseTimeout
    this.gasIncreaseFactor = gasIncreaseFactor
    this.baseFeePerGasMax = baseFeePerGasMax
    this.maxTransactionAttempts = maxTransactionAttempts
  }

  async executeTransaction(
    gasEstimation: () => Promise<BigNumber>,
    transaction: (gasLimit: BigNumberish) => Promise<ContractTransaction>,
    logger: Logger,
  ): Promise<ContractReceipt | 'paused' | 'unauthorized'> {
    if (await this.paused.value()) {
      logger.info(`Network is paused, skipping this action`)
      return 'paused'
    }

    if (!(await this.isOperator.value())) {
      logger.info(
        `Not authorized as an operator for indexer, skipping this action`,
      )
      return 'unauthorized'
    }

    let pending = true
    let output: providers.TransactionReceipt | undefined = undefined

    await this.waitForGasPricesBelowThreshold(logger)
    const paddedGasLimit = Math.ceil((await gasEstimation()).toNumber() * 1.5)

    const txPromise = transaction(paddedGasLimit)
    let tx = await txPromise
    let txRequest: providers.TransactionRequest | undefined = undefined

    let txConfig: TransactionConfig = {
      attempt: 1,
      nonceOffset: 0,
      gasBump: this.gasIncreaseFactor,
      nonce: tx.nonce,
      maxFeePerGas: tx.maxFeePerGas,
      maxPriorityFeePerGas: tx.maxPriorityFeePerGas,
      gasPrice: tx.gasPrice,
      gasLimit: tx.gasLimit,
    }

    logger.info(`Sending transaction`, { tx: tx, attempt: txConfig.attempt })

    while (pending) {
      if (
        this.maxTransactionAttempts !== 0 &&
        txConfig.attempt > this.maxTransactionAttempts
      ) {
        logger.warn('Transaction retry limit reached, giving up', {
          txConfig,
        })
        await delay(30000)
        break
      }

      try {
        if (txConfig.attempt > 1) {
          logger.info('Resubmitting transaction', {
            txConfig,
          })
          txRequest = {
            value: tx.value,
            to: tx.to,
            data: tx.data,
            chainId: tx.chainId,
            from: tx.from,
            nonce: txConfig.nonce,
            gasPrice: txConfig.gasPrice,
            maxPriorityFeePerGas: txConfig.maxPriorityFeePerGas,
            maxFeePerGas: txConfig.maxFeePerGas,
            gasLimit: txConfig.gasLimit,
          }
          tx = await this.wallet.sendTransaction(txRequest)
        }

        logger.info(`Transaction pending`, { tx: tx, txConfig })

        const receipt = await this.ethereum.waitForTransaction(
          tx.hash,
          3,
          this.gasIncreaseTimeout,
        )

        if (receipt.status == 0) {
          const revertReason = await this.getRevertReason(
            logger,
            txRequest as providers.TransactionRequest,
          )
          if (revertReason === 'out of gas') {
            throw indexerError(IndexerErrorCode.IE050)
          } else if (revertReason === 'unknown') {
            throw indexerError(IndexerErrorCode.IE051)
          } else {
            throw indexerError(IndexerErrorCode.IE057)
          }
        }

        logger.info(`Transaction successfully included in block`, {
          tx: tx.hash,
          receipt: receipt,
        })
        output = receipt
        pending = false
      } catch (error) {
        txConfig = await this.updateTransactionConfig(logger, txConfig, error)
        continue
      }
    }
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    return output!
  }

  async getRevertReason(
    logger: Logger,
    txRequest: providers.TransactionRequest,
  ): Promise<string> {
    let revertReason = 'unknown'
    try {
      const code = await this.ethereum.call(txRequest)
      revertReason = utils.toUtf8String(`0x${code.substr(138)}`)
    } catch (e) {
      if (e.body.includes('out of gas')) {
        revertReason = 'out of gas'
      } else {
        throw indexerError(IndexerErrorCode.IE051)
      }
    }
    logger.warn('Transaction reverted:', { reason: revertReason })
    return revertReason
  }

  async updateTransactionConfig(
    logger: Logger,
    txConfig: TransactionConfig,
    error: Error | IndexerError,
  ): Promise<TransactionConfig> {
    logger.warning(
      'Failed to send transaction, evaluating retry possibilities',
      {
        txConfig,
        error: error.message,
      },
    )
    if (error instanceof IndexerError) {
      if (error.code == IndexerErrorCode.IE050) {
        txConfig.gasLimit = BigNumber.from(txConfig.gasLimit).mul(
          txConfig.gasBump,
        )
        txConfig.nonce = BigNumber.from(txConfig.nonce).add(1)
      } else if (error.code == IndexerErrorCode.IE051) {
        throw error
      }
    } else if (error instanceof Error) {
      if (
        error.message.includes(
          'Transaction with the same hash was already imported',
        ) ||
        error.message.includes('nonce has already been used')
      ) {
        // This case typically indicates a successful transaction being retried.
        // Let's introduce a 30 second delay to ensure the previous transaction has
        // a chance to be mined and return to the reconciliation loop so the agent can reevaluate.
        delay(30000)
        throw error
      } else if (
        error.message.includes(
          'Transaction nonce is too low. Try incrementing the nonce.',
        )
      ) {
        txConfig.nonce = BigNumber.from(txConfig.nonce).add(1)
      } else if (
        error.message.includes('Try increasing the fee') ||
        error.message.includes('gas price supplied is too low') ||
        error.message?.includes('timeout exceeded')
      ) {
        const currentFeeData = await this.waitForGasPricesBelowThreshold(logger)
        txConfig.maxFeePerGas = currentFeeData.maxFeePerGas ?? undefined
        txConfig.maxPriorityFeePerGas =
          currentFeeData.maxPriorityFeePerGas ?? undefined
        txConfig.gasPrice = currentFeeData.gasPrice ?? undefined
      }
    }
    txConfig.attempt += 1
    return txConfig
  }

  async waitForGasPricesBelowThreshold(
    logger: Logger,
  ): Promise<providers.FeeData> {
    let attempt = 1
    let aboveThreshold = true
    let feeData = {
      gasPrice: BigNumber.from(this.baseFeePerGasMax),
      maxFeePerGas: null,
      maxPriorityFeePerGas: null,
    } as providers.FeeData

    while (aboveThreshold) {
      feeData = await this.ethereum.getFeeData()
      if (feeData.maxFeePerGas && feeData.maxPriorityFeePerGas) {
        // Type 0x02 transaction
        // This baseFeePerGas calculation is based off how maxFeePerGas is calculated in getFeeData()
        // https://github.com/ethers-io/ethers.js/blob/68229ac0aff790b083717dc73cd84f38d32a3926/packages/abstract-provider/src.ts/index.ts#L247
        const baseFeePerGas = feeData.maxFeePerGas
          .sub(feeData.maxPriorityFeePerGas)
          .div(2)
        if (baseFeePerGas.toNumber() >= this.baseFeePerGasMax) {
          if (attempt == 1) {
            logger.warning(
              `Max base fee per gas has been reached, waiting until the base fee falls below to resume transaction execution.`,
              { maxBaseFeePerGas: this.baseFeePerGasMax, baseFeePerGas },
            )
          } else {
            logger.info(
              `Base gas fee per gas estimation still above max threshold`,
              {
                maxBaseFeePerGas: this.baseFeePerGasMax,
                baseFeePerGas,
                priceEstimateAttempt: attempt,
              },
            )
          }
          await delay(30000)
          attempt++
        } else {
          aboveThreshold = false
          feeData.gasPrice = null
        }
      } else if (feeData.gasPrice) {
        // Legacy transaction type
        if (feeData.gasPrice.toNumber() >= this.baseFeePerGasMax) {
          if (attempt == 1) {
            logger.warning(
              `Max gas price has been reached, waiting until gas price estimates fall below to resume transaction execution.`,
              {
                baseFeePerGasMax: this.baseFeePerGasMax,
                currentGasPriceEstimate: feeData.gasPrice,
              },
            )
          } else {
            logger.info(`Gas price estimation still above max threshold`, {
              baseFeePerGasMax: this.baseFeePerGasMax,
              currentGasPriceEstimate: feeData.gasPrice,
              priceEstimateAttempt: attempt,
            })
          }
          await delay(30000)
          attempt++
        } else {
          aboveThreshold = false
        }
      }
    }
    return feeData
  }

  static async create(
    parentLogger: Logger,
    ethereum: providers.StaticJsonRpcProvider,
    contracts: NetworkContracts,
    wallet: Wallet,
    indexerAddress: Address,
    indexerUrl: string,
    geoCoordinates: [string, string],
    networkSubgraph: NetworkSubgraph,
    restakeRewards: boolean,
    queryFeesCollectedClaimThreshold: number,
    poiDisputeMonitoring: boolean,
    poiDisputableEpochs: number,
    gasIncreaseTimeout: number,
    gasIncreaseFactor: number,
    baseFeePerGasMax: number,
    maxTransactionAttempts: number,
  ): Promise<Network> {
    const logger = parentLogger.child({
      component: 'Network',
      indexer: indexerAddress.toString(),
      operator: wallet.address,
    })

    const paused = await monitorNetworkPauses(
      logger,
      contracts,
      networkSubgraph,
    )
    const isOperator = await monitorIsOperator(
      logger,
      contracts,
      indexerAddress,
      wallet,
    )

    return new Network(
      logger,
      wallet,
      indexerAddress,
      indexerUrl,
      geoCoordinates,
      contracts,
      networkSubgraph,
      ethereum,
      paused,
      isOperator,
      restakeRewards,
      parseGRT(queryFeesCollectedClaimThreshold.toString()),
      poiDisputeMonitoring,
      poiDisputableEpochs,
      gasIncreaseTimeout,
      gasIncreaseFactor,
      baseFeePerGasMax,
      maxTransactionAttempts,
    )
  }

  async subgraphDeploymentsWorthIndexing(
    rules: IndexingRuleAttributes[],
  ): Promise<SubgraphDeploymentID[]> {
    const globalRule = rules.find(
      rule => rule.deployment === INDEXING_RULE_GLOBAL,
    )

    const deployments = []
    const queryProgress = {
      lastId: '',
      first: 10,
      fetched: 0,
      exhausted: false,
      retriesRemaining: 10,
    }
    this.logger.info(
      `Query subgraph deployments in batches of ${queryProgress.first}`,
    )

    while (!queryProgress.exhausted) {
      this.logger.debug(`Query subgraph deployments`, {
        queryProgress: queryProgress,
      })
      try {
        const result = await this.networkSubgraph.query(
          gql`
            query subgraphDeployments($first: Int!, $lastId: String!) {
              subgraphDeployments(
                where: { id_gt: $lastId }
                orderBy: id
                orderDirection: asc
                first: $first
              ) {
                id
                stakedTokens
                signalAmount
                queryFeesAmount
                indexerAllocations {
                  indexer {
                    id
                  }
                }
              }
            }
          `,
          { first: queryProgress.first, lastId: queryProgress.lastId },
        )

        if (result.error) {
          throw result.error
        }

        const results = result.data.subgraphDeployments

        queryProgress.exhausted = results.length < queryProgress.first
        queryProgress.fetched += results.length
        queryProgress.lastId = results[results.length - 1].id

        deployments.push(
          ...results
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            .filter((deployment: any) => {
              const deploymentRule =
                rules.find(rule => rule.deployment === deployment.id) ||
                globalRule

              // The deployment is not eligible for deployment if it doesn't have an allocation amount
              if (!deploymentRule?.allocationAmount) {
                this.logger.debug(
                  `Could not find matching rule with non-zero 'allocationAmount':`,
                  {
                    deployment: deployment.display,
                  },
                )
                return false
              }

              // Skip the indexing rules checks if the decision basis is 'always' or 'never'
              if (
                deploymentRule?.decisionBasis === IndexingDecisionBasis.ALWAYS
              ) {
                return true
              } else if (
                deploymentRule?.decisionBasis === IndexingDecisionBasis.NEVER
              ) {
                return false
              }

              if (deploymentRule) {
                const stakedTokens = BigNumber.from(deployment.stakedTokens)
                const signalAmount = BigNumber.from(deployment.signalAmount)
                const avgQueryFees = BigNumber.from(
                  deployment.queryFeesAmount,
                ).div(
                  BigNumber.from(
                    Math.max(1, deployment.indexerAllocations.length),
                  ),
                )

                this.logger.trace('Deciding whether to allocate and index', {
                  deployment: {
                    id: deployment.id.display,
                    stakedTokens: stakedTokens.toString(),
                    signalAmount: signalAmount.toString(),
                    avgQueryFees: avgQueryFees.toString(),
                  },
                  indexingRule: {
                    deployment: deploymentRule.deployment,
                    minStake: deploymentRule.minStake
                      ? BigNumber.from(deploymentRule.minStake).toString()
                      : null,
                    minSignal: deploymentRule.minSignal
                      ? BigNumber.from(deploymentRule.minSignal).toString()
                      : null,
                    maxSignal: deploymentRule.maxSignal
                      ? BigNumber.from(deploymentRule.maxSignal).toString()
                      : null,
                    minAverageQueryFees: deploymentRule.minAverageQueryFees
                      ? BigNumber.from(
                          deploymentRule.minAverageQueryFees,
                        ).toString()
                      : null,
                  },
                })

                return (
                  // stake >= minStake?
                  (deploymentRule.minStake &&
                    stakedTokens.gte(deploymentRule.minStake)) ||
                  // signal >= minSignal && signal <= maxSignal?
                  (deploymentRule.minSignal &&
                    signalAmount.gte(deploymentRule.minSignal)) ||
                  (deploymentRule.maxSignal &&
                    signalAmount.lte(deploymentRule.maxSignal)) ||
                  // avgQueryFees >= minAvgQueryFees?
                  (deploymentRule.minAverageQueryFees &&
                    avgQueryFees.gte(deploymentRule.minAverageQueryFees))
                )
              } else {
                return false
              }
            })
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            .map((deployment: any) => new SubgraphDeploymentID(deployment.id)),
        )
      } catch (error) {
        queryProgress.retriesRemaining--
        this.logger.error(`Failed to query subgraph deployments`, {
          retriesRemaining: queryProgress.retriesRemaining,
          error: error,
        })
        if (queryProgress.retriesRemaining <= 0) {
          const err = indexerError(IndexerErrorCode.IE009, error)
          this.logger.error(
            `Failed to query subgraph deployments worth indexing`,
            {
              err,
            },
          )
          throw err
        }
      }
    }

    return deployments
  }

  async allocations(status: AllocationStatus): Promise<Allocation[]> {
    try {
      const result = await this.networkSubgraph.query(
        gql`
          query allocations($indexer: String!, $status: AllocationStatus!) {
            allocations(
              where: { indexer: $indexer, status: $status }
              first: 1000
            ) {
              id
              indexer {
                id
              }
              allocatedTokens
              createdAtEpoch
              closedAtEpoch
              createdAtBlockHash
              subgraphDeployment {
                id
                stakedTokens
                signalAmount
              }
            }
          }
        `,
        {
          indexer: this.indexerAddress.toLocaleLowerCase(),
          status: AllocationStatus[status],
        },
      )

      if (result.error) {
        throw result.error
      }

      return result.data.allocations.map(parseGraphQLAllocation)
    } catch (error) {
      const err = indexerError(IndexerErrorCode.IE010, error)
      this.logger.error(`Failed to query indexer allocations`, {
        err,
      })
      throw err
    }
  }

  async claimableAllocations(disputableEpoch: number): Promise<Allocation[]> {
    try {
      const result = await this.networkSubgraph.query(
        gql`
          query allocations(
            $indexer: String!
            $disputableEpoch: Int!
            $minimumQueryFeesCollected: BigInt!
          ) {
            allocations(
              where: {
                indexer: $indexer
                closedAtEpoch_lte: $disputableEpoch
                queryFeesCollected_gte: $minimumQueryFeesCollected
                status: Closed
              }
              first: 1000
            ) {
              id
              indexer {
                id
              }
              allocatedTokens
              createdAtEpoch
              closedAtEpoch
              createdAtBlockHash
              closedAtBlockHash
              subgraphDeployment {
                id
                stakedTokens
                signalAmount
              }
            }
          }
        `,
        {
          indexer: this.indexerAddress.toLocaleLowerCase(),
          disputableEpoch,
          minimumQueryFeesCollected: this.queryFeesCollectedClaimThreshold.toString(),
        },
      )

      if (result.error) {
        throw result.error
      }

      return result.data.allocations.map(parseGraphQLAllocation)
    } catch (error) {
      const err = indexerError(IndexerErrorCode.IE011, error)
      this.logger.error(INDEXER_ERROR_MESSAGES[IndexerErrorCode.IE011], {
        err,
      })
      throw err
    }
  }

  async disputableAllocations(
    currentEpoch: BigNumber,
    deployments: SubgraphDeploymentID[],
    minimumAllocation: number,
  ): Promise<Allocation[]> {
    const logger = this.logger.child({ component: 'PoI Monitor' })
    if (!this.poiDisputeMonitoring) {
      logger.debug('PoI monitoring disabled, skipping')
      return Promise.resolve([])
    }

    logger.debug(
      'Query network for any newly closed allocations for deployment this indexer is syncing (available reference PoIs',
    )

    let dataRemaining = true
    let allocations: Allocation[] = []

    try {
      const zeroPOI = utils.hexlify(Array(32).fill(0))
      const disputableEpoch = currentEpoch.toNumber() - this.poiDisputableEpochs
      let lastCreatedAt = 0
      while (dataRemaining) {
        const result = await this.networkSubgraph.query(
          gql`
            query allocations(
              $deployments: [String!]!
              $minimumAllocation: Int!
              $disputableEpoch: Int!
              $zeroPOI: String!
              $createdAt: Int!
            ) {
              allocations(
                where: {
                  createdAt_gt: $createdAt
                  subgraphDeployment_in: $deployments
                  allocatedTokens_gt: $minimumAllocation
                  closedAtEpoch_gte: $disputableEpoch
                  status: Closed
                  poi_not: $zeroPOI
                }
                first: 1000
                orderBy: createdAt
                orderDirection: asc
              ) {
                id
                createdAt
                indexer {
                  id
                }
                poi
                allocatedTokens
                createdAtEpoch
                closedAtEpoch
                closedAtBlockHash
                subgraphDeployment {
                  id
                  stakedTokens
                  signalAmount
                }
              }
            }
          `,
          {
            deployments: deployments.map(subgraph => subgraph.bytes32),
            minimumAllocation,
            disputableEpoch,
            createdAt: lastCreatedAt,
            zeroPOI,
          },
        )

        if (result.error) {
          throw result.error
        }
        if (result.data.allocations.length == 0) {
          dataRemaining = false
        } else {
          lastCreatedAt = result.data.allocations.slice(-1)[0].createdAt
          const parsedResult: Allocation[] = result.data.allocations.map(
            parseGraphQLAllocation,
          )
          allocations = allocations.concat(parsedResult)
        }
      }

      // Get the unique set of dispute epochs to reduce the work fetching epoch start block hashes in the next step
      let disputableEpochs = await this.epochs([
        ...allocations.reduce(
          (epochNumbers: Set<number>, allocation: Allocation) => {
            epochNumbers.add(allocation.closedAtEpoch)
            epochNumbers.add(allocation.closedAtEpoch - 1)
            return epochNumbers
          },
          new Set(),
        ),
      ])

      disputableEpochs = await Promise.all(
        disputableEpochs.map(
          async (epoch: Epoch): Promise<Epoch> => {
            // TODO: May need to retry or skip epochs where obtaining start block fails
            epoch.startBlockHash = (
              await this.ethereum.getBlock(epoch?.startBlock)
            )?.hash
            return epoch
          },
        ),
      )

      return await Promise.all(
        allocations.map(async allocation => {
          // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
          allocation.closedAtEpochStartBlockHash = disputableEpochs.find(
            epoch => epoch.id == allocation.closedAtEpoch,
          )!.startBlockHash
          // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
          allocation.previousEpochStartBlockHash = disputableEpochs.find(
            epoch => epoch.id == allocation.closedAtEpoch - 1,
          )!.startBlockHash
          return allocation
        }),
      )
    } catch (error) {
      const err = indexerError(IndexerErrorCode.IE037, error)
      logger.error(INDEXER_ERROR_MESSAGES.IE037, {
        err,
      })
      throw err
    }
  }

  async epochs(epochNumbers: number[]): Promise<Epoch[]> {
    try {
      const result = await this.networkSubgraph.query(
        gql`
          query epochs($epochs: [Int!]!) {
            epoches(where: { id_in: $epochs }, first: 1000) {
              id
              startBlock
              endBlock
              signalledTokens
              stakeDeposited
              queryFeeRebates
              totalRewards
              totalIndexerRewards
              totalDelegatorRewards
            }
          }
        `,
        {
          epochs: epochNumbers,
        },
      )

      if (result.error) {
        throw result.error
      }
      return result.data.epoches.map(parseGraphQLEpochs)
    } catch (error) {
      const err = indexerError(IndexerErrorCode.IE038, error)
      this.logger.error(INDEXER_ERROR_MESSAGES[IndexerErrorCode.IE038], {
        err,
      })
      throw err
    }
  }

  async register(): Promise<void> {
    const geoHash = geohash.encode(
      +this.indexerGeoCoordinates[0],
      +this.indexerGeoCoordinates[1],
    )

    const logger = this.logger.child({
      address: this.indexerAddress,
      url: this.indexerUrl,
      geoCoordinates: this.indexerGeoCoordinates,
      geoHash,
    })

    try {
      logger.info(`Register indexer`)

      // Register the indexer (only if it hasn't been registered yet or
      // if its URL is different from what is registered on chain)
      const isRegistered = await this.contracts.serviceRegistry.isRegistered(
        this.indexerAddress,
      )
      if (isRegistered) {
        const service = await this.contracts.serviceRegistry.services(
          this.indexerAddress,
        )
        if (service.url === this.indexerUrl && service.geohash === geoHash) {
          if (await this.isOperator.value()) {
            logger.info(
              `Indexer already registered, operator status already granted`,
            )
            return
          } else {
            logger.info(
              `Indexer already registered, operator status not yet granted`,
            )
          }
        }
      }
      const receipt = await this.executeTransaction(
        () =>
          this.contracts.serviceRegistry.estimateGas.registerFor(
            this.indexerAddress,
            this.indexerUrl,
            geoHash,
          ),
        gasLimit =>
          this.contracts.serviceRegistry.registerFor(
            this.indexerAddress,
            this.indexerUrl,
            geoHash,
            {
              gasLimit,
            },
          ),
        logger.child({ action: 'register' }),
      )
      if (receipt === 'paused' || receipt === 'unauthorized') {
        return
      }
      const event = receipt.events?.find(event =>
        event.topics.includes(
          this.contracts.serviceRegistry.interface.getEventTopic(
            'ServiceRegistered',
          ),
        ),
      )
      assert.ok(event)

      logger.info(`Successfully registered indexer`)
    } catch (error) {
      const err = indexerError(IndexerErrorCode.IE012, error)
      logger.error(`Failed to register indexer`, {
        err,
      })
      throw err
    }
  }

  async allocate(
    deployment: SubgraphDeploymentID,
    amount: BigNumber,
    activeAllocations: Allocation[],
  ): Promise<Allocation | undefined> {
    const logger = this.logger.child({ deployment: deployment.display })

    if (amount.lt('0')) {
      logger.warn(
        'Cannot allocate a negative amount of GRT, skipping this allocation',
        {
          amount: amount.toString(),
        },
      )
      return
    }

    if (amount.eq('0')) {
      logger.warn('Cannot allocate zero GRT, skipping this allocation', {
        amount: amount.toString(),
      })
      return
    }

    try {
      const currentEpoch = await this.contracts.epochManager.currentEpoch()

      logger.info(`Allocate to subgraph deployment`, {
        amountGRT: formatGRT(amount),
        epoch: currentEpoch.toString(),
      })

      // Identify how many GRT the indexer has staked
      const freeStake = await this.contracts.staking.getIndexerCapacity(
        this.indexerAddress,
      )

      // If there isn't enough left for allocating, abort
      if (freeStake.lt(amount)) {
        throw indexerError(
          IndexerErrorCode.IE013,
          new Error(
            `Allocation of ${formatGRT(
              amount,
            )} GRT cancelled: indexer only has a free stake amount of ${formatGRT(
              freeStake,
            )} GRT`,
          ),
        )
      }

      logger.debug('Obtain a unique Allocation ID')

      // Obtain a unique allocation ID
      const { allocationSigner, allocationId } = uniqueAllocationID(
        this.wallet.mnemonic.phrase,
        currentEpoch.toNumber(),
        deployment,
        activeAllocations.map(allocation => allocation.id),
      )

      // Double-check whether the allocationID already exists on chain, to
      // avoid unnecessary transactions.
      // Note: We're checking the allocation state here, which is defined as
      //
      //     enum AllocationState { Null, Active, Closed, Finalized, Claimed }
      //
      // in the contracts.
      const state = await this.contracts.staking.getAllocationState(
        allocationId,
      )
      if (state !== 0) {
        logger.debug(`Skipping allocation as it already exists onchain`, {
          indexer: this.indexerAddress,
          allocation: allocationId,
          state,
        })
        return
      }

      logger.info(`Allocate`, {
        indexer: this.indexerAddress,
        amount: formatGRT(amount),
        allocation: allocationId,
      })

      const receipt = await this.executeTransaction(
        async () =>
          this.contracts.staking.estimateGas.allocateFrom(
            this.indexerAddress,
            deployment.bytes32,
            amount,
            allocationId,
            utils.hexlify(Array(32).fill(0)),
            await allocationIdProof(
              allocationSigner,
              this.indexerAddress,
              allocationId,
            ),
          ),
        async gasLimit =>
          this.contracts.staking.allocateFrom(
            this.indexerAddress,
            deployment.bytes32,
            amount,
            allocationId,
            utils.hexlify(Array(32).fill(0)),
            await allocationIdProof(
              allocationSigner,
              this.indexerAddress,
              allocationId,
            ),
            { gasLimit },
          ),
        logger.child({ action: 'allocate' }),
      )

      if (receipt === 'paused' || receipt === 'unauthorized') {
        return
      }

      const event =
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        receipt.events?.find((event: any) =>
          event.topics.includes(
            this.contracts.staking.interface.getEventTopic('AllocationCreated'),
          ),
        ) ||
        receipt.logs?.find((log: providers.Log) =>
          log.topics.includes(
            this.contracts.staking.interface.getEventTopic('AllocationCreated'),
          ),
        )
      if (!event) {
        throw indexerError(
          IndexerErrorCode.IE014,
          new Error(`Allocation was never mined`),
        )
      }

      const eventInputs = this.contracts.staking.interface.decodeEventLog(
        'AllocationCreated',
        event.data,
        event.topics,
      )

      logger.info(`Successfully allocated to subgraph deployment`, {
        amountGRT: formatGRT(eventInputs.tokens),
        allocation: eventInputs.allocationID,
        epoch: eventInputs.epoch.toString(),
      })

      return {
        id: allocationId,
        subgraphDeployment: {
          id: deployment,
          stakedTokens: BigNumber.from(0),
          signalAmount: BigNumber.from(0),
        },
        allocatedTokens: BigNumber.from(eventInputs.tokens),
        createdAtBlockHash: '0x0',
        createdAtEpoch: eventInputs.epoch,
        closedAtEpoch: 0,
        closedAtBlockHash: '0x0',
        closedAtEpochStartBlockHash: '0x0',
        poi: undefined,
      } as Allocation
    } catch (err) {
      logger.error(`Failed to allocate`, {
        amount: formatGRT(amount),
        err,
      })
    }
  }

  async close(allocation: Allocation, poi: string): Promise<boolean> {
    const logger = this.logger.child({
      allocation: allocation.id,
      deployment: allocation.subgraphDeployment.id.display,
      createdAtEpoch: allocation.createdAtEpoch,
      poi: poi,
      createdAtBlockHash: allocation.createdAtBlockHash,
    })
    try {
      logger.info(`Close allocation`)

      // Double-check whether the allocation is still active on chain, to
      // avoid unnecessary transactions.
      // Note: We're checking the allocation state here, which is defined as
      //
      //     enum AllocationState { Null, Active, Closed, Finalized, Claimed }
      //
      // in the contracts.
      const state = await this.contracts.staking.getAllocationState(
        allocation.id,
      )
      if (state !== 1) {
        logger.info(`Allocation has already been closed`)
        return true
      }

      const receipt = await this.executeTransaction(
        () =>
          this.contracts.staking.estimateGas.closeAllocation(
            allocation.id,
            poi,
          ),
        gasLimit =>
          this.contracts.staking.closeAllocation(allocation.id, poi, {
            gasLimit,
          }),
        logger.child({ action: 'close' }),
      )
      if (receipt === 'paused' || receipt === 'unauthorized') {
        return false
      }
      logger.info(`Successfully closed allocation`)
      return true
    } catch (err) {
      logger.warn(`Failed to close allocation`, {
        err: indexerError(IndexerErrorCode.IE015, err),
      })
      return false
    }
  }

  async closeAndAllocate(
    // close fields
    existingAllocation: Allocation,
    poi: string,
    // allocate fields
    deployment: SubgraphDeploymentID,
    amount: BigNumber,
    activeAllocations: Allocation[],
  ): Promise<Allocation | undefined> {
    const logger = this.logger.child({
      allocation: existingAllocation.id,
      deployment: existingAllocation.subgraphDeployment.id.display,
      createdAtEpoch: existingAllocation.createdAtEpoch,
      poi: poi,
      createdAtBlockHash: existingAllocation.createdAtBlockHash,
    })
    try {
      // Double-check whether the allocation is still active on chain, to
      // avoid unnecessary transactions.
      // Note: We're checking the allocation state here, which is defined as
      //
      //     enum AllocationState { Null, Active, Closed, Finalized, Claimed }
      //
      // in the contracts.
      const existingState = await this.contracts.staking.getAllocationState(
        existingAllocation.id,
      )
      if (existingState !== 1) {
        logger.info(`Existing allocation has already been closed`)
        return
      }

      if (amount.lt('0')) {
        logger.warn(
          'Cannot reallocate a negative amount of GRT, skipping this allocation',
          {
            amount: amount.toString(),
          },
        )
        return
      }

      if (amount.eq('0')) {
        logger.warn('Cannot reallocate zero GRT, skipping this allocation', {
          amount: amount.toString(),
        })
        return
      }

      const currentEpoch = await this.contracts.epochManager.currentEpoch()

      logger.info(`Reallocate to subgraph deployment`, {
        existingAllocationAmount: formatGRT(existingAllocation.allocatedTokens),
        newAllocationAmount: formatGRT(amount),
        epoch: currentEpoch.toString(),
      })

      // Identify how many GRT the indexer has staked
      const freeStake = await this.contracts.staking.getIndexerCapacity(
        this.indexerAddress,
      )

      // When reallocating, we will first close the old allocation and free up the GRT in that allocation
      // This GRT will be available in addition to freeStake for the new allocation
      const postCloseFreeStake = freeStake.add(
        existingAllocation.allocatedTokens,
      )

      // If there isn't enough left for allocating, abort
      if (postCloseFreeStake.lt(amount)) {
        throw indexerError(
          IndexerErrorCode.IE013,
          new Error(
            `Unable to allocate ${formatGRT(
              amount,
            )} GRT: indexer only has a free stake amount of ${formatGRT(
              freeStake,
            )} GRT, plus ${formatGRT(
              existingAllocation.allocatedTokens,
            )} GRT from the existing allocation`,
          ),
        )
      }

      logger.debug('Obtain a unique Allocation ID')

      // Obtain a unique allocation ID
      const {
        allocationSigner,
        allocationId: newAllocationId,
      } = uniqueAllocationID(
        this.wallet.mnemonic.phrase,
        currentEpoch.toNumber(),
        deployment,
        activeAllocations.map(allocation => allocation.id),
      )

      // Double-check whether the allocationID already exists on chain, to
      // avoid unnecessary transactions.
      // Note: We're checking the allocation state here, which is defined as
      //
      //     enum AllocationState { Null, Active, Closed, Finalized, Claimed }
      //
      // in the contracts.
      const newAllocationState = await this.contracts.staking.getAllocationState(
        newAllocationId,
      )
      if (newAllocationState !== 0) {
        logger.warn(`Skipping Allocation as it already exists onchain`, {
          indexer: this.indexerAddress,
          allocation: newAllocationId,
          newAllocationState,
        })
        return
      }

      const proof = await allocationIdProof(
        allocationSigner,
        this.indexerAddress,
        newAllocationId,
      )

      logger.info(`Executing reallocate transaction`, {
        indexer: this.indexerAddress,
        amount: formatGRT(amount),
        oldAllocation: existingAllocation.id,
        newAllocation: newAllocationId,
        deployment,
        poi,
        proof,
      })

      const receipt = await this.executeTransaction(
        async () =>
          this.contracts.staking.estimateGas.closeAndAllocate(
            existingAllocation.id,
            poi,
            this.indexerAddress,
            deployment.bytes32,
            amount,
            newAllocationId,
            utils.hexlify(Array(32).fill(0)), // metadata
            proof,
          ),
        async gasLimit =>
          this.contracts.staking.closeAndAllocate(
            existingAllocation.id,
            poi,
            this.indexerAddress,
            deployment.bytes32,
            amount,
            newAllocationId,
            utils.hexlify(Array(32).fill(0)), // metadata
            proof,
            { gasLimit },
          ),
        logger.child({ action: 'closeAndAllocate' }),
      )

      if (receipt === 'paused' || receipt === 'unauthorized') {
        return
      }

      const event =
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        receipt.events?.find((event: any) =>
          event.topics.includes(
            this.contracts.staking.interface.getEventTopic('AllocationCreated'),
          ),
        ) ||
        receipt.logs?.find((log: providers.Log) =>
          log.topics.includes(
            this.contracts.staking.interface.getEventTopic('AllocationCreated'),
          ),
        )
      if (!event) {
        throw indexerError(
          IndexerErrorCode.IE014,
          new Error(`Allocation was never mined`),
        )
      }

      const eventInputs = this.contracts.staking.interface.decodeEventLog(
        'AllocationCreated',
        event.data,
        event.topics,
      )

      logger.info(`Successfully reallocated to subgraph deployment`, {
        deployment: deployment.display,
        amountGRT: formatGRT(eventInputs.tokens),
        allocation: eventInputs.allocationID,
        epoch: eventInputs.epoch.toString(),
      })

      return {
        id: newAllocationId,
        subgraphDeployment: {
          id: deployment,
          stakedTokens: BigNumber.from(0),
          signalAmount: BigNumber.from(0),
        },
        allocatedTokens: BigNumber.from(eventInputs.tokens),
        createdAtBlockHash: receipt.blockHash,
        createdAtEpoch: eventInputs.epoch,
        closedAtEpoch: 0,
        closedAtBlockHash: '0x0',
        closedAtEpochStartBlockHash: '0x0',
        poi: undefined,
      } as Allocation
    } catch (err) {
      logger.error(`Failed to closeAndAllocate`, {
        amount: formatGRT(amount),
        err,
      })
    }
  }

  async claim(allocation: Allocation): Promise<boolean> {
    const logger = this.logger.child({
      allocation: allocation.id,
      deployment: allocation.subgraphDeployment.id.display,
      createdAtEpoch: allocation.createdAtEpoch,
      closedAtEpoch: allocation.closedAtEpoch,
      createdAtBlockHash: allocation.createdAtBlockHash,
      restakeRewards: this.restakeRewards,
    })
    try {
      logger.info(`Claim tokens from the rebate pool for allocation`)

      // Double-check whether the allocation is claimed to
      // avoid unnecessary transactions.
      // Note: We're checking the allocation state here, which is defined as
      //
      //     enum AllocationState { Null, Active, Closed, Finalized, Claimed }
      //
      // in the contracts.
      const state = await this.contracts.staking.getAllocationState(
        allocation.id,
      )
      if (state === 4) {
        logger.info(`Allocation rebate rewards already claimed`)
        return true
      }
      if (state === 1) {
        logger.info(`Allocation still active`)
        return true
      }

      // Claim the earned value from the rebate pool, returning it to the indexers stake
      const receipt = await this.executeTransaction(
        () =>
          this.contracts.staking.estimateGas.claim(
            allocation.id,
            this.restakeRewards,
          ),
        gasLimit =>
          this.contracts.staking.claim(allocation.id, this.restakeRewards, {
            gasLimit,
          }),
        logger.child({ action: 'claim' }),
      )
      if (receipt === 'paused' || receipt === 'unauthorized') {
        return false
      }
      logger.info(`Successfully claimed allocation`)
      return true
    } catch (err) {
      logger.warn(`Failed to claim allocation`, {
        err: indexerError(IndexerErrorCode.IE016, err),
      })
      return false
    }
  }
}

async function monitorNetworkPauses(
  logger: Logger,
  contracts: NetworkContracts,
  networkSubgraph: NetworkSubgraph,
): Promise<Eventual<boolean>> {
  return timer(60_000)
    .reduce(async currentlyPaused => {
      try {
        const result = await networkSubgraph.query(
          gql`
            {
              graphNetworks {
                isPaused
              }
            }
          `,
        )

        if (result.error) {
          throw result.error
        }

        if (!result.data || result.data.length === 0) {
          throw new Error(`No data returned by network subgraph`)
        }

        return result.data.graphNetworks[0].isPaused
      } catch (err) {
        logger.warn(
          `Failed to check for network pause, assuming it has not changed`,
          {
            err: indexerError(IndexerErrorCode.IE007, err),
            paused: currentlyPaused,
          },
        )
        return currentlyPaused
      }
    }, await contracts.controller.paused())
    .map(paused => {
      logger.info(paused ? `Network paused` : `Network active`)
      return paused
    })
}

async function monitorIsOperator(
  logger: Logger,
  contracts: NetworkContracts,
  indexerAddress: Address,
  wallet: Wallet,
): Promise<Eventual<boolean>> {
  // If indexer and operator address are identical, operator status is
  // implicitly granted => we'll never have to check again
  if (indexerAddress === toAddress(wallet.address)) {
    logger.info(`Indexer and operator are identical, operator status granted`)
    return mutable(true)
  }

  return timer(60_000)
    .reduce(async isOperator => {
      try {
        return await contracts.staking.isOperator(
          wallet.address,
          indexerAddress,
        )
      } catch (err) {
        logger.warn(
          `Failed to check operator status for indexer, assuming it has not changed`,
          { err: indexerError(IndexerErrorCode.IE008, err), isOperator },
        )
        return isOperator
      }
    }, await contracts.staking.isOperator(wallet.address, indexerAddress))
    .map(isOperator => {
      logger.info(
        isOperator
          ? `Have operator status for indexer`
          : `No operator status for indexer`,
      )
      return isOperator
    })
}
