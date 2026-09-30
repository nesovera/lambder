/**
 * A named-maps option as one map: a lone map as it is, a list merged in
 * order. A name declared in two maps of the list is refused; `what` names a
 * declaration and `where` the call that took the list, for that error.
 */
export const mergeNamedMaps = (option, what, where = "create()") => {
    if (!Array.isArray(option))
        return option;
    const merged = {};
    for (const map of option) {
        for (const [name, declaration] of Object.entries(map)) {
            if (Object.prototype.hasOwnProperty.call(merged, name)) {
                throw new Error(`Lambder: the ${what} "${name}" is declared in two of the maps given to ${where}. Declare each name once.`);
            }
            merged[name] = declaration;
        }
    }
    return merged;
};
