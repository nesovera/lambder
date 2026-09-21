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
});

