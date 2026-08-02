/**
 * Render context additions: rawBody, case-insensitive header(), client ip.
 */

import { describe, it, expect } from 'vitest';
import Lambder from '../src/Lambder.js';
import { decodeBody, createMockEvent, createMockContext } from './helpers.js';
describe('Context additions', () => {
    it('exposes rawBody, case-insensitive header(), and ip', async () => {
        const lambder = new Lambder({ publicPath: './public' })
            .addRoute({ path: '/echo', method: 'POST' }, (ctx, res) => res.json({
                rawBody: ctx.rawBody,
                contentType: ctx.header('content-type'),
                ip: ctx.ip,
            }));

        const result = await lambder.render(
            createMockEvent('/echo', {
                httpMethod: 'POST',
                body: '{"a":1}',
                headers: { Host: 'localhost', 'Content-Type': 'application/json', 'CF-Connecting-IP': '1.2.3.4' },
            }),
            createMockContext(),
        );
        const body = JSON.parse(decodeBody(result));
        expect(body.rawBody).toBe('{"a":1}');
        expect(body.contentType).toBe('application/json');
        expect(body.ip).toBe('1.2.3.4');
    });
});
