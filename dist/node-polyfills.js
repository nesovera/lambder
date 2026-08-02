// Node.js polyfills for browser compatibility
// This file provides optional Node.js modules that fail gracefully in browser environments
let fs = null;
let path = null;
let zlib = null;
let crypto = null;
export async function getFS() {
    try {
        if (fs) {
            return fs;
        }
        fs = await import('fs');
        return fs;
    }
    catch (e) {
        // Silently fail - we're in a browser environment
        return null;
    }
}
export async function getPath() {
    try {
        if (path) {
            return path;
        }
        path = await import('path');
        return path;
    }
    catch (e) {
        // Silently fail - we're in a browser environment
        return null;
    }
}
export async function getZlib() {
    try {
        if (zlib) {
            return zlib;
        }
        zlib = await import('zlib');
        return zlib;
    }
    catch (e) {
        // Silently fail - we're in a browser environment
        return null;
    }
}
export async function getCrypto() {
    try {
        if (crypto) {
            return crypto;
        }
        crypto = await import('crypto');
        return crypto;
    }
    catch (e) {
        // Silently fail - we're in a browser environment
        return null;
    }
}
