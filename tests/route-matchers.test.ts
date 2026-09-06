/**
 * Structured route matchers ({ path, host, method }) and typed path params.
 */

import { describe, it, expect } from 'vitest';
import Lambder from '../src/core/Lambder.js';
import { decodeBody, createMockEvent, createMockContext } from './helpers.js';
describe('Structured route matchers', () => {
    it('matches on method', async () => {
        const lambder = new Lambder({ publicPath: './public' })
            .addRoute({ path: '/hook', method: 'POST' }, (ctx, res) => res.html('posted'))
            .addRoute({ path: '/hook', method: 'GET' }, (ctx, res) => res.html('got'));

        const postResult = await lambder.render(createMockEvent('/hook', { httpMethod: 'POST' }), createMockContext());
        expect(decodeBody(postResult)).toBe('posted');

        const getResult = await lambder.render(createMockEvent('/hook'), createMockContext());
        expect(decodeBody(getResult)).toBe('got');
    });

    it('HEAD requests match GET routes and return no body', async () => {
        const lambder = new Lambder({ publicPath: './public' })
            .addRoute({ path: '/page', method: 'GET' }, (ctx, res) => res.html('page body'));

        const result = await lambder.render(createMockEvent('/page', { httpMethod: 'HEAD' }), createMockContext());
        expect(result.statusCode).toBe(200);
        expect(result.body).toBe('');
    });

    it('matches on host', async () => {
        const lambder = new Lambder({ publicPath: './public' })
            .addRoute({ path: '/x', host: 'admin.example.com' }, (ctx, res) => res.html('admin'))
            .addRoute({ path: '/x', host: /\.example\.com$/ }, (ctx, res) => res.html('any sub'));

        const adminResult = await lambder.render(
            createMockEvent('/x', { headers: { Host: 'admin.example.com' } }),
            createMockContext(),
        );
        expect(decodeBody(adminResult)).toBe('admin');

        const otherResult = await lambder.render(
            createMockEvent('/x', { headers: { Host: 'shop.example.com' } }),
            createMockContext(),
        );
        expect(decodeBody(otherResult)).toBe('any sub');
    });

    it('extracts path params from matcher objects', async () => {
        const lambder = new Lambder({ publicPath: './public' })
            .addRoute({ path: '/sitemap-:country', method: 'GET' }, (ctx, res) =>
                res.text(String(ctx.pathParams.country)));

        const result = await lambder.render(createMockEvent('/sitemap-ch'), createMockContext());
        expect(decodeBody(result)).toBe('ch');
    });
});

