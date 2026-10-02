/**
 * jsonScript: JSON in a <script> element, as hydration state or as JSON-LD,
 * escaped so no payload can end the element or break the JavaScript that
 * reads it, whichever type it is written as.
 */

import { describe, it, expect } from 'vitest';
import { html, jsonScript, type LambderJsonScriptOptions } from '../../src/shared/LambderHtml.js';

/** A payload holding everything that could end the element early, or that older parsers read as a line break. */
const hostile = {
    name: 'Corner Store </script><script>alert(1)</script>',
    note: '<!-- a comment opener -->',
    lines: 'one\u2028two\u2029three',
};

/** The JSON between the tags, as a page reads it back with JSON.parse(element.textContent). */
const contentOf = (markup: string) => markup.slice(markup.indexOf('>') + 1, markup.lastIndexOf('</script>'));

describe('jsonScript', () => {
    it('writes hydration state as application/json under its id, escaped', () => {
        const markup = String(jsonScript('store-state', hostile));

        expect(markup.startsWith('<script type="application/json" id="store-state">')).toBe(true);
        expect(contentOf(markup)).not.toMatch(/<|\u2028|\u2029/);
        expect(markup.match(/<\/script>/g)).toHaveLength(1);
        expect(JSON.parse(contentOf(markup))).toEqual(hostile);
    });

    it('writes JSON-LD with no id needed, under the same escaping', () => {
        const product = { '@context': 'https://schema.org', '@type': 'Product', ...hostile };
        const markup = String(jsonScript({ type: 'application/ld+json' }, product));

        expect(markup.startsWith('<script type="application/ld+json">')).toBe(true);
        expect(contentOf(markup)).not.toMatch(/<|\u2028|\u2029/);
        expect(markup.match(/<\/script>/g)).toHaveLength(1);
        expect(JSON.parse(contentOf(markup))).toEqual(product);
    });

    it('takes the options form for either type, an id included, and escapes the id', () => {
        expect(String(jsonScript({ id: 'order"><b>', type: 'application/json' }, { total: 12 })))
            .toBe('<script type="application/json" id="order&quot;&gt;&lt;b&gt;">{"total":12}</script>');
        expect(String(jsonScript({ type: 'application/ld+json', id: 'store-data' }, { '@type': 'Store' })))
            .toBe('<script type="application/ld+json" id="store-data">{"@type":"Store"}</script>');
    });

    it('needs an id for application/json, which is how the page finds it', () => {
        // @ts-expect-error a data block without an id
        const withoutId: LambderJsonScriptOptions = { type: 'application/json' };
        expect(withoutId).toBeDefined();
    });

    it('refuses a type that is not a JSON script type, since the type is written into the markup as it is', () => {
        expect(() => jsonScript({ type: 'text/javascript" onload="alert(1)' } as unknown as LambderJsonScriptOptions, {}))
            .toThrow(/type must be "application\/json" or "application\/ld\+json"/);
    });

    it('goes into a template verbatim, outside any script element', () => {
        const page = html`<head>${jsonScript({ type: 'application/ld+json' }, { name: 'Corner Store' })}</head>`;
        expect(String(page)).toBe('<head><script type="application/ld+json">{"name":"Corner Store"}</script></head>');
    });
});
