/**
 * Structured route matchers ({ path, host, method }) and typed path params.
 */

import { describe, it, expect } from 'vitest';
import Lambder from '../src/core/Lambder.js';
import { browse, testPublicFiles } from './helpers.js';
describe('Structured route matchers', () => {
    it('matches on method', async () => {
        const lambder = new Lambder({ files: testPublicFiles() })
            .addRoute({ path: '/hook', method: 'POST' }, (ctx, res) => res.html('posted'))
            .addRoute({ path: '/hook', method: 'GET' }, (ctx, res) => res.html('got'));

        const postResult = await browse(lambder).request('POST', '/hook');
        expect(postResult.text()).toBe('posted');

        const getResult = await browse(lambder).request('GET', '/hook');
        expect(getResult.text()).toBe('got');
    });

    it('HEAD requests match GET routes and return no body', async () => {
        const lambder = new Lambder({ files: testPublicFiles() })
            .addRoute({ path: '/page', method: 'GET' }, (ctx, res) => res.html('page body'));

        const result = await browse(lambder).request('HEAD', '/page');
        expect(result.statusCode).toBe(200);
        expect(result.text()).toBe('');
    });

    it('matches on host', async () => {
        const lambder = new Lambder({ files: testPublicFiles() })
            .addRoute({ path: '/x', host: 'admin.example.com' }, (ctx, res) => res.html('admin'))
            .addRoute({ path: '/x', host: /\.example\.com$/ }, (ctx, res) => res.html('any sub'));

        const adminResult = await browse(lambder, { host: 'admin.example.com' }).request('GET', '/x');
        expect(adminResult.text()).toBe('admin');

        const otherResult = await browse(lambder, { host: 'shop.example.com' }).request('GET', '/x');
        expect(otherResult.text()).toBe('any sub');
    });

    it('extracts path params from matcher objects', async () => {
        const lambder = new Lambder({ files: testPublicFiles() })
            .addRoute({ path: '/sitemap-:country', method: 'GET' }, (ctx, res) =>
                res.text(String(ctx.pathParams.country)));

        const result = await browse(lambder).request('GET', '/sitemap-ch');
        expect(result.text()).toBe('ch');
    });

    it('matches a string path case-sensitively, as the gateway in front of it does', async () => {
        // Regression: path-to-regexp matches without case unless told, so
        // `/ADMIN/users` missed an API Gateway authorizer or a CloudFront
        // behavior on `/admin/*` and still reached the admin handler.
        const lambder = new Lambder({ files: testPublicFiles() })
            .addRoute('/admin/:section', (ctx, res) => res.text(`admin ${ctx.pathParams.section}`))
            .addRoute({ path: '/Reports/:id', method: 'GET' }, (ctx, res) => res.text(`report ${ctx.pathParams.id}`))
            .setRouteFallbackHandler((ctx, res) => res.text(`other ${ctx.path}`, { statusCode: 404 }));

        const upper = await browse(lambder).request('GET', '/ADMIN/users');
        expect(upper.statusCode).toBe(404);
        expect(upper.text()).toBe('other /ADMIN/users');
        expect((await browse(lambder).request('GET', '/Admin/users')).statusCode).toBe(404);
        expect((await browse(lambder).request('GET', '/admin/users')).text()).toBe('admin users');
        // A param keeps whatever case it arrived in; the literal parts are what must match.
        expect((await browse(lambder).request('GET', '/admin/USERS')).text()).toBe('admin USERS');
        expect((await browse(lambder).request('GET', '/reports/7')).statusCode).toBe(404);
        expect((await browse(lambder).request('GET', '/Reports/7')).text()).toBe('report 7');
        // Trailing-slash leniency is unchanged.
        expect((await browse(lambder).request('GET', '/admin/users/')).text()).toBe('admin users');
    });
});

