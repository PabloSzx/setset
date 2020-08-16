import * as S from '..'

type R<T> = Record<string, T>

/**
 * leaf
 */

// if data optional THEN field spec not required
S.create<{ a?: number}, { a?: number }>({ fields: {}})
// ... but permitted
S.create<{ a?: number}, { a?: number }>({ fields: { a: {} }})


/**
 * leaf initializer
 */

// if input optional THEN initializer required AND must return the same type as the input field (sans void)
S.create<{ a?: boolean }, { a: number }>({ fields: { a: { initial: () => true,  mapType: (a) => 1 } } })
// @ts-expect-error
S.create<{ a?: boolean }>({ fields: { a: { mapType: (a) => 1 } } })
// @ts-expect-error
S.create<{ a?: boolean }, { a: number }>({ fields: { a: { initial: () => 1, mapType: (a) => 1 } } })

// if input required THEN initializer forbidden
S.create<{ a: number }>({ fields: { a: {} } })
// @ts-expect-error
S.create<{ a: number }>({ fields: { a: { initial: () => 'adfdsf' } } })

// if data is optional then initializer optional AND may return undefined
S.create<{ a?: number }, { a?:number }>({ fields: { a: {} } })
// ...but it is still allowed if desired
S.create<{ a?: number }, { a?:number }>({ fields: { a: { initial: () => 1 } } })
// ...and if given may also return undefined
S.create<{ a?: number }, { a?:number }>({ fields: { a: { initial: () => undefined } } })

// if input optional AND no matching data THEN initializer required
S.create<{ a?:number }, { b:number }>({ fields: { a: { initial: () => 1, mapData: () => ({b:1}) } } })
// @ts-expect-error
S.create<{ a?:number }, { b:number }>({ fields: { a: { mapData: () => ({b:1}) } } })

/**
 * mapType
 */

// if input/data types differ then mapType requried
S.create<{ a: boolean }, { a: number }>({ fields: { a: { mapType: (a) => 1 } } })
// @ts-expect-error
S.create<{ a: boolean }, { a: number }>({ fields: { a: {} } })

// if input/data types same then mapType forbidden
S.create<{ a: number }>({ fields: { a: {} } })
// @ts-expect-error
S.create<{ a: number }>({ fields: { a: { mapType: (a) => 1 } } })

/**
 * validate & fixup
 */

// validate gets non-optional input  
S.create<{ a?: number }>({ fields: { a: { initial: () => 1, validate: (a) => { const b: number = a ; return null } } } })
// fixup gets non-optional input  
S.create<{ a?: number }>({ fields: { a: { initial: () => 1, fixup: (a) => { const b: number = a; return null} } } })

/**
 * mapData
 */

// if input field key not present in data field keys then mapData required
S.create<{ a: number }, { b: number }>({ fields: { a: { mapData: (a) => ({ b: a }) } } })
// @ts-expect-error
S.create<{ a: numebr }, { b: number }>({ fields: { a: {} } })

// if input field key is present in data field keys then mapData forbidden
S.create<{ a: number }, { a: number }>({ fields: { a: {} } })
// @ts-expect-error
S.create<{ a: number }, { a: number }>({ fields: { a: { mapData: (a) => ({ b: a }) } } })
