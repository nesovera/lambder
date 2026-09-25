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

    it('keeps a path on this origin, and sends a URL with a scheme as it is', async () => {
        const lambder = new Lambder({
            files: testPublicFiles(),
            apiPath: '/api'
        })
            .addRoute('/slashes', (ctx, res) => res.redirect('//evil.example/x'))
            .addRoute('/backslash', (ctx, res) => res.redirect('/\\evil.example'))
            .addRoute('/mixed', (ctx, res) => res.redirect('\\/\\evil.example/y'))
            .addRoute('/absolute', (ctx, res) => res.redirect('https://example.com//x'));

        const visitor = browse(lambder);
        // A browser reads `//host` as another host and a backslash as a slash.
        expect((await visitor.request('GET', '/slashes')).headers.location).toBe('/evil.example/x');
        expect((await visitor.request('GET', '/backslash')).headers.location).toBe('/evil.example');
        expect((await visitor.request('GET', '/mixed')).headers.location).toBe('/evil.example/y');
        expect((await visitor.request('GET', '/absolute')).headers.location).toBe('https://example.com//x');
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
