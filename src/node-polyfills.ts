// Node.js polyfills for browser compatibility
// This file provides optional Node.js modules that fail gracefully in browser environments

let fs: typeof import('fs') | null = null;
let path: typeof import('path') | null = null;
let zlib: typeof import('zlib') | null = null;
let crypto: typeof import('crypto') | null = null;

export async function getFS(): Promise<typeof import('fs') | null> {
    try {
        if(fs){ return fs; }
        fs = await import('fs');
        return fs;
    } catch (e) {
        // Silently fail - we're in a browser environment
        return null;
    }
}

export async function getPath(): Promise<typeof import('path') | null> {
    try {
        if(path){ return path; }
        path = await import('path');
        return path;
    } catch (e) {
        // Silently fail - we're in a browser environment
        return null;
    }
}

export async function getZlib(): Promise<typeof import('zlib') | null> {
    try {
        if(zlib){ return zlib; }
        zlib = await import('zlib');
        return zlib;
    } catch (e) {
        // Silently fail - we're in a browser environment
        return null;
    }
}

export async function getCrypto(): Promise<typeof import('crypto') | null> {
    try {
        if(crypto){ return crypto; }
        crypto = await import('crypto');
        return crypto;
    } catch (e) {
        // Silently fail - we're in a browser environment
        return null;
    }
}
