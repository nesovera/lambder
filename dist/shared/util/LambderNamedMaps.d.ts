import type { LambderRepeatedMembers } from "./LambderTypeUtilities.js";
/**
 * One map of named declarations, or a list of them. An app made of parts,
 * each declaring its own guards, rate-limit policies or refusal codes beside
 * its APIs, hands the list over, and every name in it is declared. A name two
 * maps declare is refused rather than one quietly replacing the other.
 */
export type LambderNamedMapsOption<TMap> = TMap | readonly TMap[];
/** The one map a named-maps option declares: a list's members intersected, a lone map as it is. */
export type LambderMergedNamedMaps<T> = T extends readonly [] ? {} : T extends readonly unknown[] ? LambderIntersectedMaps<T> : T;
/**
 * A list's maps intersected in order, a member of unknown count (an array
 * type, or a tuple's rest) taken as its element type. Carries what it has
 * merged so far, so the compiler runs it as a loop, for the reason
 * LambderRepeatedMembers gives.
 */
type LambderIntersectedMaps<T extends readonly unknown[], TMerged = unknown> = T extends readonly [infer TFirst, ...infer TRest] ? LambderIntersectedMaps<TRest, TMerged & TFirst> : T extends readonly [] ? TMerged : TMerged & T[number];
/** Intersected onto a list: a name declared in two of its maps is a compile error, and the property name is the message. */
export type LambderNoRepeatedNames<T extends readonly unknown[]> = LambderRepeatedMembers<{
    [TIndex in keyof T]: keyof T[TIndex];
}> extends infer TRepeated ? ([TRepeated] extends [never] ? unknown : {
    readonly "lambder: a name is declared in more than one of these maps. Declare each name once.": TRepeated;
}) : never;
/**
 * A named-maps option as one map: a lone map as it is, a list merged in
 * order. A name declared in two maps of the list is refused; `what` names a
 * declaration and `where` the call that took the list, for that error.
 */
export declare const mergeNamedMaps: <TMap extends Record<string, unknown>>(option: LambderNamedMapsOption<TMap>, what: "guard" | "rate-limit policy" | "refusal code", where?: string) => TMap;
export {};
