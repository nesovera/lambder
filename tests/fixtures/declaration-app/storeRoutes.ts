import type { StoreLambder } from "./storeApp.js";

/** Routes registered on the instance by a function an entry calls. */
export const storeRoutes = (lambder: StoreLambder) =>
    lambder.addRoute("/receipts/:orderId", async (ctx, res) => {
        await ctx.rateLimit("browsePerIp");
        return res.text(ctx.pathParams.orderId);
    });
