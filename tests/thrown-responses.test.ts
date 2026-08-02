/**
 * Thrown responses: any thrown LambderResponse is the response; res.die.* halts at any call depth; beforeRender hooks can short-circuit.
 */

import { describe, it, expect } from 'vitest';
import Lambder from '../src/Lambder.js';
import { decodeBody, createMockEvent, createMockContext } from './helpers.js';
describe('Thrown responses and die', () => {
    it('a thrown response becomes the response (any call depth)', async () => {
        const guard = (res: any) => { throw res.redirect('/login', 302); };
        const lambder = new Lambder({ publicPath: './public' })
            .addRoute('/deep', (ctx, res) => {
                guard(res);
                return res.html('never reached');
            });

        const result = await lambder.render(createMockEvent('/deep'), createMockContext());
        expect(result.statusCode).toBe(302);
        expect(result.multiValueHeaders?.['Location']).toEqual(['/login']);
    });

    it('res.die.* halts the handler immediately', async () => {
        let afterDieRan = false;
        const lambder = new Lambder({ publicPath: './public' })
            .addRoute('/die', (ctx, res) => {
                res.die.status404('Gone');
                afterDieRan = true;
                return res.html('never');
            });

        const result = await lambder.render(createMockEvent('/die'), createMockContext());
        expect(result.statusCode).toBe(404);
        expect(decodeBody(result)).toBe('Gone');
        expect(afterDieRan).toBe(false);
    });

    it('die inside a beforeRender hook prevents the route handler from running', async () => {
        let handlerRan = false;
        const lambder = new Lambder({ publicPath: './public' });
        lambder.addHook('beforeRender', async (ctx, res) => {
            if(ctx.cookie.dev !== 'atlas'){ res.die.status404('Not found'); }
            return ctx;
        });
        lambder.addRoute('/gated', (ctx, res) => {
            handlerRan = true;
            return res.html('secret');
        });

        const result = await lambder.render(createMockEvent('/gated'), createMockContext());
        expect(result.statusCode).toBe(404);
        expect(handlerRan).toBe(false);
    });

    it('beforeRender hooks can return a response to short-circuit', async () => {
        let handlerRan = false;
        const lambder = new Lambder({ publicPath: './public' });
        lambder.addHook('beforeRender', async (ctx, res) => res.redirect('/elsewhere', 301));
        lambder.addRoute('/x', (ctx, res) => {
            handlerRan = true;
            return res.html('x');
        });

        const result = await lambder.render(createMockEvent('/x'), createMockContext());
        expect(result.statusCode).toBe(301);
        expect(handlerRan).toBe(false);
    });
});

