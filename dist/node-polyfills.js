// Node.js polyfills for browser compatibility
// This file provides optional Node.js modules that fail gracefully in browser environments
let fs = null;
let path = null;
// Try to import Node.js modules if available
try {
    // @ts-ignore - conditional import
    if (typeof process !== 'undefined' && process.versions?.node) {
        // Use eval to prevent bundlers from trying to resolve these at build time
        const requireFunc = eval('typeof require !== "undefined" ? require : null');
        if (requireFunc) {
            fs = requireFunc('fs');
            path = requireFunc('path');
        }
    }
}
catch (e) {
    // Silently fail - we're in a browser environment
}
export function getFS() {
    return fs;
}
export function getPath() {
    return path;
}
