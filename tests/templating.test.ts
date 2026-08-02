/**
 * Type-safe templating: html/xml tagged templates and the standalone LambderTemplatingEngine (comment-only slots and conditionals).
 */

import { describe, it, expect } from 'vitest';
import Lambder from '../src/Lambder.js';
import { html, xml, raw } from '../src/LambderHtml.js';
import { LambderTemplatingEngine } from '../src/LambderTemplatingEngine.js';
import { decodeBody, createMockEvent, createMockContext } from './helpers.js';
describe('Type-safe templating (html/xml tagged templates)', () => {
    it('escapes interpolated values by default', () => {
        const userInput = '<script>alert("xss")</script>';
        const out = html`<p>${userInput}</p>`;
        expect(String(out)).toBe('<p>&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;</p>');
    });

    it('flattens arrays and inserts nested fragments without double escaping', () => {
        const items = ['A & B', 'C<D'];
        const out = html`<ul>${items.map((item) => html`<li>${item}</li>`)}</ul>`;
        expect(String(out)).toBe('<ul><li>A &amp; B</li><li>C&lt;D</li></ul>');
    });

    it('renders null/undefined/false as empty (conditional rendering)', () => {
        const show = false;
        const out = html`<div>${show && html`<span>hidden</span>`}${null}${undefined}</div>`;
        expect(String(out)).toBe('<div></div>');
    });

    it('raw() inserts trusted content verbatim', () => {
        const out = html`<head>${raw('<meta charset="utf-8">')}</head>`;
        expect(String(out)).toBe('<head><meta charset="utf-8"></head>');
    });

    it('builds XML sitemaps with escaping and works with res.xml', async () => {
        const urls = ['https://example.com/a?x=1&y=2', 'https://example.com/b'];
        const sitemap = xml`<?xml version="1.0" encoding="UTF-8"?>
<urlset>${urls.map((loc) => xml`<url><loc>${loc}</loc></url>`)}</urlset>`;

        const lambder = new Lambder({ publicPath: './public' })
            .addRoute('/sitemap', (ctx, res) => res.xml(sitemap));

        const result = await lambder.render(createMockEvent('/sitemap'), createMockContext());
        const body = decodeBody(result);
        expect(result.multiValueHeaders?.['Content-Type']?.[0]).toContain('application/xml');
        expect(body).toContain('<loc>https://example.com/a?x=1&amp;y=2</loc>');
    });
});


describe('LambderTemplatingEngine', () => {
    it('replaces slot content and keeps defaults for missing data', () => {
        const template = new LambderTemplatingEngine(
            '<h1><!--slot:title-->Default<!--/slot:title--></h1><p><!--slot:sub-->Sub<!--/slot:sub--></p>',
        );
        expect(template.render({ title: 'Hello' })).toBe('<h1>Hello</h1><p>Sub</p>');
        expect(template.slotNames).toEqual(['title', 'sub']);
    });

    it('escapes slot values unless marked safe', () => {
        const template = new LambderTemplatingEngine('<div><!--slot:content/--></div>');
        expect(template.render({ content: '<b>x</b>' })).toBe('<div>&lt;b&gt;x&lt;/b&gt;</div>');
        expect(template.render({ content: html`<b>${'x & y'}</b>` })).toBe('<div><b>x &amp; y</b></div>');
        expect(template.render({ content: raw('<b>trusted</b>') })).toBe('<div><b>trusted</b></div>');
    });

    it('supports if/else conditionals including negation', () => {
        const template = new LambderTemplatingEngine(
            '<!--if:isRtl--><html dir="rtl"><!--else--><html><!--/if:isRtl--><!--if:!minimal--><nav/><!--/if:!minimal-->',
        );
        expect(template.render({ isRtl: true })).toBe('<html dir="rtl"><nav/>');
        expect(template.render({ isRtl: false, minimal: true })).toBe('<html>');
        expect(template.conditionNames).toEqual(['isRtl', 'minimal']);
    });

    it('supports nested blocks and array/number values', () => {
        const template = new LambderTemplatingEngine(
            '<!--if:show--><ul><!--slot:items/--></ul><!--/if:show-->',
        );
        const items = [1, 2].map((n) => html`<li>${n}</li>`);
        expect(template.render({ show: true, items })).toBe('<ul><li>1</li><li>2</li></ul>');
        expect(template.render({ items })).toBe('');
    });

    it('ignores unknown data keys (shared data across different shells)', () => {
        const template = new LambderTemplatingEngine('<p><!--slot:a-->A<!--/slot:a--></p>');
        expect(template.render({ a: 'x', notInShell: 'y' })).toBe('<p>x</p>');
    });

    it('throws on unclosed or mismatched blocks', () => {
        expect(() => new LambderTemplatingEngine('<!--slot:a-->x')).toThrow(/unclosed/);
        expect(() => new LambderTemplatingEngine('<!--if:a-->x<!--/if:b-->')).toThrow(/unexpected/);
        expect(() => new LambderTemplatingEngine('x<!--else-->y')).toThrow(/outside/);
    });

    it('rejects slots in unquoted attribute positions at compile time', () => {
        expect(() => new LambderTemplatingEngine('<div class=<!--slot:cls/-->></div>'))
            .toThrow(/unquoted attribute/);
        // Quoted attributes are fine.
        expect(() => new LambderTemplatingEngine('<div class="<!--slot:cls/-->"></div>')).not.toThrow();
    });

    it('rejects slots inside script and style elements at compile time', () => {
        expect(() => new LambderTemplatingEngine('<script>var x = "<!--slot:v/-->";</script>'))
            .toThrow(/inside a <script>/);
        expect(() => new LambderTemplatingEngine('<style>.a { color: <!--slot:c/-->; }</style>'))
            .toThrow(/inside a <style>/);
        // After the element closes, slots are fine again.
        expect(() => new LambderTemplatingEngine('<script>var x = 1;</script><!--slot:after/-->')).not.toThrow();
    });

    it('exposes virtual title/head slots for plain HTML documents', () => {
        const template = new LambderTemplatingEngine(
            '<html><head><title>Old</title></head><body></body></html>',
            { htmlVirtualSlots: true },
        );
        expect(template.slotNames).toEqual(['title', 'head']);
        const out = template.render({ title: 'New', head: html`<meta name="x" content="1" />` });
        expect(out).toBe('<html><head><title>New</title><meta name="x" content="1" /></head><body></body></html>');
    });

    it('declared markers win over virtual slots', () => {
        const template = new LambderTemplatingEngine(
            '<head><title><!--slot:title-->T<!--/slot:title--></title><!--slot:head/--></head>',
            { htmlVirtualSlots: true },
        );
        expect(template.render({ title: 'X' })).toBe('<head><title>X</title></head>');
    });
});

