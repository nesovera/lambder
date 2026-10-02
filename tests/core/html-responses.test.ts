/**
 * The responses a browser renders as markup take safe markup only: html`...`,
 * xml`...`, raw() and jsonScript(). A plain string is a type error and throws,
 * so a route cannot reflect request text into a page unescaped; text goes out
 * with res.text.
 */

import { describe, it, expect, vi } from 'vitest';
import Lambder from '../../src/core/Lambder.js';
import LambderResponseBuilder from '../../src/core/LambderResponseBuilder.js';
import { html, xml, raw, jsonScript } from '../../src/shared/LambderHtml.js';
import { browse, testPublicFiles } from '../helpers.js';

describe('HTML responses', () => {
    it('refuses a plain string at compile time and at run time, naming the tag, raw() and res.text', () => {
        const res = new LambderResponseBuilder({});
        const plain = '<p>No match at /<script>alert(1)</script></p>';

        // @ts-expect-error a plain string is not safe HTML
        expect(() => res.html(plain)).toThrow(/res\.html takes safe HTML, and was given string\. Build the body with html`\.\.\.`.*raw\(\).*res\.text/);
        // @ts-expect-error a plain string is not safe HTML
        expect(() => res.status(400, plain)).toThrow(/res\.status takes safe HTML/);
        // @ts-expect-error a plain string is not safe HTML
        expect(() => res.status404(plain)).toThrow(/res\.status404 takes safe HTML/);
        // @ts-expect-error a plain string is not safe XML
        expect(() => res.xml('<feed/>')).toThrow(/res\.xml takes safe XML, and was given string\. Build the body with xml`\.\.\.`/);
        expect(() => res.html(null as any)).toThrow(/was given null/);
    });

    it('sends what html, xml, raw() and jsonScript() build, with its content type and status', () => {
        const res = new LambderResponseBuilder({});
        const page = res.html(html`<p>${'<b>'}</p>`);
        expect(page.body).toBe('<p>&lt;b&gt;</p>');
        expect(page.headers['Content-Type']).toEqual(['text/html; charset=utf-8']);

        expect(res.html(raw('<p>trusted</p>')).body).toBe('<p>trusted</p>');
        expect(res.html(jsonScript('state', { a: 1 })).body).toBe('<script type="application/json" id="state">{"a":1}</script>');

        const feed = res.xml(xml`<feed>${'a & b'}</feed>`);
        expect(feed.body).toBe('<feed>a &amp; b</feed>');
        expect(feed.headers['Content-Type']).toEqual(['application/xml; charset=utf-8']);

        const missing = res.status404(html`<h1>Not found</h1>`);
        expect([missing.statusCode, missing.body]).toEqual([404, '<h1>Not found</h1>']);
        const gone = res.status(410, html`<h1>Gone</h1>`);
        expect([gone.statusCode, gone.body, gone.headers['Content-Type']]).toEqual([410, '<h1>Gone</h1>', ['text/html; charset=utf-8']]);
        const empty = res.status(204);
        expect([empty.statusCode, empty.body]).toEqual([204, '']);
    });

    it('sends a message under any status as text', () => {
        const res = new LambderResponseBuilder({});
        const refused = res.text('<script>alert(1)</script>', { statusCode: 403 });
        expect([refused.statusCode, refused.body, refused.headers['Content-Type']])
            .toEqual([403, '<script>alert(1)</script>', ['text/plain; charset=utf-8']]);
    });

    it('answers a route that reflects a plain string with the crash answer, not the reflected page', async () => {
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        const lambder = new Lambder({ files: testPublicFiles() })
            .addRoute('/search', (ctx, res) => res.html(('No match at ' + ctx.path) as any))
            .addRoute('/escaped', (ctx, res) => res.html(html`No match for ${ctx.get.q}`));

        const reflected = await browse(lambder).request('GET', '/search', { query: { q: '<script>alert(1)</script>' } });
        expect(reflected.statusCode).toBe(500);
        expect(reflected.text()).not.toContain('No match');
        expect(String(error.mock.calls[0]?.[1])).toMatch(/res\.html takes safe HTML/);

        const escaped = await browse(lambder).request('GET', '/escaped', { query: { q: '<script>alert(1)</script>' } });
        expect(escaped.text()).toBe('No match for &lt;script&gt;alert(1)&lt;/script&gt;');
        error.mockRestore();
    });

    it('holds the die methods to the same rule', async () => {
        const lambder = new Lambder({ files: testPublicFiles() })
            .addRoute('/gone', (ctx, res) => res.die.status404(html`<h1>Gone</h1>`))
            .addRoute('/plain', (ctx, res) => {
                // @ts-expect-error a plain string is not safe HTML
                return res.die.html('plain');
            });

        expect((await browse(lambder).request('GET', '/gone')).text()).toBe('<h1>Gone</h1>');
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        expect((await browse(lambder).request('GET', '/plain')).statusCode).toBe(500);
        error.mockRestore();
    });

    it('answers a missing res.file with a plain-text 404', async () => {
        const lambder = new Lambder({ files: testPublicFiles() }).addRoute('/download', (ctx, res) => res.file('no-such-file.txt'));
        const missing = await browse(lambder).request('GET', '/download');
        expect([missing.statusCode, missing.text(), missing.headers['content-type']]).toEqual([404, 'File not found', 'text/plain; charset=utf-8']);
    });
});
