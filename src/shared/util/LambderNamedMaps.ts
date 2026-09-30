/**
 * One map of named declarations, or a list of them. An app made of parts,
 * each declaring its own guards, rate-limit policies or refusal codes beside
 * its APIs, hands the list over, and every name in it is declared. A name two
 * maps declare is refused rather than one quietly replacing the other.
 */
export type LambderNamedMapsOption<TMap> = TMap | readonly TMap[];

/** The one map a named-maps option declares: a list's members intersected, a lone map as it is. */
export type LambderMergedNamedMaps<T> =
    T extends readonly [] ? {}
    : T extends readonly [infer TFirst, ...infer TRest] ? TFirst & LambderMergedNamedMaps<TRest>
    : T extends readonly (infer TMember)[] ? TMember
    : T;

/** The names a list declares in more than one of its maps: never for a lone map, or for a list whose members are not known one by one. */
type LambderRepeatedNames<T, TSeen extends PropertyKey = never> =
    T extends readonly [infer TFirst, ...infer TRest]
        ? (keyof TFirst & TSeen) | LambderRepeatedNames<TRest, TSeen | keyof TFirst>
        : never;

/** Intersected onto a list: a name declared in two of its maps is a compile error, and the property name is the message. */
export type LambderNoRepeatedNames<T> = [LambderRepeatedNames<T>] extends [never]
    ? unknown
    : { readonly "lambder: a name is declared in more than one of these maps. Declare each name once.": LambderRepeatedNames<T> };

/**
 * A named-maps option as one map: a lone map as it is, a list merged in
 * order. A name declared in two maps of the list is refused; `what` names a
 * declaration and `where` the call that took the list, for that error.
 */
export const mergeNamedMaps = <TMap extends Record<string, unknown>>(
    option: LambderNamedMapsOption<TMap>,
    what: "guard" | "rate-limit policy" | "refusal code",
    where = "create()",
): TMap => {
    if(!Array.isArray(option)) return option as TMap;
    const merged: Record<string, unknown> = {};
    for(const map of option as readonly TMap[]){
        for(const [name, declaration] of Object.entries(map)){
            if(Object.prototype.hasOwnProperty.call(merged, name)){
                throw new Error(`Lambder: the ${what} "${name}" is declared in two of the maps given to ${where}. Declare each name once.`);
            }
            merged[name] = declaration;
        }
    }
    return merged as TMap;
};
