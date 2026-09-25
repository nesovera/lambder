/**
 * Sessions end to end: signing in, reading a session, replacing every
 * session after a password change, updating its data, signing out of one
 * device or all of them, and the two shapes a server-rendered page needs (an
 * optional session, and a form that posts back).
 *
 * The cookie names carry the `__Host-` prefix, which is what a browser
 * enforces on the app's behalf: it refuses such a cookie if it carries a
 * Domain or a Path other than "/", so no sibling subdomain can plant one.
 * That is the difference between cleaning up after a planted session cookie
 * and ruling one out; see docs/sessions.md.
 */

import { z } from "zod";
import { initLambder, LambderDdbSessionStore, lambderGuard, html } from "../src/index.js";

type SessionData = {
    userId: string;
    username: string;
    role: "admin" | "user";
    preferences?: { theme: string; language: string };
};

// The prefixed names, written once: the session option configures them and
// the dashboard route reads the CSRF cookie back by the same name.
const SESSION_COOKIE_NAME = "__Host-LMDRSESSIONTKID";
const CSRF_COOKIE_NAME = "__Host-LMDRSESSIONCSTK";

// The creation call is its own statement, which is how an app splits its
// app.ts from its api modules: this value is the one they import the type of.
const lambderApp = initLambder<SessionData>().create({
    apiPath: "/api",
    // Sessions over DynamoDB, with sliding expiration
    session: {
        store: new LambderDdbSessionStore({
            tableName: process.env.SESSION_TABLE || "sessions",
            region: process.env.AWS_REGION || "us-east-1",
        }),
        sessionSalt: process.env.SESSION_SALT || "change-this-to-a-secure-random-string",
        enableSlidingExpiration: true, // Sessions extend on each access
        tokenCookieKey: SESSION_COOKIE_NAME,
        csrfCookieKey: CSRF_COOKIE_NAME,
        // A __Host- cookie may carry no Domain, so sharing the session across
        // subdomains means dropping the prefix, and with it the defence:
        // every host under the domain then both writes AND receives the
        // session cookie. Only for a domain whose every subdomain is yours.
        // cookie: { domain: ".example.com" },
    },
    // Every API here states who may call it. Neither flag is on by default,
    // because a no-op guard satisfies both and a framework should not demand
    // a declaration before the first endpoint works. An app is the right
    // place to demand one: past a handful of endpoints, "which of these are
    // open, and why?" stops being answerable by reading them.
    guards: {
        // The session itself is the whole authorization: the signed-in user
        // acting on their own account.
        sessionOnly: lambderGuard({ session: true, handler: () => {} }),
        // Anyone may call, and the reason is recorded at the call site, so
        // `grep "open:"` lists every public door in the app with its reason.
        open: lambderGuard({ handler: (_ctx, _params, _reason: string) => {} }),
    },
    requireSessionApiGuards: true,
    requirePublicApiGuards: true,
});

const lambder = lambderApp
// Example: Login API with session regeneration
.addApi("user.login", {
    input: z.object({ username: z.string(), password: z.string() }),
    output: z.object({ success: z.boolean(), csrfToken: z.string().optional(), error: z.string().optional() }),
    guards: { open: "signing in is how a visitor gets a session; the password check here IS the control" },
}, async (ctx, resolver) => {
    const { username, password } = ctx.apiPayload;

    // Validate credentials (implement your own logic)
    const user = await authenticateUser(username, password);
    if (!user) {
        return resolver.api({ success: false, error: "Invalid credentials" });
    }

    // Create new session. issueSession is createSession plus the raw tokens:
    // the cookies are set either way, and the CSRF token is handed back so a
    // client that keeps it in memory rather than reading document.cookie can.
    const { sessionController } = ctx;
    const created = await sessionController.issueSession(user.id, {
        userId: user.id,
        username: user.username,
        role: user.role,
    });

    return resolver.api({
        success: true,
        csrfToken: created.csrfToken,
    });
})
// Example: Protected API that requires session
.addSessionApi("user.profile", {
    input: z.void(),
    output: z.object({ userId: z.string(), username: z.string(), role: z.string() }),
    guards: "sessionOnly",
}, async (ctx, resolver) => {
    // Session is automatically fetched and validated
    const sessionData = ctx.session.data;

    return resolver.api({
        userId: sessionData.userId,
        username: sessionData.username,
        role: sessionData.role,
    });
})
// Example: Sensitive operation that replaces every session of the user
.addSessionApi("user.changePassword", {
    input: z.object({ oldPassword: z.string(), newPassword: z.string() }),
    output: z.object({ success: z.boolean(), message: z.string().optional(), csrfToken: z.string().optional(), error: z.string().optional() }),
    guards: "sessionOnly",
}, async (ctx, resolver) => {
    const { oldPassword, newPassword } = ctx.apiPayload;
    const { sessionController } = ctx;
    const { userId, username, role } = ctx.session.data;

    // Validate old password
    const isValid = await validatePassword(userId, oldPassword);
    if (!isValid) {
        return resolver.api({ success: false, error: "Invalid password" });
    }

    // Update password
    await updatePassword(userId, newPassword);

    // Every session of this user goes, including this one: a password change
    // is meant to end whatever a stolen token could still do. endSessionAll
    // deletes every record under the subject, so the replacement has to be
    // created AFTER it rather than before, or it would be deleted too and
    // this answer would hand back the CSRF token of a session that no longer
    // exists. The clearing Set-Cookie headers are emitted before the new
    // pair, so the browser ends up holding the new session.
    await sessionController.endSessionAll();
    const renewed = await sessionController.issueSession(userId, { userId, username, role });

    return resolver.api({
        success: true,
        message: "Password changed successfully",
        csrfToken: renewed.csrfToken, // Send new CSRF token
    });
})
// Example: Update session data
.addSessionApi("user.updatePreferences", {
    input: z.object({ theme: z.string(), language: z.string() }),
    output: z.object({ success: z.boolean(), message: z.string() }),
    guards: "sessionOnly",
}, async (ctx, resolver) => {
    const { theme, language } = ctx.apiPayload;
    const { sessionController } = ctx;

    // Update session data. The expiry is left alone: sliding expiration
    // moves it on a session read, which also re-issues the cookies.
    await sessionController.updateSessionData({
        ...ctx.session.data,
        preferences: { theme, language },
    });

    return resolver.api({
        success: true,
        message: "Preferences updated",
    });
})
// Example: Logout
.addSessionApi("user.logout", {
    input: z.void(),
    output: z.object({ success: z.boolean(), message: z.string() }),
    guards: "sessionOnly",
}, async (ctx, resolver) => {
    const { sessionController } = ctx;

    // End current session
    await sessionController.endSession();

    return resolver.api({
        success: true,
        message: "Logged out successfully",
    });
})
// Example: Logout from all devices
.addSessionApi("user.logoutAll", {
    input: z.void(),
    output: z.object({ success: z.boolean(), message: z.string() }),
    guards: "sessionOnly",
}, async (ctx, resolver) => {
    const { sessionController } = ctx;

    // End all sessions for this user (same sessionKey)
    await sessionController.endSessionAll();

    return resolver.api({
        success: true,
        message: "Logged out from all devices",
    });
})
// Example: Optional session (check if logged in)
.addApi("user.checkAuth", {
    input: z.object({}),
    output: z.object({
        authenticated: z.boolean(),
        userId: z.string().optional(),
        username: z.string().optional(),
    }),
    guards: { open: "reports whether the caller's own cookie names a live session, and nothing else" },
}, async (ctx, resolver) => {
    const { sessionController } = ctx;

    // Try to fetch session without throwing error
    const session = await sessionController.fetchSessionIfExists();

    if (session) {
        return resolver.api({
            authenticated: true,
            userId: session.data.userId,
            username: session.data.username,
        });
    } else {
        return resolver.api({
            authenticated: false,
        });
    }
})
// Example: Route with session, rendering a form that posts back
.addSessionRoute("/dashboard", async (ctx, resolver) => {
    // Session is automatically fetched and validated
    const userData = ctx.session.data;

    // Type-safe templating: interpolations are auto-escaped.
    // The session record stores only the CSRF token's hash, so a
    // server-rendered form reads the raw token from the cookie the browser
    // sent it in. That cookie is deliberately not HttpOnly, for exactly this.
    const csrfToken = ctx.cookie[CSRF_COOKIE_NAME] ?? "";
    return resolver.html(html`
        <h1>Welcome, ${userData.username}</h1>
        <form method="post" action="/dashboard/display-name">
            <input type="hidden" name="csrf" value="${csrfToken}" />
            <input name="displayName" value="${userData.username}" />
            <button type="submit">Save</button>
        </form>
    `);
})
// Example: the POST the form above makes, and the check it needs
.addSessionRoute("/dashboard/display-name", async (ctx, resolver) => {
    // A session ROUTE gets no CSRF check from the framework: the controller
    // is handed csrfToken: null for anything that is not an API call, so this
    // handler runs on the session cookie alone. SameSite=Lax is then the only
    // thing in front of it, and sameSite: "None" would remove that too, so a
    // route that changes state asks for itself. isSessionCsrfTokenValid is
    // the same check an API call gets: the posted value against the hash on
    // the record, not against the cookie beside it.
    const posted = typeof ctx.post.csrf === "string" ? ctx.post.csrf : null;
    if (!await lambderApp.getSessionManager().isSessionCsrfTokenValid(ctx.session, posted)) {
        return resolver.status(403, "This form is stale. Reload the page and try again.");
    }

    const displayName = typeof ctx.post.displayName === "string" ? ctx.post.displayName : ctx.session.data.username;
    await ctx.sessionController.updateSessionData({ ...ctx.session.data, username: displayName });

    return resolver.redirect("/dashboard");
})
// Example: Route with optional session
.addRoute("/", async (ctx, resolver) => {
    const { sessionController } = ctx;
    const session = await sessionController.fetchSessionIfExists();

    return resolver.html(html`
        <h1>Home</h1>
        ${session
            ? html`<p>Logged in as ${session.data.username}</p>`
            : html`<p><a href="/login">Log in</a></p>`}
    `);
});

// Dummy functions (implement these)
async function authenticateUser(username: string, password: string) {
    // Implement your authentication logic
    return { id: "user123", username, role: "user" as const };
}

async function validatePassword(userId: string, password: string) {
    // Implement password validation
    return true;
}

async function updatePassword(userId: string, newPassword: string) {
    // Implement password update
}

export const handler = lambder.getHandler();
