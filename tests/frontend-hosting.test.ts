/**
 * Frontend hosting: servePublicFiles (terminal file slot), serveIndexHtml (gated shell slot) and res.templateFile.
 */

import { describe, it, expect } from 'vitest';
import path from 'node:path';
import Lambder from '../src/Lambder.js';
import { html, jsonScript } from '../src/LambderHtml.js';
import { decodeBody, createMockEvent, createMockContext } from './helpers.js';
describe('servePublicFiles + templateFile fallback (frontend hosting recipe)', () => {
    const spaRoot = path.resolve('./tests/fixtures/spa');

    // The recipe: real files from the terminal slot, everything else decided in
    // the app's own fallback (404 for file-like paths, shell for GET pages).
    const buildHost = () => new Lambder({ publicPath: spaRoot })
        .servePublicFiles()
        .setRouteFallbackHandler(async (ctx, res) => {
            if(ctx.method !== 'GET' && ctx.method !== 'HEAD') return res.status404('Not found');
            if((ctx.path.split('/').pop() ?? '').includes('.')) return res.status404('Not found');
            return res.templateFile('index.html', {
                title: `Page ${ctx.path}`,
                head: html`<link rel="canonical" href="https://example.com${ctx.path}" />`,
            }, { cacheControl: 'no-cache', htmlVirtualSlots: true });
        });

    it('serves existing static files with mime type and default cache headers', async () => {
        const result = await buildHost().render(createMockEvent('/style.css'), createMockContext());
        expect(result.statusCode).toBe(200);
        expect(result.multiValueHeaders?.['Content-Type']?.[0]).toBe('text/css');
        expect(result.multiValueHeaders?.['Cache-Control']).toEqual(['public, max-age=3600']);
        expect(decodeBody(result)).toContain('color: red');
    });

    it('serves content-hashed assets with immutable cache headers', async () => {
        const result = await buildHost().render(createMockEvent('/assets/index-Ab3dE5fG7h.js'), createMockContext());
        expect(result.statusCode).toBe(200);
        expect(result.multiValueHeaders?.['Cache-Control']).toEqual(['public, max-age=31536000, immutable']);
    });

    it('falls through to the fallback shell for page routes', async () => {
        const result = await buildHost().render(createMockEvent('/some/spa/route'), createMockContext());
        expect(result.statusCode).toBe(200);
        expect(result.multiValueHeaders?.['Content-Type']?.[0]).toContain('text/html');
        expect(result.multiValueHeaders?.['Cache-Control']).toEqual(['no-cache']);
        const body = decodeBody(result);
        expect(body).toContain('<div id="app">');
        expect(body).toContain('<title>Page /some/spa/route</title>');
        expect(body).toContain('<link rel="canonical" href="https://example.com/some/spa/route" />');
    });

    it('404s missing file-looking paths via the fallback policy', async () => {
        const result = await buildHost().render(createMockEvent('/missing-image.png'), createMockContext());
        expect(result.statusCode).toBe(404);
    });

    it('rejects path traversal (not served, falls to fallback)', async () => {
        const result = await buildHost().render(createMockEvent('/../package.json'), createMockContext());
        expect(result.statusCode).toBe(404);
    });

    it('renders marker-based shells with slots, conditionals and json data', async () => {
        const payload = { message: '</script><script>alert(1)</script>', count: 2 };
        const lambder = new Lambder({ publicPath: spaRoot })
            .servePublicFiles()
            .setRouteFallbackHandler((ctx, res) => res.templateFile('marked.html', {
                title: 'My <Page> & Co',
                head: jsonScript('app-data', payload),
                showBanner: ctx.get.beta === '1',
            }));

        const withBanner = await lambder.render(
            createMockEvent('/page', { queryStringParameters: { beta: '1' } }),
            createMockContext(),
        );
        const body = decodeBody(withBanner);
        expect(body).toContain('<title>My &lt;Page&gt; &amp; Co</title>');
        expect(body).toContain('<div class="banner">Beta</div>');
        expect(body).toContain('<script type="application/json" id="app-data">');
        expect(body).not.toContain('</script><script>alert(1)');
        const jsonMatch = body.match(/id="app-data">([\s\S]*?)<\/script>/);
        expect(JSON.parse(jsonMatch![1]!)).toEqual(payload);

        const withoutBanner = await lambder.render(createMockEvent('/page'), createMockContext());
        expect(decodeBody(withoutBanner)).not.toContain('banner');
    });

    it('keeps shell defaults when data omits a slot', async () => {
        const lambder = new Lambder({ publicPath: spaRoot })
            .servePublicFiles()
            .setRouteFallbackHandler((ctx, res) => res.templateFile('marked.html', {}));

        const result = await lambder.render(createMockEvent('/page'), createMockContext());
        expect(decodeBody(result)).toContain('<title>Default Title</title>');
    });

    it('supports per-tenant roots through the path mapper', async () => {
        const lambder = new Lambder({ publicPath: spaRoot })
            .servePublicFiles({
                path: (ctx) => ctx.host.startsWith('brandx.') ? `brandx${ctx.path}` : ctx.path,
            })
            .setRouteFallbackHandler((ctx, res) => res.templateFile(
                ctx.host.startsWith('brandx.') ? 'brandx/index.html' : 'index.html',
                { head: html`<title>${ctx.host}</title>` },
                { htmlVirtualSlots: true },
            ));

        const brandResult = await lambder.render(
            createMockEvent('/page', { headers: { Host: 'brandx.example.com' } }),
            createMockContext(),
        );
        expect(decodeBody(brandResult)).toContain('BrandX');
        expect(decodeBody(brandResult)).toContain('<title>brandx.example.com</title>');

        const defaultResult = await lambder.render(createMockEvent('/page'), createMockContext());
        expect(decodeBody(defaultResult)).toContain('<div id="app">');
    });

    it('never shadows routes registered after servePublicFiles', async () => {
        const lambder = new Lambder({ publicPath: spaRoot })
            .servePublicFiles()
            .addRoute('/registered-later', (ctx, res) => res.html('Later Route'));

        const result = await lambder.render(createMockEvent('/registered-later'), createMockContext());
        expect(decodeBody(result)).toBe('Later Route');
    });

    it('templateFile throws on missing files (server config error, not a 404)', async () => {
        const lambder = new Lambder({ publicPath: spaRoot })
            .setGlobalErrorHandler((err, ctx, res) => res.status(500, err.message))
            .setRouteFallbackHandler((ctx, res) => res.templateFile('nope.html'));

        const result = await lambder.render(createMockEvent('/page'), createMockContext());
        expect(result.statusCode).toBe(500);
        expect(decodeBody(result)).toContain('templateFile: file not found');
    });

    it('serves cached static files identically on repeat requests', async () => {
        const lambder = buildHost();
        const first = await lambder.render(createMockEvent('/style.css'), createMockContext());
        const second = await lambder.render(createMockEvent('/style.css'), createMockContext());
        expect(second.statusCode).toBe(200);
        expect(second.body).toBe(first.body);
        expect(second.multiValueHeaders?.['ETag']).toEqual(first.multiValueHeaders?.['ETag']);
    });

    it('compress option: function decides per file (force small css, skip js)', async () => {
        const lambder = new Lambder({ publicPath: spaRoot })
            .servePublicFiles({
                compress: (ctx) => ctx.path.endsWith('.css'),
            });

        // style.css is tiny, below the auto threshold: forcing still compresses it.
        const css = await lambder.render(
            createMockEvent('/style.css', { headers: { Host: 'localhost', 'Accept-Encoding': 'gzip' } }),
            createMockContext(),
        );
        expect(css.multiValueHeaders?.['Content-Encoding']).toEqual(['gzip']);

        // js files return false: never compressed.
        const js = await lambder.render(
            createMockEvent('/assets/index-Ab3dE5fG7h.js', { headers: { Host: 'localhost', 'Accept-Encoding': 'gzip' } }),
            createMockContext(),
        );
        expect(js.multiValueHeaders?.['Content-Encoding']).toBeUndefined();
    });
});

describe('serveIndexHtml', () => {
    const spaRoot = path.resolve('./tests/fixtures/spa');

    it('zero-config: serves index.html with no-cache for GET page routes', async () => {
        const lambder = new Lambder({ publicPath: spaRoot })
            .servePublicFiles()
            .serveIndexHtml();

        const result = await lambder.render(createMockEvent('/some/spa/route'), createMockContext());
        expect(result.statusCode).toBe(200);
        expect(result.multiValueHeaders?.['Content-Type']?.[0]).toContain('text/html');
        expect(result.multiValueHeaders?.['Cache-Control']).toEqual(['no-cache']);
        expect(decodeBody(result)).toContain('<div id="app">');
    });

    it('gates on method: non-GET/HEAD falls through to the route fallback', async () => {
        const lambder = new Lambder({ publicPath: spaRoot })
            .serveIndexHtml()
            .setRouteFallbackHandler((ctx, res) => res.status(405, 'nope'));

        const result = await lambder.render(createMockEvent('/page', { httpMethod: 'POST' }), createMockContext());
        expect(result.statusCode).toBe(405);
    });

    it('gates on file-looking paths by default (missing assets 404, no soft-404 shell)', async () => {
        const lambder = new Lambder({ publicPath: spaRoot })
            .servePublicFiles()
            .serveIndexHtml();

        const result = await lambder.render(createMockEvent('/missing-image.png'), createMockContext());
        expect(result.statusCode).toBe(404);
    });

    it('skipFilePaths: false lets dotted paths reach the handler', async () => {
        const lambder = new Lambder({ publicPath: spaRoot })
            .serveIndexHtml((ctx, res) => res.html(`page ${ctx.path}`), { skipFilePaths: false });

        const result = await lambder.render(createMockEvent('/user/john.doe'), createMockContext());
        expect(decodeBody(result)).toBe('page /user/john.doe');
    });

    it('custom handler has full control (templating, per-brand shells)', async () => {
        const lambder = new Lambder({ publicPath: spaRoot })
            .serveIndexHtml((ctx, res) => res.templateFile('marked.html', {
                title: `Page ${ctx.path}`,
                showBanner: true,
            }));

        const result = await lambder.render(createMockEvent('/city/zurich'), createMockContext());
        const body = decodeBody(result);
        expect(body).toContain('<title>Page /city/zurich</title>');
        expect(body).toContain('<div class="banner">Beta</div>');
    });

    it('redirectTrailingSlash is off by default, and 301s with query when enabled', async () => {
        const noRedirect = new Lambder({ publicPath: spaRoot }).serveIndexHtml();
        const kept = await noRedirect.render(createMockEvent('/about/'), createMockContext());
        expect(kept.statusCode).toBe(200);

        const withRedirect = new Lambder({ publicPath: spaRoot })
            .serveIndexHtml(undefined, { redirectTrailingSlash: true });
        const redirected = await withRedirect.render(
            createMockEvent('/about/', { queryStringParameters: { a: '1' } }),
            createMockContext(),
        );
        expect(redirected.statusCode).toBe(301);
        expect(redirected.multiValueHeaders?.['Location']).toEqual(['/about?a=1']);
    });

    it('indexFile option picks the shell per request', async () => {
        const lambder = new Lambder({ publicPath: spaRoot })
            .serveIndexHtml(undefined, {
                indexFile: (ctx) => ctx.host.startsWith('brandx.') ? 'brandx/index.html' : 'index.html',
            });

        const brandResult = await lambder.render(
            createMockEvent('/page', { headers: { Host: 'brandx.example.com' } }),
            createMockContext(),
        );
        expect(decodeBody(brandResult)).toContain('BrandX');
    });

    it('compress option forces or disables shell compression, like servePublicFiles', async () => {
        // The fixture shell is tiny (below the auto threshold): compress: true still gzips it.
        const forced = new Lambder({ publicPath: spaRoot }).serveIndexHtml(undefined, { compress: true });
        const forcedResult = await forced.render(
            createMockEvent('/page', { headers: { Host: 'localhost', 'Accept-Encoding': 'gzip' } }),
            createMockContext(),
        );
        expect(forcedResult.multiValueHeaders?.['Content-Encoding']).toEqual(['gzip']);

        // compress also applies to custom handlers, and functions decide per request.
        const perRequest = new Lambder({ publicPath: spaRoot })
            .serveIndexHtml((ctx, res) => res.templateFile('index.html'), { compress: (ctx) => ctx.get.z === '1' });
        const off = await perRequest.render(
            createMockEvent('/page', { headers: { Host: 'localhost', 'Accept-Encoding': 'gzip' } }),
            createMockContext(),
        );
        expect(off.multiValueHeaders?.['Content-Encoding']).toBeUndefined();
        const on = await perRequest.render(
            createMockEvent('/page', { headers: { Host: 'localhost', 'Accept-Encoding': 'gzip' }, queryStringParameters: { z: '1' } }),
            createMockContext(),
        );
        expect(on.multiValueHeaders?.['Content-Encoding']).toEqual(['gzip']);
    });
});

