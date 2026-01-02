/* eslint-disable @typescript-eslint/no-unnecessary-condition */
import { Store } from '@tanstack/store'
import { DeduplicatedLoadSubset } from '@tanstack/db'
import {
  ExpectedDeleteTypeError,
  ExpectedInsertTypeError,
  ExpectedUpdateTypeError,
  TimeoutWaitingForIdsError,
} from './errors'
import type { Event, Filter, FilterOrComposite, ListOpts, RecordApi } from 'trailbase'

import type {
  BaseCollectionConfig,
  CollectionConfig,
  DeleteMutationFnParams,
  InsertMutationFnParams,
  LoadSubsetOptions,
  SyncConfig,
  SyncMode,
  UpdateMutationFnParams,
  UtilsRecord,
} from '@tanstack/db'

/**
 * Symbol for internal test hooks - allows tests to control sync timing
 */
export const TRAILBASE_TEST_HOOKS = Symbol.for(`TRAILBASE_TEST_HOOKS`)

/**
 * Test hooks interface for controlling sync behavior in tests
 */
export interface TrailBaseTestHooks {
  /**
   * Called before marking the collection as ready in progressive mode.
   * Return a promise that resolves when the collection should be marked ready.
   * This allows tests to pause and inspect the collection state during initial sync.
   */
  beforeMarkingReady?: () => Promise<void>
}

type ShapeOf<T> = Record<keyof T, unknown>
type Conversion<I, O> = (value: I) => O

type OptionalConversions<
  InputType extends ShapeOf<OutputType>,
  OutputType extends ShapeOf<InputType>,
> = {
  // Excludes all keys that require a conversation.
  [K in keyof InputType as InputType[K] extends OutputType[K]
    ? K
    : never]?: Conversion<InputType[K], OutputType[K]>
}

type RequiredConversions<
  InputType extends ShapeOf<OutputType>,
  OutputType extends ShapeOf<InputType>,
> = {
  // Excludes all keys that do not strictly require a conversation.
  [K in keyof InputType as InputType[K] extends OutputType[K]
    ? never
    : K]: Conversion<InputType[K], OutputType[K]>
}

type Conversions<
  InputType extends ShapeOf<OutputType>,
  OutputType extends ShapeOf<InputType>,
> = OptionalConversions<InputType, OutputType> &
  RequiredConversions<InputType, OutputType>

function convert<
  InputType extends ShapeOf<OutputType> & Record<string, unknown>,
  OutputType extends ShapeOf<InputType>,
>(
  conversions: Conversions<InputType, OutputType>,
  input: InputType,
): OutputType {
  const c = conversions as Record<string, Conversion<InputType, OutputType>>

  return Object.fromEntries(
    Object.keys(input).map((k: string) => {
      const value = input[k]
      return [k, c[k]?.(value as any) ?? value]
    }),
  ) as OutputType
}

function convertPartial<
  InputType extends ShapeOf<OutputType> & Record<string, unknown>,
  OutputType extends ShapeOf<InputType>,
>(
  conversions: Conversions<InputType, OutputType>,
  input: Partial<InputType>,
): Partial<OutputType> {
  const c = conversions as Record<string, Conversion<InputType, OutputType>>

  return Object.fromEntries(
    Object.keys(input).map((k: string) => {
      const value = input[k]
      return [k, c[k]?.(value as any) ?? value]
    }),
  ) as OutputType
}

/**
 * Decode a base64-encoded BLOB UUID to a standard UUID string format for proper sorting.
 * TrailBase stores UUIDs as BLOBs and returns them as base64, which doesn't sort correctly.
 * This function decodes the base64 to get the UUID string which sorts lexicographically.
 */
function decodeIdForSorting(rawId: unknown): string {
  const idStr = String(rawId ?? ``)

  // Check if it's already a UUID string format - return as-is
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(idStr)) {
    return idStr
  }

  // Check if it's an integer - return as-is
  if (/^\d+$/.test(idStr)) {
    return idStr
  }

  // Try to decode base64 to UUID
  try {
    // Convert URL-safe base64 to standard base64
    const standardBase64 = idStr.replace(/-/g, `+`).replace(/_/g, `/`)
    // Add padding if needed
    const padded = standardBase64 + `==`.slice(0, (4 - standardBase64.length % 4) % 4)

    // Decode base64 to bytes
    const binaryString = atob(padded)

    // Only process if it looks like a UUID (16 bytes)
    if (binaryString.length !== 16) {
      return idStr
    }

    const bytes = new Uint8Array(binaryString.length)
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i)
    }

    // Convert bytes to UUID string format
    const hex = Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, `0`))
      .join(``)

    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
  } catch {
    // If decoding fails, return the original string
    return idStr
  }
}

/**
 * Convert LoadSubsetOptions.orderBy to TrailBase's order format.
 * TrailBase uses prefix notation:
 * - Ascending: "column" or "+column"
 * - Descending: "-column"
 * Multiple columns are comma-joined: "created,-rank"
 */
function compileOrderBy(orderBy: LoadSubsetOptions['orderBy']): Array<string> | undefined {
  if (!orderBy || orderBy.length === 0) {
    return undefined
  }

  return orderBy.map((clause) => {
    // Extract field name from the expression
    const expr = clause.expression
    if (expr.type !== `ref` || !expr.path || expr.path.length === 0) {
      // Only simple field references are supported
      return null
    }

    const fieldName = expr.path.join(`.`)
    // TrailBase uses prefix: - for descending, + or nothing for ascending
    const prefix = clause.compareOptions?.direction === `desc` ? `-` : ``
    return `${prefix}${fieldName}`
  }).filter((x): x is string => x !== null)
}

/**
 * Convert LoadSubsetOptions.where to TrailBase's filters format.
 * TrailBase uses Filter objects with {column, op, value} structure.
 *
 * Note: Filter compilation is best-effort. Complex predicates or type mismatches
 * (e.g., boolean values for INTEGER columns) may not compile correctly.
 * In such cases, we return undefined and let client-side filtering handle it.
 *
 * Supported operators:
 * - eq, gt, gte, lt, lte → equal, greaterThan, greaterThanEqual, lessThan, lessThanEqual
 * - like → like
 * - and, or → composite filters
 */
function compileFilters(where: LoadSubsetOptions['where']): Array<FilterOrComposite> | undefined {
  if (!where) {
    return undefined
  }

  try {
    const result = compileExpression(where)
    return result ? [result] : undefined
  } catch {
    // If filter compilation fails, return undefined and let client-side handle it
    return undefined
  }
}

/**
 * Recursively compile a BasicExpression to TrailBase FilterOrComposite
 */
function compileExpression(expr: NonNullable<LoadSubsetOptions['where']>): FilterOrComposite | null {
  if (expr.type === `val`) {
    // Value expressions (true/false) don't map to filters
    return null
  }

  if (expr.type === `func`) {
    const func = expr as { type: 'func'; name: string; args: Array<any> }

    // Handle logical operators
    if (func.name === `and`) {
      const compiled = func.args
        .map((arg) => compileExpression(arg))
        .filter((x): x is FilterOrComposite => x !== null)
      if (compiled.length === 0) return null
      if (compiled.length === 1) return compiled[0]!
      return { and: compiled }
    }

    if (func.name === `or`) {
      const compiled = func.args
        .map((arg) => compileExpression(arg))
        .filter((x): x is FilterOrComposite => x !== null)
      if (compiled.length === 0) return null
      if (compiled.length === 1) return compiled[0]!
      return { or: compiled }
    }

    // Handle comparison operators
    const opMap: Record<string, Filter['op']> = {
      eq: `equal`,
      gt: `greaterThan`,
      gte: `greaterThanEqual`,
      lt: `lessThan`,
      lte: `lessThanEqual`,
      like: `like`,
    }

    if (opMap[func.name]) {
      const [refArg, valArg] = func.args
      if (refArg?.type === `ref` && valArg?.type === `val`) {
        const fieldName = refArg.path?.join(`.`)
        if (!fieldName) return null

        // TrailBase expects all values as strings
        // Handle common type conversions
        const value = valArg.value
        let stringValue: string
        if (value === null) {
          stringValue = ``
        } else if (typeof value === `boolean`) {
          // Convert boolean to SQLite INTEGER convention (0/1)
          stringValue = value ? `1` : `0`
        } else if (value instanceof Date) {
          stringValue = value.toISOString()
        } else {
          stringValue = String(value)
        }

        return {
          column: fieldName,
          op: opMap[func.name],
          value: stringValue,
        }
      }
    }

    // Handle IN operator - convert to OR of equals
    if (func.name === `in`) {
      const [refArg, valArg] = func.args
      if (refArg?.type === `ref` && valArg?.type === `val` && Array.isArray(valArg.value)) {
        const fieldName = refArg.path?.join(`.`)
        if (!fieldName) return null

        const equalities = valArg.value.map((v): Filter => {
          let stringValue: string
          if (v === null) {
            stringValue = ``
          } else if (typeof v === `boolean`) {
            stringValue = v ? `1` : `0`
          } else if (v instanceof Date) {
            stringValue = v.toISOString()
          } else {
            stringValue = String(v)
          }
          return {
            column: fieldName,
            op: `equal`,
            value: stringValue,
          }
        })

        if (equalities.length === 0) return null
        if (equalities.length === 1) return equalities[0]!
        return { or: equalities }
      }
    }
  }

  // Unsupported expression type
  return null
}

/**
 * The mode of sync to use for the collection.
 * @default `eager`
 * @description
 * - `eager`:
 *   - syncs all data immediately on preload
 *   - collection will be marked as ready once the sync is complete
 *   - there is no incremental sync
 * - `on-demand`:
 *   - syncs data incrementally when the collection is queried
 *   - collection will be marked as ready immediately after the subscription starts
 * - `progressive`:
 *   - syncs all data for the collection in the background
 *   - uses loadSubset during the initial sync to provide a fast path to the data required for queries
 *   - collection will be marked as ready immediately, with full sync completing in background
 */
export type TrailBaseSyncMode = SyncMode | `progressive`

/**
 * Configuration interface for Trailbase Collection
 */
export interface TrailBaseCollectionConfig<
  TItem extends object,
  TRecord extends object = TItem,
  TKey extends string | number = string | number,
> extends Omit<
  BaseCollectionConfig<TItem, TKey>,
  `onInsert` | `onUpdate` | `onDelete` | `syncMode`
> {
  /**
   * Record API name
   */
  recordApi: RecordApi<TRecord>

  /**
   * The mode of sync to use for the collection.
   * @default `eager`
   */
  syncMode?: TrailBaseSyncMode

  /**
   * Function to parse a TrailBase record into the app item type.
   * Use this for full control over the transformation including key renaming.
   */
  parse: ((record: TRecord) => TItem) | Conversions<TRecord & ShapeOf<TItem>, TItem & ShapeOf<TRecord>>

  /**
   * Function to serialize an app item into a TrailBase record.
   * Use this for full control over the transformation including key renaming.
   */
  serialize: ((item: TItem) => TRecord) | Conversions<TItem & ShapeOf<TRecord>, TRecord & ShapeOf<TItem>>

  /**
   * Function to serialize a partial app item into a partial TrailBase record.
   * Used for updates. If not provided, serialize will be used.
   */
  serializePartial?: (item: Partial<TItem>) => Partial<TRecord>

  /**
   * Internal test hooks for controlling sync behavior.
   * This is intended for testing only and should not be used in production.
   */
  [TRAILBASE_TEST_HOOKS]?: TrailBaseTestHooks
}

export type AwaitTxIdFn = (txId: string, timeout?: number) => Promise<boolean>

export interface TrailBaseCollectionUtils extends UtilsRecord {
  cancel: () => void
}

/**
 * Creates a DeduplicatedLoadSubset wrapper for TrailBase.
 * This handles deduplication of loadSubset calls using the @tanstack/db pattern.
 */
function createLoadSubsetDedupe<TRecord, TItem>({
  syncMode,
  isFullSyncComplete,
  begin,
  write,
  commit,
  parse,
  recordApi,
  decodeIdForSorting,
}: {
  syncMode: TrailBaseSyncMode
  isFullSyncComplete: () => boolean
  begin: () => void
  write: (mutation: { type: `insert` | `update` | `delete`; value: TItem }) => void
  commit: () => void
  parse: (record: TRecord) => TItem
  recordApi: RecordApi<TRecord>
  decodeIdForSorting: (id: unknown) => string
}): DeduplicatedLoadSubset {
  // The raw loadSubset function that actually fetches data
  const loadSubset = async (opts: LoadSubsetOptions): Promise<void> => {
    // In progressive mode after full sync is complete, no need to load more
    if (syncMode === `progressive` && isFullSyncComplete()) {
      return
    }

    // Compile the query parameters to TrailBase format
    const limit = opts.limit ?? 256
    const order = compileOrderBy(opts.orderBy)
    const filters = compileFilters(opts.where)

    // Build the list options with proper ordering and filtering
    const listOpts: ListOpts = {
      pagination: { limit },
    }

    if (order && order.length > 0) {
      listOpts.order = order
    }

    if (filters && filters.length > 0) {
      listOpts.filters = filters
    }

    let response
    let records: Array<TRecord>
    let usedOrder = order

    try {
      response = await recordApi.list(listOpts)
      records = response?.records ?? []
    } catch {
      // If the query fails (e.g., unsupported filter/order), retry without filters/order
      // This allows client-side handling while ensuring data is still loaded
      usedOrder = undefined
      response = await recordApi.list({ pagination: { limit } })
      records = response?.records ?? []
    }

    if (records.length > 0) {
      // When no explicit ordering was successfully applied, sort by ID for consistent insertion order
      // This ensures deterministic tie-breaking for queries
      // When ordering IS successfully applied, TrailBase returns data in the correct order
      let processedRecords = records
      if (!usedOrder || usedOrder.length === 0) {
        processedRecords = [...records].sort((a: TRecord, b: TRecord) => {
          const idA = decodeIdForSorting(a[`id` as keyof TRecord])
          const idB = decodeIdForSorting(b[`id` as keyof TRecord])
          return idA.localeCompare(idB)
        })
      }

      begin()
      for (const item of processedRecords) {
        write({ type: `insert`, value: parse(item) })
      }
      commit()
    }
  }

  // Wrap with DeduplicatedLoadSubset for proper deduplication handling
  return new DeduplicatedLoadSubset({ loadSubset })
}

export function trailBaseCollectionOptions<
  TItem extends object,
  TRecord extends object = TItem,
  TKey extends string | number = string | number,
>(
  config: TrailBaseCollectionConfig<TItem, TRecord, TKey>,
): CollectionConfig<TItem, TKey> & {
  utils: TrailBaseCollectionUtils
} {
  const getKey = config.getKey

  // Support both function and Conversions for parse
  const parse: (record: TRecord) => TItem =
    typeof config.parse === `function`
      ? config.parse
      : (record: TRecord) =>
          convert<TRecord & ShapeOf<TItem>, TItem & ShapeOf<TRecord>>(
            config.parse as Conversions<TRecord & ShapeOf<TItem>, TItem & ShapeOf<TRecord>>,
            record as TRecord & ShapeOf<TItem>,
          ) as TItem

  // Support both function and Conversions for serialize
  const serialIns: (item: TItem) => TRecord =
    typeof config.serialize === `function`
      ? config.serialize
      : (item: TItem) =>
          convert<TItem & ShapeOf<TRecord>, TRecord & ShapeOf<TItem>>(
            config.serialize as Conversions<TItem & ShapeOf<TRecord>, TRecord & ShapeOf<TItem>>,
            item as TItem & ShapeOf<TRecord>,
          ) as TRecord

  // For partial updates, use serializePartial if provided, otherwise fall back to a simple implementation
  const serialUpd: (item: Partial<TItem>) => Partial<TRecord> =
    config.serializePartial ??
    (typeof config.serialize === `function`
      ? (item: Partial<TItem>) => {
          // For function serializers, we need to handle partial items carefully
          // We serialize and then extract only the keys that were in the partial
          const keys = Object.keys(item) as Array<keyof TItem>
          // Use serialIns which is already captured as the narrowed function version
          const full = serialIns(item as TItem)
          const result: Partial<TRecord> = {}
          for (const key of keys) {
            // Map the key if there's a known mapping (simplified approach)
            const recordKey = key as unknown as keyof TRecord
            if (recordKey in full) {
              result[recordKey] = full[recordKey]
            }
          }
          return result
        }
      : (item: Partial<TItem>) =>
          convertPartial<TItem & ShapeOf<TRecord>, TRecord & ShapeOf<TItem>>(
            config.serialize as Conversions<TItem & ShapeOf<TRecord>, TRecord & ShapeOf<TItem>>,
            item as Partial<TItem & ShapeOf<TRecord>>,
          ) as Partial<TRecord>)

  // AbortController is created fresh on each sync() call to support cleanup/restart
  let currentAbortController: AbortController | null = null

  const seenIds = new Store(new Map<string, number>())

  const internalSyncMode = config.syncMode ?? `eager`
  // For the collection config, progressive acts like on-demand (needs loadSubset)
  const finalSyncMode =
    internalSyncMode === `progressive` ? `on-demand` : internalSyncMode
  let fullSyncCompleted = false

  // Get test hooks if provided
  const testHooks = config[TRAILBASE_TEST_HOOKS]

  const awaitIds = (
    ids: Array<string>,
    timeout: number = 120 * 1000,
  ): Promise<void> => {
    const completed = (value: Map<string, number>) =>
      ids.every((id) => value.has(id))
    if (completed(seenIds.state)) {
      return Promise.resolve()
    }

    return new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        clearTimeout(timeoutId)
        reject(new TimeoutWaitingForIdsError(`Aborted while waiting for ids`))
      }

      currentAbortController?.signal.addEventListener(`abort`, onAbort)

      const timeoutId = setTimeout(
        () => reject(new TimeoutWaitingForIdsError(ids.toString())),
        timeout,
      )

      const unsubscribe = seenIds.subscribe((value) => {
        if (completed(value.currentVal)) {
          clearTimeout(timeoutId)
          currentAbortController?.signal.removeEventListener(`abort`, onAbort)
          unsubscribe()
          resolve()
        }
      })
    })
  }

  type SyncParams = Parameters<SyncConfig<TItem, TKey>[`sync`]>[0]
  const sync = {
    sync: (params: SyncParams) => {
      const { begin, write, commit, markReady } = params

      // Create a fresh AbortController for this sync session
      // This is essential for cleanup/restart to work correctly
      currentAbortController = new AbortController()

      // Reset state for fresh sync
      seenIds.setState(new Map<string, number>())
      fullSyncCompleted = false

      // Initial fetch.
      async function initialFetch() {
        const limit = 256
        let response = await config.recordApi.list({
          pagination: {
            limit,
          },
        })
        let cursor = response.cursor

        // Collect all records first
        const allRecords: Array<TRecord> = []

        while (true) {
          const length = response.records.length
          if (length === 0) break

          allRecords.push(...response.records)

          if (length < limit) break

          response = await config.recordApi.list({
            pagination: {
              limit,
              cursor,
              offset: cursor === undefined ? allRecords.length : undefined,
            },
          })
          cursor = response.cursor
        }

        // Sort by ID for consistent insertion order (deterministic tie-breaking)
        // Decode base64 IDs to UUIDs for proper lexicographic sorting
        allRecords.sort((a: TRecord, b: TRecord) => {
          const idA = decodeIdForSorting(a[`id` as keyof TRecord])
          const idB = decodeIdForSorting(b[`id` as keyof TRecord])
          return idA.localeCompare(idB)
        })

        begin()
        for (const item of allRecords) {
          write({
            type: `insert`,
            value: parse(item),
          })
        }

        commit()
      }

      // Afterwards subscribe.
      async function listen(reader: ReadableStreamDefaultReader<Event>) {
        console.log(`[TrailBase] Subscription listener started`)
        while (true) {
          const { done, value: event } = await reader.read()

          if (done || !event) {
            console.log(`[TrailBase] Subscription stream ended`)
            try {
              if ((reader as any).locked) {
                reader.releaseLock()
              }
            } catch {
              // ignore if already released
            }
            return
          }

          console.log(`[TrailBase] Received event:`, JSON.stringify(event).slice(0, 200))
          begin()
          let value: TItem | undefined
          if (`Insert` in event) {
            value = parse(event.Insert as TRecord)
            console.log(`[TrailBase] Insert event for item with key: ${getKey(value)}`)
            write({ type: `insert`, value })
          } else if (`Delete` in event) {
            value = parse(event.Delete as TRecord)
            console.log(`[TrailBase] Delete event for item with key: ${getKey(value)}`)
            write({ type: `delete`, value })
          } else if (`Update` in event) {
            value = parse(event.Update as TRecord)
            console.log(`[TrailBase] Update event for item with key: ${getKey(value)}`)
            write({ type: `update`, value })
          } else {
            console.error(`Error: ${event.Error}`)
          }
          commit()

          if (value) {
            seenIds.setState((curr: Map<string, number>) => {
              const newIds = new Map(curr)
              newIds.set(String(getKey(value)), Date.now())
              return newIds
            })
          }
        }
      }

      async function start() {
        const eventStream = await config.recordApi.subscribe(`*`)
        const reader = eventStream.getReader()

        // Start listening for subscriptions first. Otherwise, we'd risk a gap
        // between the initial fetch and starting to listen.
        listen(reader)

        try {
          // Eager mode: perform initial fetch to populate everything
          if (internalSyncMode === `eager`) {
            await initialFetch()
            fullSyncCompleted = true
          }
        } catch (e) {
          currentAbortController?.abort()
          throw e
        }

        // For progressive mode with test hooks, use non-blocking pattern
        if (internalSyncMode === `progressive` && testHooks?.beforeMarkingReady) {
          // DON'T start full sync yet - let loadSubset handle data fetching
          // Wait for the hook to resolve, THEN do full sync and mark ready
          testHooks.beforeMarkingReady().then(async () => {
            try {
              // Now do the full sync
              await initialFetch()
              fullSyncCompleted = true
            } catch (e) {
              console.error(`TrailBase progressive full sync failed`, e)
            }
            markReady()
          })
        } else {
          // Mark ready immediately for eager/on-demand modes
          markReady()

          // If progressive without test hooks, start background sync
          if (internalSyncMode === `progressive`) {
            // Defer background sync to avoid racing with preload assertions
            setTimeout(() => {
              void (async () => {
                try {
                  await initialFetch()
                  fullSyncCompleted = true
                } catch (e) {
                  console.error(`TrailBase progressive full sync failed`, e)
                }
              })()
            }, 0)
          }
        }

        // Lastly, start a periodic cleanup task that will be removed when the
        // reader closes.
        const periodicCleanupTask = setInterval(() => {
          seenIds.setState((curr) => {
            const now = Date.now()
            let anyExpired = false

            const notExpired = Array.from(curr.entries()).filter(([_, v]) => {
              const expired = now - v > 300 * 1000
              anyExpired = anyExpired || expired
              return !expired
            })

            if (anyExpired) {
              return new Map(notExpired)
            }
            return curr
          })
        }, 120 * 1000)

        const onAbort = () => {
          clearInterval(periodicCleanupTask)
          // It's safe to call cancel and releaseLock even if the stream is already closed.
          reader.cancel().catch(() => {
            /* ignore */
          })
          try {
            reader.releaseLock()
          } catch {
            /* ignore */
          }
        }

        currentAbortController?.signal.addEventListener(`abort`, onAbort)
        reader.closed.finally(() => {
          currentAbortController?.signal.removeEventListener(`abort`, onAbort)
          clearInterval(periodicCleanupTask)
        })
      }

      start()

      // Eager mode doesn't need subset loading
      if (internalSyncMode === `eager`) {
        return
      }

      // Create the deduplication wrapper for loadSubset
      // This uses the @tanstack/db DeduplicatedLoadSubset pattern like Electric does
      const loadSubsetDedupe = createLoadSubsetDedupe({
        syncMode: internalSyncMode,
        isFullSyncComplete: () => fullSyncCompleted,
        begin,
        write,
        commit,
        parse,
        recordApi: config.recordApi,
        decodeIdForSorting,
      })

      return {
        loadSubset: loadSubsetDedupe.loadSubset,
        getSyncMetadata: () =>
          ({
            syncMode: internalSyncMode,
            fullSyncComplete: fullSyncCompleted,
          }) as const,
      }
    },
    // Expose the getSyncMetadata function
    getSyncMetadata: () =>
      ({
        syncMode: internalSyncMode,
        fullSyncComplete: fullSyncCompleted,
      }) as const,
  }

  return {
    ...config,
    syncMode: finalSyncMode,
    sync,
    getKey,
    onInsert: async (
      params: InsertMutationFnParams<TItem, TKey>,
    ): Promise<Array<number | string>> => {
      const ids = await config.recordApi.createBulk(
        params.transaction.mutations.map((tx) => {
          const { type, modified } = tx
          if (type !== `insert`) {
            throw new ExpectedInsertTypeError(type)
          }
          return serialIns(modified)
        }),
      )

      // The optimistic mutation overlay is removed on return, so at this point
      // we have to ensure that the new record was properly added to the local
      // DB by the subscription.
      await awaitIds(ids.map((id) => String(id)))

      return ids
    },
    onUpdate: async (params: UpdateMutationFnParams<TItem, TKey>) => {
      const ids: Array<string> = await Promise.all(
        params.transaction.mutations.map(async (tx) => {
          const { type, changes, key } = tx
          if (type !== `update`) {
            throw new ExpectedUpdateTypeError(type)
          }

          await config.recordApi.update(key, serialUpd(changes))

          return String(key)
        }),
      )

      // The optimistic mutation overlay is removed on return, so at this point
      // we have to ensure that the new record was properly updated in the local
      // DB by the subscription.
      await awaitIds(ids)
    },
    onDelete: async (params: DeleteMutationFnParams<TItem, TKey>) => {
      const ids: Array<string> = await Promise.all(
        params.transaction.mutations.map(async (tx) => {
          const { type, key } = tx
          if (type !== `delete`) {
            throw new ExpectedDeleteTypeError(type)
          }

          await config.recordApi.delete(key)
          return String(key)
        }),
      )

      // The optimistic mutation overlay is removed on return, so at this point
      // we have to ensure that the new record was properly updated in the local
      // DB by the subscription.
      await awaitIds(ids)
    },
    utils: {
      cancel: () => currentAbortController?.abort(),
    },
  }
}
