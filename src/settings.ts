import ono from '@jsdevtools/ono'
import * as Logger from '@nexus/logger'
import * as Lo from 'lodash'
import { Primitive } from 'type-fest'
import { inspect } from 'util'
import type { Options } from './manager'
import { Fixup, MapType, Shorthand, Validate } from './static'
import { IsRecord, Lookup, mergeShallow, PlainObject } from './utils'

const log = Logger.log.child('setset')

/**
 * Metadata
 */

type MetadataValueFromType = 'set' | 'initial'

/**
 * todo
 */
export type MetadataState<Data> = {
  type: 'namespace'
  fields: {
    [Key in keyof Data]: IsRecord<Data[Key]> extends true
      ? MetadataRecord<MetadataState<Lookup<Data[Key], string>>>
      : Data[Key] extends PlainObject
      ? MetadataNamespace<Data[Key]>
      : MetadataLeaf<Data[Key]>
  }
}

type MetadataLeaf<V = any> = {
  type: 'leaf'
  value: V
  initial: V
  from: MetadataValueFromType
}

type MetadataRecord<V = Metadata> = {
  type: 'record'
  from: MetadataValueFromType
  value: Record<string, V>
  initial: Record<string, V>
}

type MetadataNamespace<V = Metadata> = {
  type: 'namespace'
  fields: Record<string, V>
}

type Metadata<V = any> = MetadataLeaf<V> | MetadataRecord<V> | MetadataNamespace<V>

/**
 *
 */
function createMetadataLeaf(
  value: any,
  from: MetadataValueFromType = 'initial',
  flags?: { isShadow: true } | { isPassthrough: true }
): MetadataLeaf {
  return { type: 'leaf', from, value, initial: value, ...flags }
}

/**
 *
 */
function createMetadataRecord(value: Record<string, Metadata>): MetadataRecord {
  return { type: 'record', from: 'initial', value, initial: Lo.cloneDeep(value) }
}

/**
 *
 */
function createMetadataNamespace(fields: MetadataNamespace['fields'] = {}): MetadataNamespace {
  return { type: 'namespace', fields }
}

function metadataFromData(specifier: Specifier, data: any): Metadata {
  if (isNamespaceSpecifier(specifier)) return metadataNamespaceFromData(specifier, data)
  // todo record
  // if (isRecordSpecifier(specifier)) return ...
  return createMetadataLeaf(data)
}

function metadataNamespaceFromData(specifier: SpecifierNamespace, data: PlainObject) {
  return Lo.chain(data)
    .entries()
    .reduce((md, [k, v]) => {
      md.fields[k] = metadataFromData(specifier.fields[k], v)
      return md
    }, createMetadataNamespace())
    .value()
}

/**
 * resolvers
 */

/**
 *
 */
function resolveNamespace(
  options: Options,
  metadataFrom: MetadataValueFromType,
  specifier: SpecifierNamespace,
  input: PlainObject | Primitive,
  info: TraversalInfo,
  data: PlainObject,
  metadata: MetadataNamespace
) {
  const isValueObject = Lo.isPlainObject(input)

  if (!isValueObject && specifier.fields && !specifier.shorthand) {
    throw new Error(
      `Setting "${renderPath(
        info
      )}" is a namespace with no shorthand so expects an object but received a non-object: ${inspect(input)}`
    )
  }

  let longhandValue: PlainObject = input as any
  if (!isValueObject && specifier.shorthand) {
    log.debug('expanding shorthand', { info })
    try {
      longhandValue = specifier.shorthand(input as Primitive)
    } catch (e) {
      throw ono(
        e,
        { info, input },
        `There was an unexpected error while running the namespace shorthand for setting "${renderPath(
          info
        )}". The given value was ${inspect(input)}`
      )
    }
  }

  return resolve(options, metadataFrom, specifier, longhandValue, data, metadata, info)
}

function resolveRecord(
  options: Options,
  metadataFrom: MetadataValueFromType,
  specifier: SpecifierRecord,
  input: Record<string, PlainObject>, // todo don't assume record-namespace
  data: any,
  metadata: MetadataRecord<MetadataNamespace>, // todo don't assume record-namespace
  info: TraversalInfo
) {
  log.trace('resolve record', { specifier, input, data, metadata })
  const isValueObject = Lo.isPlainObject(input)

  if (!isValueObject) {
    // todo test
    throw new Error('received a non-object for record-type settings')
  }

  let newData = Lo.entries(input).reduce((rec, [entryName, entryValue]) => {
    log.trace('resolve record entry', { entryName, entryValue })

    if (!data[entryName]) {
      log.trace('this is a new record entry, initialize it', { entryName })
      const initial = initialize(specifier.entry, appendPath(info, entryName))
      data[entryName] = initial.data
      metadata.value[entryName] = initial.metadata as MetadataNamespace // todo don't assume record-namespace
    }

    rec[entryName] = resolve(
      options,
      metadataFrom,
      specifier.entry as MetadataNamespace, // todo don't assume record-namesapce
      entryValue,
      data[entryName],
      metadata.value[entryName],
      appendPath(info, entryName)
    )

    return rec
  }, {} as any)

  return newData
}

export type FixupInfo = {
  name: string
  before: unknown
  after: unknown
  messages: string[]
}

/**
 * Default onFixup handler.
 */
function onFixup(info: FixupInfo): void {
  log.warn(
    'One of your setting values was invalid. We were able to automaticlaly fix it up now but please update your code.',
    info
  )
}

function resolveLeaf(options: Options, specifier: SpecifierLeaf, input: any, info: TraversalInfo): any {
  let resolvedValue = input

  /**
   * Run fixups
   */
  if (specifier.fixup) {
    let maybeFixedup
    try {
      maybeFixedup = specifier.fixup(resolvedValue)
    } catch (e) {
      throw ono(
        e,
        { info, value: resolvedValue },
        `Fixup for "${renderPath(info)}" failed while running on value ${inspect(resolvedValue)}`
      )
    }
    if (maybeFixedup) {
      resolvedValue = maybeFixedup.value
      /**
       * fixup handler
       */
      const fixupInfo = {
        before: input,
        after: maybeFixedup.value,
        name: renderPath(info), // todo rename to "path"
        messages: maybeFixedup.messages,
      }
      if (options.onFixup) {
        try {
          options.onFixup(fixupInfo, onFixup)
        } catch (e) {
          throw ono(e, { info }, `onFixup callback for "${renderPath(info)}" failed`)
        }
      } else {
        onFixup(fixupInfo)
      }
    }
  }

  /**
   * Run validators
   */
  if (specifier.validate) {
    let maybeViolation
    try {
      maybeViolation = specifier.validate(resolvedValue)
    } catch (e) {
      // todo use verror or like
      throw ono(
        e,
        { info, value: resolvedValue },
        `Validation for "${renderPath(info)}" unexpectedly failed while running on value ${inspect(
          resolvedValue
        )}`
      )
    }
    if (maybeViolation) {
      throw new Error(
        `Your setting "${renderPath(info)}" failed validation with value ${inspect(
          resolvedValue
        )}:\n\n- ${maybeViolation.messages.join('\n- ')}`
      )
    }
  }

  /**
   * Run type mappers
   */
  resolvedValue = runTypeMapper(specifier, resolvedValue, info)

  return resolvedValue
}

/**
 * Process the given input through the settings spec, resolving its shorthands,
 * fixups, validation and so on until finally assigning it into the setting data.
 * The input is not mutated. The data is.
 */
export function resolve(
  options: Options,
  metadataFrom: MetadataValueFromType,
  parentSpecifier: SpecifierNamespace,
  input: PlainObject, // todo need version of plainobject that allows record fields
  data: any,
  metadata: MetadataNamespace,
  info: TraversalInfo
) {
  log.trace('resolve', { parentSpecifier, input, data, metadata })
  const newData: any = Lo.entries(input).reduce((newData, [inputFieldName, inputFieldValue]) => {
    // if no specifier found treat it as a leaf passthrough. This can be useful when wanting to
    // proxy a large number of settings from another system and don't want to have to write out
    // every single property in the tree.
    // Features will be lost by doing this, however
    const specifier = parentSpecifier.fields[inputFieldName] ?? {}
    // const isValueObject = Lo.isPlainObject(inputFieldValue)

    // todo bring this back under strict mode
    // if (!specifier) {
    //   throw new Error(
    //     `You are trying to change a setting called "${inputFieldName}" but no such setting exists`
    //   )
    // }

    // todo bring this back under strict mode
    //      it is disabled b/c optional input+data allows omitting field specifiers altogether
    // if (isValueObject && !isNamespaceSpecifier(specifier) && !isRecordSpecifier(specifier)) {
    //   throw new Error(
    //     `Setting "${inputFieldName}" is not a namespace or record and so does not accept objects, but one given: ${inspect(
    //       inputFieldValue
    //     )}`
    //   )
    // }

    if (isNamespaceSpecifier(specifier)) {
      newData[inputFieldName] = resolveNamespace(
        options,
        metadataFrom,
        specifier,
        inputFieldValue as PlainObject,
        appendPath(info, inputFieldName),
        data[inputFieldName],
        metadata.fields[inputFieldName] as MetadataNamespace
      )
      return newData
    }

    if (isRecordSpecifier(specifier)) {
      newData[inputFieldName] = resolveRecord(
        options,
        metadataFrom,
        specifier,
        inputFieldValue as Record<string, PlainObject>, // todo don't assume namespace-record
        data[inputFieldName],
        metadata.fields[inputFieldName] as MetadataRecord<MetadataNamespace>, // todo don't assume namespace-record
        appendPath(info, inputFieldName)
      )
      return newData
    }

    if (isLeafSpecifier(specifier)) {
      newData[inputFieldName] = resolveLeaf(
        options,
        specifier,
        inputFieldValue,
        appendPath(info, inputFieldName)
      )
      return newData
    }

    throw new Error(`Unknown kind of specifier: ${inspect(specifier)}`)
  }, {} as any)

  return newData
}

/**
 * commit
 */

/**
 *
 */
export function commit(
  specifier: SpecifierNamespace,
  metadataFrom: MetadataValueFromType,
  input: any,
  data: any,
  metadata: MetadataNamespace
) {
  log.trace('committing change', { specifier, metadataFrom, input, data, metadata })
  Lo.forOwn(input, (fieldInput, fieldName) => {
    metadata.fields[fieldName] =
      metadata.fields[fieldName] ?? createMetadataLeaf(undefined, metadataFrom, { isPassthrough: true })
    doCommit(
      specifier.fields[fieldName],
      metadataFrom,
      fieldName,
      fieldInput,
      data,
      metadata.fields[fieldName]
    )
  })
  log.trace('done comitting change', { specifier, metadataFrom, input, data, metadata })
  return data
}

/**
 *
 */
function doCommit(
  specifier: Specifier,
  metadataFrom: MetadataValueFromType,
  key: string,
  input: any,
  parentData: any,
  metadata: Metadata
) {
  if (isNamespaceSpecifier(specifier)) {
    log.trace('committing namespace', { specifier, key, input, parentData, metadata })
    const metadataNamespace = metadata as MetadataNamespace
    const dataNamespace = parentData[key]
    Lo.forOwn(input, (v, k) => {
      metadataNamespace.fields[k] =
        metadataNamespace.fields[k] ?? createMetadataLeaf(undefined, metadataFrom, { isPassthrough: true })
      doCommit(specifier.fields[k], metadataFrom, k, v, dataNamespace, metadataNamespace.fields[k])
    })
    log.trace('done committing namespace', { specifier, key, input, parentData, metadata })
    return
  }

  if (isRecordSpecifier(specifier)) {
    const metadataRecord = metadata as MetadataRecord
    doCommitRecord(specifier, metadataFrom, input, parentData[key], metadataRecord)
    return
  }

  const metadataLeaf = metadata as MetadataLeaf

  log.trace('committing leaf', { key, input, parentData, metadataLeaf })
  parentData[key] = input
  metadataLeaf.value = input
  metadataLeaf.from = metadataFrom
  if (metadataFrom === 'initial') {
    metadataLeaf.initial = input
  }
}

/**
 *
 */
function doCommitRecord(
  specifier: SpecifierRecord,
  metadataFrom: MetadataValueFromType,
  input: any,
  data: any,
  metadata: MetadataRecord
) {
  log.trace('committing record', { specifier, input, data, metadata })
  Lo.forOwn(input, (entryInput, entryKey) => {
    // todo assumes record-namespace
    // nothing indicating that these are namespaces, implied, would recurse into leaf otherwise
    data[entryKey] = data[entryKey] ?? {}

    if (specifier.mapEntryData) {
      runEntryDataMapper(
        specifier,
        metadataFrom,
        entryInput,
        entryKey,
        metadata.value[entryKey] as MetadataNamespace
      )
    }

    doCommit(
      specifier.entry, // todo don't assume record-namespace
      metadataFrom,
      entryKey,
      entryInput,
      data,
      metadata.value[entryKey]
    )

    if (metadataFrom === 'initial') {
      metadata.initial = metadata.value
    }
  })
  log.trace('done committing record', { specifier, input, data, metadata })
}
/**
 * specifiers
 */

export type Specifier = SpecifierLeaf | SpecifierRecord | SpecifierNamespace

/**
 *
 */
export function isLeafSpecifier(specifier: any): specifier is SpecifierLeaf {
  return !isNamespaceSpecifier(specifier) && !isRecordSpecifier(specifier)
}

export type SpecifierLeaf = {
  mapType?: MapType
  fixup?: Fixup
  validate?: Validate
}

/**
 *
 */
export function isRecordSpecifier(specifier: any): specifier is SpecifierRecord {
  return Boolean(specifier?.entry)
}

export type SpecifierRecord<Entry = any> = {
  entry: unknown extends Entry ? Specifier : Entry
  mapEntryData?(newEntryData: any, entryKey: string): any
}

/**
 *
 */
export function isNamespaceSpecifier(specifier: any): specifier is SpecifierNamespace {
  return Boolean(specifier?.fields)
}

export type SpecifierNamespace = {
  fields: any
  initial?(): any
  shorthand?: Shorthand
}

/**
 * initializers
 */

type InitializeResult = { data: PlainObject; metadata: Metadata }

/**
 *
 */
export function initialize(specifier: Specifier, info: TraversalInfo): InitializeResult {
  if (isNamespaceSpecifier(specifier)) return initializeNamespace(specifier, info)
  if (isRecordSpecifier(specifier)) return initializeRecord(specifier, info)
  if (isLeafSpecifier(specifier)) return initializeLeaf(specifier, info)
  throw new Error('unknown kind of specifier')
}

/**
 *
 */
function initializeLeaf(specifier: SpecifierLeaf, info: TraversalInfo) {
  log.trace('initialize leaf', { info })
  let value = runInitializer(specifier, info)
  value = runTypeMapper(specifier, value, info)
  return { data: value, metadata: createMetadataLeaf(value) }
}

/**
 *
 */
function initializeNamespace(specifier: SpecifierNamespace, info: TraversalInfo) {
  log.trace('will initialize namespace', { info, specifier })
  let initializedNamespaceData
  if (specifier.initial) {
    log.trace('will run namespace initializer')
    initializedNamespaceData = specifier.initial()
    log.trace('did run namespace initializer', { initializedNamespaceData })
  } else {
    initializedNamespaceData = {}
  }
  const initializedNamespaceMetadata = metadataNamespaceFromData(specifier, initializedNamespaceData)
  const initializedNamespace = {
    data: initializedNamespaceData,
    metadata: initializedNamespaceMetadata,
  }
  const initializedFieldsResult = Lo.chain(specifier.fields)
    .entries()
    .reduce(
      (acc, [key, specifier]) => {
        const initFieldRes = initialize(specifier, appendPath(info, key))
        acc.data[key] = initFieldRes.data
        acc.metadata.fields[key] = initFieldRes.metadata
        return acc
      },
      { metadata: createMetadataNamespace(), data: {} } as any
    )
    .value()
  const result = {
    data: mergeShallow(initializedNamespace.data, initializedFieldsResult.data),
    metadata: Lo.merge(initializedNamespace.metadata, initializedFieldsResult.metadata),
  }
  log.trace('did initialize namespace', { info, specifier, result })
  return result
}

/**
 * todo don't assume namespace-records
 */
function initializeRecord(specifier: SpecifierRecord<SpecifierNamespace>, info: TraversalInfo) {
  log.trace('initialize record', { info, specifier })
  // there may be preloaded record entries via the record initializer
  // such entries will be input and thus need to be resolved
  // such entries may also not account for all possible fields of the entry
  // thus we need to run the initializer and seed each entry with that
  // then treat the actual initialzer input as a "change" on that, resolving it

  // get the starter entries (if any)
  const starterEntriesData = runInitializer(specifier, info) ?? {}

  // if no starter entries then no work for us to do, exit early
  if (Lo.isEmpty(starterEntriesData)) {
    // todo don't assume record-namespace, pass inner metadata based on specifier type
    const result = { data: {}, metadata: createMetadataRecord({}) }
    log.trace('did initialize record', { specifier, ...result })
    return result
  }

  // get what an initialized entry looks like
  // todo don't assume record-namespace
  let canonicalEntryResult = Lo.chain(specifier.entry.fields)
    .entries()
    .reduce(
      (acc, [entK, entV]) => {
        const init = initialize(entV, appendPath(info, ['*', entK]))
        acc.data[entK] = init.data
        acc.metadataRecordValue[entK] = init.metadata
        return acc
      },
      { data: {}, metadataRecordValue: {} } as any
    )
    .value()

  // now stitch the initial record data with the cannonical initialized entry
  let result = Lo.chain(starterEntriesData)
    .keys()
    .reduce(
      (acc, recK) => {
        // if the given initial record data has a value use it, otherwise fall back to the cannonical initialized entry
        acc.data[recK] = acc.data[recK] ?? {}
        acc.metadataRecordValue[recK] = acc.metadataRecordValue[recK] ?? createMetadataNamespace()
        Lo.forOwn(canonicalEntryResult.data, (entV, entK) => {
          acc.data[recK][entK] = starterEntriesData[recK][entK] ?? entV
          // todo we don't know what kind of metadata that the entry field is, and so we cannot update cannonical with given
          // todo we will need to determin the metadata kind based on the specifier
          acc.metadataRecordValue[recK].fields[entK] = canonicalEntryResult.metadataRecordValue[entK] // 'a' // initialGivenRecordData[recK][entK] ?? entV
          if (starterEntriesData[recK][entK]) {
            if (canonicalEntryResult.metadataRecordValue[entK].type === 'leaf') {
              acc.metadataRecordValue[recK].fields[entK] = createMetadataLeaf(starterEntriesData[recK][entK])
            }
            // todo if given data present and not leaf (record, namespace) then we need to convert the data into metadata
            // todo only then can we assign into metadata
          }
        })
        return acc
      },
      { data: {}, metadataRecordValue: {} } as any
    )
    .value()

  // stitch together the initialized entry to built up a metadata representation
  result = {
    data: result.data,
    metadata: createMetadataRecord(result.metadataRecordValue),
  }

  if (specifier.mapEntryData) {
    log.trace('running entry data mapper')
    // todo runner wrapper, error handling etc.
    Lo.forOwn(result.data, (newEntryData, entryKey) => {
      runEntryDataMapper(specifier, 'initial', newEntryData, entryKey, result.metadata.value[entryKey])
      doCommitRecord(specifier, 'initial', { [entryKey]: newEntryData }, result.data, result.metadata)
    })
  }

  log.trace('did initialize record', { result })
  return result
}

/**
 * runners
 */

/**
 *
 */
function runEntryDataMapper(
  specifier: SpecifierRecord,
  metadataFrom: MetadataValueFromType,
  entryInput: any,
  entryKey: string,
  entryMetdata: MetadataNamespace
) {
  // todo runner wrapper, error handling etc.
  log.trace('running entry data mapper')
  const entryInputWithAddedData = specifier.mapEntryData!(entryInput, entryKey)
  // augment the specifer, input, & metadata
  // the shadow data doesn't show up in any of these places like normal input
  // to keep the recurisve system going, synthetically construct the needed things
  Lo.forOwn(entryInputWithAddedData, (v, k) => {
    if (entryInput[k] === undefined) {
      entryInput[k] = v
      entryMetdata.fields[k] = createMetadataLeaf(undefined, metadataFrom, {
        isShadow: true,
      })
      ;(specifier.entry as SpecifierNamespace).fields[k] = { isShadow: true }
    }
  })
}

/**
 *
 */
function runTypeMapper(specifier: any, inputFieldValue: any, info: TraversalInfo): any {
  if (!specifier.mapType) return inputFieldValue

  log.trace('running type mapper', { info, inputFieldValue })
  try {
    return specifier.mapType(inputFieldValue)
  } catch (e) {
    throw ono(
      e,
      { info },
      `There was an unexpected error while running the type mapper for setting "${renderPath(info)}"`
    )
  }
}

/**
 *
 */
function runInitializer(specifier: any, info: TraversalInfo): any {
  if (specifier.initial === undefined) {
    log.trace('no initializer to run', { info })
    return
  }

  if (typeof specifier.initial === 'function') {
    log.trace('running initializer', { info })
    try {
      return specifier.initial()
    } catch (e) {
      throw ono(
        e,
        { info },
        `There was an unexpected error while running the initializer for setting "${renderPath(info)}"`
      )
    }
  }

  throw new Error(
    `Initializer for setting "${renderPath(
      info
    )}" was configured with a static value. It must be a function. Got: ${inspect(specifier.initial)}`
  )
}

/**
 * utils
 */

export function renderPath(info: TraversalInfo): string {
  return info.path.slice(1).join('.')
}

export function appendPath(info: TraversalInfo, newPart: string | string[]): TraversalInfo {
  newPart = Array.isArray(newPart) ? newPart : [newPart]

  return {
    ...info,
    path: [...info.path, ...newPart],
  }
}

export function createInfo(): TraversalInfo {
  return { path: ['__root__'] }
}

/**
 *
 */
export function dataFromMetadata<Data>(metadata: MetadataNamespace, copy: PlainObject): Data {
  Lo.forOwn(metadata.fields, (fieldMetadata, name) => {
    if ('fields' in fieldMetadata) {
      copy[name] = dataFromMetadata(fieldMetadata, {})
    } else {
      copy[name] = fieldMetadata.initial
    }
  })

  return copy as any
}

export type TraversalInfo = {
  path: string[]
}
