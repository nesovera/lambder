import { browse, testPublicFiles } from './helpers.js';
import { describe, it, expect } from 'vitest';
import Lambder from '../src/core/Lambder.js';

describe('Redirect Response', () => {
    it('should redirect with default status code 302', async () => {
        const lambder = new Lambder({
            files: testPublicFiles(),
            apiPath: '/api'
        })
            .addRoute('/old-path', (ctx, res) => {
                return res.redirect('/new-path');
            });

        const visitor = browse(lambder);
        const result = await visitor.request('GET', '/old-path');

        expect(result.statusCode).toBe(302);
        expect(result.headers.location).toBe('/new-path');
    });

    it('should redirect with custom status code', async () => {
        const lambder = new Lambder({
            files: testPublicFiles(),
            apiPath: '/api'
        })
            .addRoute('/moved-permanently', (ctx, res) => {
                return res.redirect('/new-location', 301);
            });

        const visitor = browse(lambder);
        const result = await visitor.request('GET', '/moved-permanently');

        expect(result.statusCode).toBe(301);
        expect(result.headers.location).toBe('/new-location');
    });

    it('should redirect using die.redirect', async () => {
        const lambder = new Lambder({
            files: testPublicFiles(),
            apiPath: '/api'
        })
            .addRoute('/die-redirect', (ctx, res) => {
                return res.die.redirect('/somewhere-else');
            });

        const visitor = browse(lambder);
        const result = await visitor.request('GET', '/die-redirect');

        expect(result.statusCode).toBe(302);
        expect(result.headers.location).toBe('/somewhere-else');
    });
});
