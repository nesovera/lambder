/**
 * The MSW handler that makes a LambderMemoryUploadBucket the storage a mock
 * app's browser uploads to: every request under the bucket's baseUrl (a
 * LambderUploadRunner's post, a download link's GET) is answered by the
 * bucket, the way S3 would answer it. Register it beside the API handler:
 *
 * ```ts
 * const documents = new LambderMemoryUploadBucket();
 * setupWorker(
 *     lambderMockMswHandler(mockApp, { apiPath: "/api", msw }),
 *     lambderMockUploadMswHandler(documents, { msw }),
 * );
 * ```
 *
 * The mock's ticket and confirm handlers then call `documents` as the
 * server's call the real bucket, so the runner's whole conversation runs, the
 * checks storage makes on a post included.
 *
 * Lambder never depends on msw: the app installs it and passes the module
 * in. Generic over the module so the handler keeps msw's own handler type.
 */
export const lambderMockUploadMswHandler = (bucket, options) => {
    const { msw } = options;
    if (!msw?.http?.all) {
        throw new Error('lambderMockUploadMswHandler requires the msw module: lambderMockUploadMswHandler(bucket, { msw: await import("msw") }). Install it with: npm install msw --save-dev');
    }
    return msw.http.all(`${bucket.baseUrl}*`, async ({ request }) => (await bucket.handleStorageRequest(request)) ?? undefined);
};
