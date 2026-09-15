/**
 * The session cookie names an app uses unless it configures its own. One
 * definition, in shared, because the server writes these names and the
 * browser caller, the invoke caller and the mock runtime all read them: the
 * two sides must agree byte for byte, and a second copy is a place for them
 * to drift apart with every test still green.
 */
export declare const DEFAULT_SESSION_TOKEN_COOKIE_KEY = "LMDRSESSIONTKID";
export declare const DEFAULT_SESSION_CSRF_COOKIE_KEY = "LMDRSESSIONCSTK";
