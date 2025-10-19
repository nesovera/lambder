import Lambder from "../src/Lambder.js";

// Example: Secure session handling with all security fixes applied

const lambder = new Lambder({
    publicPath: "/public",
    apiPath: "/api",
    ejsPath: "/views",
});

// Enable session management with sliding expiration
lambder.enableDdbSession(
    {
        tableName: process.env.SESSION_TABLE || "sessions",
        tableRegion: process.env.AWS_REGION || "us-east-1",
        sessionSalt: process.env.SESSION_SALT || "change-this-to-a-secure-random-string",
        enableSlidingExpiration: true, // Sessions extend on each access
    },
    { partitionKey: "pk", sortKey: "sk" }
);

// Example: Login API with session regeneration
lambder.addApi("user.login", async (ctx, resolver) => {
    const { username, password } = ctx.apiPayload;

    // Validate credentials (implement your own logic)
    const user = await authenticateUser(username, password);
    if (!user) {
        return resolver.api({ success: false, error: "Invalid credentials" });
    }

    // Create new session
    const sessionController = lambder.getSessionController(ctx);
    await sessionController.createSession(user.id, {
        userId: user.id,
        username: user.username,
        role: user.role,
    });

    return resolver.api({
        success: true,
        csrfToken: ctx.session?.csrfToken,
    });
});

// Example: Protected API that requires session
lambder.addSessionApi("user.profile", async (ctx, resolver) => {
    // Session is automatically fetched and validated
    const sessionData = ctx.session?.data;

    return resolver.api({
        userId: sessionData.userId,
        username: sessionData.username,
        role: sessionData.role,
    });
});

// Example: Sensitive operation that regenerates session
lambder.addSessionApi("user.changePassword", async (ctx, resolver) => {
    const { oldPassword, newPassword } = ctx.apiPayload;
    const sessionController = lambder.getSessionController(ctx);

    // Validate old password
    const isValid = await validatePassword(
        ctx.session?.data.userId,
        oldPassword
    );
    if (!isValid) {
        return resolver.api({ success: false, error: "Invalid password" });
    }

    // Update password
    await updatePassword(ctx.session?.data.userId, newPassword);

    // IMPORTANT: Regenerate session after password change to prevent session fixation
    await sessionController.regenerateSession();

    // OPTIONAL: End all other sessions for this user
    await sessionController.endSessionAll();

    return resolver.api({
        success: true,
        message: "Password changed successfully",
        csrfToken: ctx.session?.csrfToken, // Send new CSRF token
    });
});

// Example: Update session data
lambder.addSessionApi("user.updatePreferences", async (ctx, resolver) => {
    const { theme, language } = ctx.apiPayload;
    const sessionController = lambder.getSessionController(ctx);

    // Update session data (also extends expiration if sliding is enabled)
    await sessionController.updateSessionData({
        ...ctx.session?.data,
        preferences: { theme, language },
    });

    return resolver.api({
        success: true,
        message: "Preferences updated",
    });
});

// Example: Logout
lambder.addSessionApi("user.logout", async (ctx, resolver) => {
    const sessionController = lambder.getSessionController(ctx);

    // End current session
    await sessionController.endSession();

    return resolver.api({
        success: true,
        message: "Logged out successfully",
    });
});

// Example: Logout from all devices
lambder.addSessionApi("user.logoutAll", async (ctx, resolver) => {
    const sessionController = lambder.getSessionController(ctx);

    // End all sessions for this user (same sessionKey)
    await sessionController.endSessionAll();

    return resolver.api({
        success: true,
        message: "Logged out from all devices",
    });
});

// Example: Optional session (check if logged in)
lambder.addApi("user.checkAuth", async (ctx, resolver) => {
    const sessionController = lambder.getSessionController(ctx);

    // Try to fetch session without throwing error
    const session = await sessionController.fetchSessionIfExists();

    if (session) {
        return resolver.api({
            authenticated: true,
            userId: session.data.userId,
            username: session.data.username,
        });
    }

    return resolver.api({
        authenticated: false,
    });
});

// Example: Route with session
lambder.addSessionRoute("/dashboard", async (ctx, resolver) => {
    // Session is automatically fetched and validated
    const userData = ctx.session?.data;

    return resolver.ejsFile("dashboard.ejs", {
        user: userData,
        csrfToken: ctx.session?.csrfToken,
    });
});

// Example: Route with optional session
lambder.addRoute("/", async (ctx, resolver) => {
    const sessionController = lambder.getSessionController(ctx);
    const session = await sessionController.fetchSessionIfExists();

    return resolver.ejsFile("home.ejs", {
        isLoggedIn: !!session,
        user: session?.data,
        csrfToken: session?.csrfToken,
    });
});

// Dummy functions (implement these)
async function authenticateUser(username: string, password: string) {
    // Implement your authentication logic
    return { id: "user123", username, role: "user" };
}

async function validatePassword(userId: string, password: string) {
    // Implement password validation
    return true;
}

async function updatePassword(userId: string, newPassword: string) {
    // Implement password update
}

export const handler = async (event: any, context: any) => {
    return await lambder.render(event, context);
};
