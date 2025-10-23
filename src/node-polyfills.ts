// Node.js polyfills for browser compatibility
// This file provides optional Node.js modules that fail gracefully in browser environments

let fs: any = null;
let path: any = null;

export async function getFS(): Promise<any> {
    try {
        if(fs){ return fs; }
        fs = await import('fs');
        return fs;
    } catch (e) {
        // Silently fail - we're in a browser environment
        return null;
    }
}

export async function getPath(): Promise<any> {
    try {
        if(path){ return path; }
        path = await import('path');
        return path;
    } catch (e) {
        // Silently fail - we're in a browser environment
        return null;
    }
}
