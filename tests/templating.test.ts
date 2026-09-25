/**
 * Type-safe templating: html/xml tagged templates and the standalone LambderTemplatingEngine (comment-only slots and conditionals).
 */

import { describe, it, expect } from 'vitest';
import Lambder from '../src/core/Lambder.js';
import { html, xml, raw, jsonScript } from '../src/shared/LambderHtml.js';
import { LambderTemplatingEngine } from '../src/core/LambderTemplatingEngine.js';
import { decodeBody, createMockEvent, createMockContext, testPublicFiles } from './helpers.js';
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

        const lambder = new Lambder({ files: testPublicFiles() })
            .addRoute('/sitemap', (ctx, res) => res.xml(sitemap));

        const result = await lambder.render(createMockEvent('/sitemap'), createMockContext());
        const body = decodeBody(result);
        expect(result.multiValueHeaders?.['Content-Type']?.[0]).toContain('application/xml');
        expect(body).toContain('<loc>https://example.com/a?x=1&amp;y=2</loc>');
    });
});

describe('html/xml interpolation positions', () => {
    it('leaves text, comments, quoted values and nested fragments in text as they were', () => {
        expect(String(html`<p class=lead title="a=b ${'x"y'}">total: ${5} ${'<b>'}</p>`))
            .toBe('<p class=lead title="a=b x&quot;y">total: 5 &lt;b&gt;</p>');
        expect(String(html`<!-- ${'-->'} --><ul>${[1, 2].map((n) => html`<li data-n="${n}">${n}</li>`)}</ul>`))
            .toBe('<!-- --&gt; --><ul><li data-n="1">1</li><li data-n="2">2</li></ul>');
        expect(String(html`<head>${raw('<meta charset="utf-8">')}${jsonScript('state', { a: '</script>' })}</head>`))
            .toBe('<head><meta charset="utf-8"><script type="application/json" id="state">{"a":"\\u003c/script>"}</script></head>');
    });

    it('refuses an unquoted attribute value, with or without a prefix before the interpolation', () => {
        // A space in the value would start a new attribute: "x onmouseover=...".
        expect(() => html`<div class=${'x onmouseover=alert(1)'}></div>`).toThrow(/interpolation after "<div class=" is in an unquoted attribute position/);
        expect(() => html`<div class=big-${'x'}></div>`).toThrow(/unquoted attribute/);
        expect(() => html`<a id="x" href=/users/${7}>link</a>`).toThrow(/unquoted attribute/);
        expect(() => html`<div class= ${'x'}></div>`).toThrow(/unquoted attribute/);
        expect(() => html`<input type="checkbox" value='${'a'}' name=${'b'}>`).toThrow(/unquoted attribute/);
    });

    it('refuses an interpolation where an attribute name goes, and points at the whole-tag variant', () => {
        expect(() => html`<input ${'autofocus onfocus=alert(1)'}>`).toThrow(/is inside a tag where an attribute name goes/);
        expect(() => html`<input ${html`checked`}>`).toThrow(/build the whole tag conditionally/);
        // Or the tag's own name, where the value would carry the attributes.
        expect(() => html`<${'img src=x onerror=alert(1)'}>`).toThrow(/attribute name/);
        expect(() => html`<div class="a" ${raw('data-x="1"')}></div>`).toThrow(/attribute name/);
        const checked = true;
        expect(String(html`${checked ? html`<input checked>` : html`<input>`}`)).toBe('<input checked>');
    });

    it('refuses the quoted value of an event handler, style or srcdoc', () => {
        // The browser decodes the escapes before it runs a handler, so
        // `');alert(1);//` in onclick="go('${x}')" would run.
        expect(() => html`<button onclick="go('${"');alert(1);//"}')">Go</button>`)
            .toThrow(/is inside the onclick attribute, whose value the browser reads as JavaScript/);
        expect(() => html`<a href="/" ONMOUSEOVER='${'x'}'>x</a>`).toThrow(/onmouseover attribute.*JavaScript/);
        expect(() => html`<div style="color: ${'red'}">x</div>`).toThrow(/style attribute.*CSS/);
        expect(() => html`<iframe srcdoc="${html`<b>x</b>`}"></iframe>`).toThrow(/srcdoc attribute.*an HTML document/);
        // Past the handler's value, or in another attribute, the value is text again.
        expect(String(html`<button onclick="go()" title="${'t'}">Go</button>`)).toBe('<button onclick="go()" title="t">Go</button>');
        expect(() => html`<a data-onclick="x" title="onclick ${'t'}">x</a>`).not.toThrow();
        expect(() => html`<p>style="${'t'}"</p>`).not.toThrow();
    });

    it('refuses script and style content, and reads past a closed script whatever it holds', () => {
        expect(() => html`<script>var x = "${'v'}";</script>`).toThrow(/is inside a <script> element where HTML escaping does not apply.*jsonScript/);
        expect(() => html`<style>.a { color: ${'red'}; }</style>`).toThrow(/inside a <style>/);
        expect(() => html`<SCRIPT type=module>${raw('go()')}</SCRIPT>`).toThrow(/inside a <script>/);
        expect(String(html`<script>var x = 1;</script>${'<after>'}`)).toBe('<script>var x = 1;</script>&lt;after&gt;');
        // A "<" and a quote inside the script are script: they open no tag and no value.
        expect(String(html`<script>if(a<b){s="<p title='"}</script><p>${'x'}</p>`)).toBe(`<script>if(a<b){s="<p title='"}</script><p>x</p>`);
        expect(() => html`<script>if(a<b){s="<p title='"}</script><p class=${'x'}>`).toThrow(/unquoted attribute/);
        // Only the element itself is raw text: a name that starts the same, or a mention in a comment or a value, is not.
        expect(() => html`<style-box>${'x'}</style-box><!-- <script> --><a title="<style>">${'y'}</a>`).not.toThrow();
    });

    it('ends a comment where the browser does: at <!-->, <!---> and --!>', () => {
        // Each of these ends the comment in a browser, so the unquoted title
        // after it would be a live attribute list.
        const value = 'a onmouseover=alert(1)';
        expect(() => html`<!--><a title=${value}>t</a>`).toThrow(/interpolation after "<!--><a title=" is in an unquoted attribute position/);
        expect(() => html`<!---><a title=${value}>t</a>`).toThrow(/unquoted attribute/);
        expect(() => html`<!-- c --!><a title=${value}>t</a>`).toThrow(/unquoted attribute/);
        // Past a comment that ends at "-->", text is text again.
        expect(String(html`<!----><p>${'<b>'}</p>`)).toBe('<!----><p>&lt;b&gt;</p>');
    });

    it('keeps a value inside a comment escaped, and refuses one whose end could close the comment', () => {
        expect(String(html`<!-- ${'--><script>alert(1)</script>'} -->`)).toBe('<!-- --&gt;&lt;script&gt;alert(1)&lt;/script&gt; -->');
        // A value ending in "--" before the template's ">" would end the
        // comment there, and the markup after it would render.
        expect(() => html`<!-- ${'--'}> <p title=x>t</p> -->`).toThrow(/interpolation after "<!-- " is inside a comment, right before text that ends the comment/);
        expect(() => html`<!--${''}>`).toThrow(/inside a comment/);
        // Before a "-->" the comment ends at the same place whatever the value.
        expect(String(html`<!--${'--'}-->`)).toBe('<!------>');
    });

    it('reads end tags, bogus comments, title and textarea content and script escapes the way a browser does', () => {
        // In each of these the browser has left the quote a reading that
        // skips end tags, bogus comments or title text would still be in,
        // so the title after it is unquoted.
        expect(() => html`</x a="<y b="><p title=${'v'}>t</p>`).toThrow(/unquoted attribute/);
        expect(() => html`<!x <a title="><p title=${'v'}>t</p>`).toThrow(/unquoted attribute/);
        expect(() => html`<title>a title="</title><p title=${'v'}>t</p>`).toThrow(/unquoted attribute/);
        expect(() => html`<textarea>a title="</textarea><p title=${'v'}>t</p>`).toThrow(/unquoted attribute/);
        // A no-break space does not end a tag's name, so the value would.
        expect(() => html`<a\u00a0title="${'v'}">t</a>`).toThrow(/attribute name/);
        // An "=" with no attribute name waiting starts a name.
        expect(() => html`<a href="x" ="${'v'}">t</a>`).toThrow(/attribute name/);
        // "<!--<script>" inside a script keeps the next "</script>" from ending it.
        expect(() => html`<script><!--<script></script><p>${'v'}</p></script>`).toThrow(/inside a <script>/);
        // Title and textarea content is text: a quote or a "<" there opens nothing.
        expect(String(html`<title>a < b "${'<T>'}"</title><textarea>${'x'}</textarea>`)).toBe('<title>a < b "&lt;T&gt;"</title><textarea>x</textarea>');
    });

    it('refuses a template that ends inside markup it opened, since a template around it never reads it', () => {
        // Nested, the fragment's open tag would make the next interpolation an unquoted href.
        expect(() => html`${html`<a href=`}${'javascript:alert(1)'}>t</a>`).toThrow(/the template "<a href=" ends inside markup it opened/);
        expect(() => html`${html`<script>`}${'alert(1)'}</script>`).toThrow(/the template "<script>" ends inside markup/);
        expect(() => html`${html`<a title="x"`} ${'onclick=alert(1)'}>t</a>`).toThrow(/ends inside markup/);
        expect(() => html`<p>${'x'}<!-- note`).toThrow(/ends inside markup/);
        expect(() => xml`<title>${'x'}`).toThrow(/ends inside markup/);
        // Complete markup nests as before, an element left open included.
        expect(String(html`<p>${html`<b>${'x & y'}</b>`}</p>${html`<li>open`}`)).toBe('<p><b>x &amp; y</b></p><li>open');
    });

    it('refuses a value once inline SVG and MathML may read the template apart from plain HTML', () => {
        // Inside <svg> or <math>, text-only content holding a tag is markup,
        // and a CDATA section runs to "]]>" rather than to the first ">".
        expect(() => html`<svg><title><img src=x onerror="${'alert(1)'}"></title></svg>`)
            .toThrow(/the interpolation after "<svg><title><img src=x onerror=\\"" comes after <title> content that inline SVG and MathML read apart from plain HTML/);
        expect(() => html`<svg><title>Close</svg><a href="${'javascript:alert(1)'}">`).toThrow(/comes after <title> content/);
        expect(() => html`<svg><textarea><b>${'x'}</b></textarea></svg>`).toThrow(/comes after <textarea> content/);
        expect(() => html`<svg><![CDATA[ > <x title=" ]]><a href=${'javascript:alert(1)'}>`).toThrow(/comes after <!\[CDATA\[ \.\.\. \]\]> content/);
        expect(() => html`<svg><![CDATA[ ${'x'} ]]></svg>`).toThrow(/comes after <!\[CDATA\[/);
        // Past the element's end tag and past "]]>" too: one reading may still sit inside a tag there.
        expect(() => html`<svg><title><img title="</title><p class="${'src=x onerror=alert(1)//'}">`).toThrow(/comes after <title> content/);
        expect(() => html`<svg><![CDATA[ > <!-- ]]><a href=${'javascript:alert(1)'} x>t</a> -->`).toThrow(/comes after <!\[CDATA\[/);
        // An end tag other than the element's own is markup to them as well.
        expect(() => html`<svg><title></b x="</title><p title=" > <img src=x onerror=${'alert(1)//'}">`).toThrow(/comes after <title> content/);
        expect(() => html`<svg><title>a </ b ${'x'}</title></svg>`).toThrow(/comes after <title> content/);
        // So a fragment holding such content is not complete markup.
        expect(() => html`<svg><title><img title="</title>`).toThrow(/ends inside markup it opened.*or after content inline SVG and MathML read apart/);
        // Text in them, and a CDATA section that ends at its first ">", read alike both ways.
        expect(String(html`<title>${'<T>'}</title><textarea>${'a & b'}</textarea>`)).toBe('<title>&lt;T&gt;</title><textarea>a &amp; b</textarea>');
        expect(String(html`<svg><title>${'Chart'}</title><![CDATA[ x < y ]]><text>${'<3'}</text></svg>`))
            .toBe('<svg><title>Chart</title><![CDATA[ x < y ]]><text>&lt;3</text></svg>');
    });

    it('decides by the template whatever the value is, an empty one included', () => {
        for(const value of [null, undefined, false, '', 7, raw('x'), html`x`, ['a', 'b']]){
            expect(() => html`<div class=${value}></div>`, String(value)).toThrow(/unquoted attribute/);
            expect(() => html`<input ${value}>`, String(value)).toThrow(/attribute name/);
        }
    });

    describe('an interpolation in a URL attribute', () => {
        const link = (url: Parameters<typeof html>[1]) => String(html`<a href="${url}">x</a>`);
        const hrefOf = (rendered: string) => /href="([^"]*)"/.exec(rendered)![1];

        it('renders a scheme that runs code or carries a document as about:invalid', () => {
            // Regression: href="${user.website}" rendered javascript:alert(document.cookie).
            for(const url of [
                'javascript:alert(document.cookie)', 'JaVaScRiPt:alert(1)', '  javascript:alert(1)', 'java\tscript:alert(1)',
                '\njavascript:alert(1)', '\u0001javascript:alert(1)', 'javascript:alert(1)\n',
                'data:text/html,<script>alert(1)</script>', 'vbscript:msgbox(1)', 'file:///etc/passwd',
            ]){
                expect(hrefOf(link(url)), JSON.stringify(url)).toBe('about:invalid');
            }
            expect(String(html`<img src='${'javascript:alert(1)'}'>`)).toBe(`<img src='about:invalid'>`);
            expect(String(html`<img src='${'data:image/svg+xml,<svg onload=alert(1)>'}' alt="${'a'}">`)).toBe(`<img src='about:invalid' alt="a">`);
            const url = 'javascript:alert(1)';
            for(const rendered of [
                html`<form action="${url}"></form>`, html`<button formaction="${url}">x</button>`,
                html`<svg><a xlink:href="${url}">x</a></svg>`, html`<A HREF = "${url}">x</A>`,
            ]){
                expect(String(rendered)).toContain('"about:invalid"');
            }
        });

        it('passes http, https, mailto, tel and every relative URL', () => {
            expect(link('https://example.com/a?b=1&c=2')).toBe('<a href="https://example.com/a?b=1&amp;c=2">x</a>');
            for(const url of ['http://example.com', 'HTTPS://EXAMPLE.COM', 'mailto:ada@example.com', 'tel:+15551234567', '/users/7', 'users/7', '../up', '#top', '?page=2', '//cdn.example.com/app.js', 'a/b:c']){
                expect(hrefOf(link(url)), url).toBe(url);
            }
            expect(link(7)).toBe('<a href="7">x</a>');
            expect(link(null)).toBe('<a href="">x</a>');
            // Text and a non-URL attribute carry the same string as text.
            expect(String(html`<p title="${'javascript:alert(1)'}">${'javascript:alert(1)'}</p>`)).toBe('<p title="javascript:alert(1)">javascript:alert(1)</p>');
        });

        it('leaves a value whose scheme the template fixed before the interpolation', () => {
            expect(String(html`<a href="https://example.com/${'javascript:alert(1)'}">x</a>`)).toBe('<a href="https://example.com/javascript:alert(1)">x</a>');
            expect(String(html`<a href="/users/${'javascript:alert(1)'}">x</a>`)).toBe('<a href="/users/javascript:alert(1)">x</a>');
            expect(String(html`<a href="sms:${'+15551234567'}">x</a>`)).toBe('<a href="sms:+15551234567">x</a>');
            expect(String(html`<a href="#${'javascript:alert(1)'}">x</a>`)).toBe('<a href="#javascript:alert(1)">x</a>');
            expect(String(html`<img src="data:image/png;base64,${'iVBORw0KGgo='}">`)).toBe('<img src="data:image/png;base64,iVBORw0KGgo=">');
        });

        it('reads the value whole: a second interpolation and the text after one both count', () => {
            expect(hrefOf(String(html`<a href="${'javascript'}${':alert(1)'}">x</a>`))).toBe('about:invalid');
            expect(hrefOf(String(html`<a href="${'https://example.com'}${'/a'}">x</a>`))).toBe('https://example.com/a');
            expect(hrefOf(String(html`<a href="${'javascript'}://example.com/%0aalert(1)">x</a>`))).toBe('about:invalid');
            expect(hrefOf(String(html`<a href="${'https'}://example.com/%0aalert(1)">x</a>`))).toBe('https://example.com/%0aalert(1)');
            expect(hrefOf(String(html`<a href="${'javascript:alert(1)//'}?q=${'1&2'}">x</a>`))).toBe('about:invalid');
            expect(String(html`<a href="${'https://example.com'}?q=${'1&2'}" title="${'t'}">x</a><a href='${'javascript:alert(1)'}'>y</a>`))
                .toBe(`<a href="https://example.com?q=1&amp;2" title="t">x</a><a href='about:invalid'>y</a>`);
        });

        it('refuses a character reference where the scheme would be, whatever kind of value brought it', () => {
            // `&colon;` and `&#58;` are colons by the time the browser reads the URL.
            for(const url of [raw('javascript&colon;alert(1)'), raw('&#106;avascript:alert(1)'), raw('java&Tab;script:alert(1)'), html`javascript:${'alert(1)'}`]){
                expect(hrefOf(link(url))).toBe('about:invalid');
            }
            // Escaped plain text is text: an ampersand past the path's first delimiter is fine.
            expect(hrefOf(link('/search?q=Tom&Jerry'))).toBe('/search?q=Tom&amp;Jerry');
        });

        it('refuses a URL value that never closes', () => {
            expect(() => html`<a href="${'/x'}`).toThrow(/is inside a quoted href value that never closes/);
            expect(() => html`<a href="${'/x'}>x</a>${'y'}`).toThrow(/never closes/);
        });
    });

    it('builds sitemaps, feeds and SVG with xml', () => {
        const url = 'https://example.com/a?x=1&y=2';
        expect(String(xml`<?xml version="1.0" encoding="UTF-8"?><urlset><url><loc>${url}</loc><lastmod>${'2026-01-01'}</lastmod></url></urlset>`))
            .toBe('<?xml version="1.0" encoding="UTF-8"?><urlset><url><loc>https://example.com/a?x=1&amp;y=2</loc><lastmod>2026-01-01</lastmod></url></urlset>');
        expect(String(xml`<feed xmlns="http://www.w3.org/2005/Atom"><link href="${url}"/><link rel="alternate" type="text/html" href="${'http://example.com/'}"/><title>${'Tom & Jerry'}</title></feed>`))
            .toBe('<feed xmlns="http://www.w3.org/2005/Atom"><link href="https://example.com/a?x=1&amp;y=2"/><link rel="alternate" type="text/html" href="http://example.com/"/><title>Tom &amp; Jerry</title></feed>');
        expect(String(xml`<rss version="2.0"><channel><atom:link href="${url}" rel="self"/><item><link>${url}</link><enclosure url="${url}" length="${12}"/></item></channel></rss>`))
            .toBe('<rss version="2.0"><channel><atom:link href="https://example.com/a?x=1&amp;y=2" rel="self"/><item><link>https://example.com/a?x=1&amp;y=2</link><enclosure url="https://example.com/a?x=1&amp;y=2" length="12"/></item></channel></rss>');
        expect(String(xml`<svg viewBox="0 0 ${100} ${50}"><rect width="${40}" fill="${'#c00'}"/><use href="#${'icon'}"/><a xlink:href="${'javascript:alert(1)'}"><text x="${5}">${'<3'}</text></a></svg>`))
            .toBe('<svg viewBox="0 0 100 50"><rect width="40" fill="#c00"/><use href="#icon"/><a xlink:href="about:invalid"><text x="5">&lt;3</text></a></svg>');
        // SVG runs script too, so the handler and script rules stand for xml.
        expect(() => xml`<svg onload="${'alert(1)'}"></svg>`).toThrow(/onload attribute.*JavaScript/);
        expect(() => xml`<svg><script>${'alert(1)'}</script></svg>`).toThrow(/inside a <script>/);
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

    /**
     * Only `undefined`, or a key the data does not carry, keeps the default.
     * An app writing `{ title: page.seoTitle }` with a seoTitle that came back
     * null from the database ships an empty title, not the shell's own.
     */
    it('keeps a slot default only for undefined, and renders null, false and the empty string empty', () => {
        const template = new LambderTemplatingEngine('<title><!--slot:title-->Default<!--/slot:title--></title>');

        expect(template.render({})).toBe('<title>Default</title>');
        expect(template.render({ title: undefined })).toBe('<title>Default</title>');
        expect(template.render({ title: null })).toBe('<title></title>');
        expect(template.render({ title: false })).toBe('<title></title>');
        expect(template.render({ title: '' })).toBe('<title></title>');
    });

    it('reads a condition named for an Object.prototype member as data, not as true', () => {
        const template = new LambderTemplatingEngine('<!--if:toString-->shown<!--else-->hidden<!--/if:toString-->');

        expect(template.render({})).toBe('hidden');
        expect(template.render({ toString: true })).toBe('shown');
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

    it('rejects an unquoted attribute value with a prefix before the slot, and nothing quoted', () => {
        // A space in the value would start a new attribute: " onmouseover=...".
        expect(() => new LambderTemplatingEngine('<div class=big-<!--slot:cls/-->></div>'))
            .toThrow(/unquoted attribute/);
        expect(() => new LambderTemplatingEngine('<a id="x" href=/users/<!--slot:id/-->>link</a>'))
            .toThrow(/unquoted attribute/);
        // Inside quotes, an "=" in the value is only text.
        expect(() => new LambderTemplatingEngine('<a title="a=b <!--slot:t/-->">x</a>')).not.toThrow();
        expect(() => new LambderTemplatingEngine("<a title='x=<!--slot:t/-->'>x</a>")).not.toThrow();
        // After the tag closes, the slot is text content, where escaping works.
        expect(() => new LambderTemplatingEngine('<p class=lead>total: <!--slot:t/--></p>')).not.toThrow();
    });

    it('reads past the template\'s own tokens inside a tag', () => {
        // The ">" that ends <!--if:checked--> is not the tag's end: the value
        // after it is still unquoted, and "x autofocus onfocus=..." would be
        // three attributes.
        expect(() => new LambderTemplatingEngine('<input type="checkbox" <!--if:checked-->checked<!--/if:checked--> value=<!--slot:v/-->>'))
            .toThrow(/unquoted attribute/);
        expect(() => new LambderTemplatingEngine('<input <!--if:on-->checked<!--/if:on--> value="<!--slot:v/-->">')).not.toThrow();
    });

    it('rejects a slot where an attribute name goes', () => {
        expect(() => new LambderTemplatingEngine('<input <!--slot:attrs/-->>')).toThrow(/attribute name/);
        // Or the tag's own name, where the value would carry the attributes.
        expect(() => new LambderTemplatingEngine('<<!--slot:tag/-->>')).toThrow(/attribute name/);
        expect(() => new LambderTemplatingEngine('<!--if:a--><<!--/if:a--><!--slot:y/-->')).toThrow(/attribute name/);
        expect(() => new LambderTemplatingEngine('<div class="a" <!--slot:attrs-->data-x="1"<!--/slot:attrs-->></div>')).toThrow(/attribute name/);
        // A whole-tag variant is the way to vary attributes.
        expect(() => new LambderTemplatingEngine('<!--if:on--><input checked><!--else--><input><!--/if:on-->')).not.toThrow();
    });

    it('rejects slots inside script and style elements at compile time', () => {
        expect(() => new LambderTemplatingEngine('<script>var x = "<!--slot:v/-->";</script>'))
            .toThrow(/inside a <script>/);
        expect(() => new LambderTemplatingEngine('<style>.a { color: <!--slot:c/-->; }</style>'))
            .toThrow(/inside a <style>/);
        // After the element closes, slots are fine again.
        expect(() => new LambderTemplatingEngine('<script>var x = 1;</script><!--slot:after/-->')).not.toThrow();
    });

    it('reads script and style content as raw text, up to the element\'s own end tag', () => {
        // A "<" and a quote inside the script open no tag and no value, so the
        // unquoted slot after the script is still seen for what it is.
        expect(() => new LambderTemplatingEngine(`<script>var s = "a<b title='";</script><div class=<!--slot:v/-->></div>`))
            .toThrow(/unquoted attribute/);
        // </scripts> is not the script's end tag.
        expect(() => new LambderTemplatingEngine('<script>var s = 1;</scripts><p><!--slot:v/--></p></script>')).toThrow(/inside a <script>/);
        // A mention in a comment or a value, or a name that starts the same, opens no element.
        expect(() => new LambderTemplatingEngine('<!-- <script> --><a title="<style>"><!--slot:v/--></a><style-box><!--slot:w/--></style-box>')).not.toThrow();
    });

    it('rejects a slot in the quoted value of an event handler, style or srcdoc at compile time', () => {
        // Regression: the browser decodes the HTML escapes before it runs a
        // handler, so `');alert(1);//` in onclick="go('<!--slot:x/-->')" ran;
        // style is read as CSS, and srcdoc runs its script in a same-origin frame.
        expect(() => new LambderTemplatingEngine(`<button onclick="go('<!--slot:x/-->')">Go</button>`))
            .toThrow(/slot "x" is inside the onclick attribute, whose value the browser reads as JavaScript/);
        expect(() => new LambderTemplatingEngine(`<a href="/" ONMOUSEOVER='<!--slot:x/-->'>x</a>`)).toThrow(/onmouseover attribute.*JavaScript/);
        expect(() => new LambderTemplatingEngine('<div style="color: <!--slot:c/-->">x</div>')).toThrow(/style attribute.*CSS/);
        expect(() => new LambderTemplatingEngine('<iframe srcdoc="<!--slot:doc-->x<!--/slot:doc-->"></iframe>')).toThrow(/srcdoc attribute.*an HTML document/);
        // Past the handler's value, or in another attribute, the slot is text again.
        expect(() => new LambderTemplatingEngine('<button onclick="go()" title="<!--slot:t/-->">Go</button>')).not.toThrow();
        expect(() => new LambderTemplatingEngine('<a data-onclick="x" title="onclick <!--slot:t/-->">x</a>')).not.toThrow();
        expect(() => new LambderTemplatingEngine('<p>style="<!--slot:t/-->"</p>')).not.toThrow();
    });

    describe('the branches of a block', () => {
        it('refuses a slot whose position depends on which branch rendered', () => {
            // Run together, the branches' text reads as one attribute name
            // ("titleonclick", "hrefdata-lang") that is neither refused nor
            // checked, while the else branch renders a live onclick and the
            // then branch an unchecked href.
            expect(() => new LambderTemplatingEngine('<a <!--if:x-->title<!--else-->onclick<!--/if:x-->="<!--slot:v/-->">t</a>'))
                .toThrow(/slot "v" comes after <!--if:x-->, whose branches leave the template in different positions: the slot is in the quoted title value after one, in the quoted onclick value after the other\. Vary the whole tag or element inside the branches instead/);
            expect(() => new LambderTemplatingEngine('<a <!--if:x-->href<!--else-->data-lang<!--/if:x-->="<!--slot:u/-->">t</a>'))
                .toThrow(/in the quoted href value after one, in the quoted data-lang value after the other/);
            expect(() => new LambderTemplatingEngine('<a <!--if:x-->href<!--else-->data-lang<!--/if:x--> ="<!--slot:u/-->">t</a>'))
                .toThrow(/in the quoted href value after one, in the quoted data-lang value after the other/);
            // A missing else is an empty branch.
            expect(() => new LambderTemplatingEngine('<a <!--if:x-->onclick<!--/if:x-->="<!--slot:v/-->">t</a>'))
                .toThrow(/in the quoted onclick value after one, inside a tag where an attribute name goes after the other/);
            // Outside a tag too: one branch opens a script the other's text closes.
            expect(() => new LambderTemplatingEngine('<!--if:x--><script><!--else-->x</script><!--/if:x--><!--slot:v/-->'))
                .toThrow(/slot "v" comes after <!--if:x-->.*inside a <script> element after one, in text after the other/);
        });

        it('reads a slot\'s default content as one branch, and the value as the other', () => {
            // With a value for t, the comment the default opens is not
            // there, and the title v sits in is unquoted.
            expect(() => new LambderTemplatingEngine('<!--slot:t--><!--<!--/slot:t--> <a title=<!--slot:v/-->>t</a> -->'))
                .toThrow(/slot "v" comes after <!--slot:t-->, whose branches leave the template in different positions: the slot is in a comment after one, in the unquoted title value after the other/);
            expect(new LambderTemplatingEngine('<p><!--slot:t--><b>Default</b><!--/slot:t--> <!--slot:v/--></p>').render({ v: '<v>' })).toBe('<p><b>Default</b> &lt;v&gt;</p>');
        });

        it('refuses the next block while the branches before it have not met again', () => {
            expect(() => new LambderTemplatingEngine('<input<!--if:a--> checked<!--/if:a--><!--if:b--> disabled<!--/if:b-->>'))
                .toThrow(/the branches of <!--if:a--> leave the template in different positions, and <!--if:b--> comes before they meet again/);
            // Nested blocks are read the same way, inside their own branch.
            expect(() => new LambderTemplatingEngine('<a <!--if:x--><!--if:y-->title<!--else-->onclick<!--/if:y--><!--else-->alt<!--/if:x-->="<!--slot:v/-->">t</a>'))
                .toThrow(/the branches of <!--if:y--> leave the template in different positions, and <!--else--> comes before they meet again/);
            // Branches joined between attributes whose last names differ: an "=" next gives each of them a different attribute.
            expect(() => new LambderTemplatingEngine('<a <!--if:x-->href <!--else-->title <!--/if:x--><!--if:y--><!--/if:y-->="<!--slot:u/-->">t</a>'))
                .toThrow(/the branches of <!--if:x--> end after different attribute names, and the "=" after them would give its value to a different attribute in each/);
        });

        it('keeps branches that end at the same position compiling', () => {
            const converging = new LambderTemplatingEngine('<!--if:x--><b>a</b><!--else--><i>b</i><!--/if:x--> <!--slot:v/-->');
            expect(converging.render({ x: true, v: '<v>' })).toBe('<b>a</b> &lt;v&gt;');
            expect(converging.render({ v: '<v>' })).toBe('<i>b</i> &lt;v&gt;');
            // A conditional boolean attribute: after the space both branches are between attributes.
            const checkbox = new LambderTemplatingEngine('<input <!--if:x-->checked<!--/if:x--> name="a">');
            expect(checkbox.render({ x: true })).toBe('<input checked name="a">');
            expect(checkbox.render({})).toBe('<input  name="a">');
            // Not when an "=" follows the name: the value would belong to "checked" in one branch only.
            expect(() => new LambderTemplatingEngine('<input <!--if:x-->checked<!--/if:x-->="<!--slot:v/-->">'))
                .toThrow(/in the quoted checked value after one, inside a tag where an attribute name goes after the other/);
            const flags = new LambderTemplatingEngine('<input type="checkbox" <!--if:checked-->checked<!--/if:checked--> <!--if:disabled-->disabled <!--/if:disabled-->name="<!--slot:n/-->">');
            expect(flags.render({ checked: true, disabled: true, n: 'a b' })).toBe('<input type="checkbox" checked disabled name="a b">');
            expect(flags.render({ n: 'c' })).toBe('<input type="checkbox"  name="c">');
            // Branches that differ only in a tag name whose content is ordinary markup meet at once.
            const tags = new LambderTemplatingEngine('<!--if:x--><!--if:y--><a <!--else--><b <!--/if:y-->title="<!--slot:v/-->"><!--/if:x-->');
            expect(tags.render({ x: true, y: true, v: '1' })).toBe('<a title="1">');
            expect(tags.render({ x: true, v: '2' })).toBe('<b title="2">');
        });
    });

    describe('reading the HTML a slot sits in', () => {
        it('ends a comment where the browser does: at <!-->, <!---> and --!>', () => {
            // Each of these ends the comment in a browser, so the unquoted
            // title after it would be a live attribute list.
            for(const comment of ['<!-->', '<!--->', '<!-- c --!>']){
                expect(() => new LambderTemplatingEngine(`${comment}<a title=<!--slot:v/-->>t</a>`), comment)
                    .toThrow(/slot "v" is in an unquoted attribute position/);
            }
        });

        it('keeps a value inside a comment escaped, and refuses one whose end could close the comment', () => {
            expect(new LambderTemplatingEngine('<!-- <!--slot:v/--> -->').render({ v: '--><script>alert(1)</script>' }))
                .toBe('<!-- --&gt;&lt;script&gt;alert(1)&lt;/script&gt; -->');
            // A value of "--" ends the comment at the template's ">", and the
            // unquoted title after it renders live.
            expect(() => new LambderTemplatingEngine('<!-- <!--slot:c/-->> <p title=<!--slot:v/-->>t</p> -->'))
                .toThrow(/slot "c" is inside a comment, right before text that ends the comment or not depending on how the value ends.*Put a space after the slot/);
            const tight = new LambderTemplatingEngine('<!--<!--slot:c/-->-->');
            expect(tight.render({ c: 'x' })).toBe('<!--x-->');
            expect(tight.render({ c: '--' })).toBe('<!------>');
        });

        it('reads end tags, bogus comments, title and textarea content and script escapes the way a browser does', () => {
            // In each of these the browser has left the quote a reading that
            // skips end tags, bogus comments or title text would still be in,
            // so the title after it is unquoted.
            for(const template of [
                '</x a="<y b="><p title=<!--slot:v/-->>t</p>', '<!x <a title="><p title=<!--slot:v/-->>t</p>', '<?x <a title="><p title=<!--slot:v/-->>t</p>',
                '<title>a title="</title><p title=<!--slot:v/-->>t</p>', '<textarea>a title="</textarea><p title=<!--slot:v/-->>t</p>',
            ]){
                expect(() => new LambderTemplatingEngine(template), template).toThrow(/unquoted attribute/);
            }
            for(const template of ['<a\u00a0title="<!--slot:v/-->">t</a>', '<a href="x" ="<!--slot:v/-->">t</a>', '<a href/="<!--slot:v/-->">t</a>', '</<!--slot:v/-->>']){
                expect(() => new LambderTemplatingEngine(template), template).toThrow(/slot "v" is inside a tag where an attribute name goes/);
            }
            expect(() => new LambderTemplatingEngine('<script><!--<script></script><p><!--slot:v/--></p></script>')).toThrow(/inside a <script>/);
            expect(new LambderTemplatingEngine('<title>a < b "<!--slot:t/-->"</title>').render({ t: '<T>' })).toBe('<title>a < b "&lt;T&gt;"</title>');
        });

        it('refuses a slot once inline SVG and MathML may read the template apart from plain HTML', () => {
            for(const template of [
                '<svg><title><img src=x onerror="<!--slot:v/-->"></title></svg>',
                '<svg><title><img title="</title><p class="<!--slot:v/-->">',
                '<svg><![CDATA[ > <x title=" ]]><a href=<!--slot:v/-->>',
                '<svg><![CDATA[ <!--slot:v/--> ]]></svg>',
            ]){
                expect(() => new LambderTemplatingEngine(template), template).toThrow(/slot "v" is inside a <(title|!\[CDATA\[ \.\.\. \]\])> element/);
            }
            // Branches that part the readings in one only never join again.
            for(const template of [
                '<svg><title><!--if:x--><img title="<!--else-->x<!--/if:x--></title><p class="<!--slot:v/-->">',
                '<svg><title><!--if:x-->x<!--else--><img title="<!--/if:x--></title><p class="<!--slot:v/-->">',
            ]){
                expect(() => new LambderTemplatingEngine(template), template).toThrow(/slot "v" comes after <!--if:x-->, whose branches leave the template in different positions/);
            }
            expect(new LambderTemplatingEngine('<title><!--slot:t-->Default<!--/slot:t--></title><textarea><!--slot:body/--></textarea>').render({ t: '<T>', body: 'a & b' }))
                .toBe('<title>&lt;T&gt;</title><textarea>a &amp; b</textarea>');
        });
    });

    describe('a slot in a URL attribute', () => {
        const link = new LambderTemplatingEngine('<a href="<!--slot:url/-->">x</a>');
        const hrefOf = (rendered: string) => /href="([^"]*)"/.exec(rendered)![1];

        it('renders a scheme that runs code or carries a document as about:invalid', () => {
            // Regression: href="<!--slot:u/-->" rendered javascript:alert(document.cookie).
            for(const url of [
                'javascript:alert(1)', 'JaVaScRiPt:alert(1)', '  javascript:alert(1)', 'java\tscript:alert(1)',
                '\njavascript:alert(1)', '\u0001javascript:alert(1)', 'javascript:alert(1)\n',
                'data:text/html,<script>alert(1)</script>', 'vbscript:msgbox(1)', 'file:///etc/passwd',
            ]){
                expect(hrefOf(link.render({ url })), JSON.stringify(url)).toBe('about:invalid');
            }
            const image = new LambderTemplatingEngine(`<img src='<!--slot:src/-->'>`);
            expect(image.render({ src: 'javascript:alert(1)' })).toBe(`<img src='about:invalid'>`);
            expect(image.render({ src: 'data:image/svg+xml,<svg onload=alert(1)>' })).toBe(`<img src='about:invalid'>`);
            for(const template of ['<form action="<!--slot:url/-->"></form>', '<button formaction="<!--slot:url/-->">x</button>', '<svg><a xlink:href="<!--slot:url/-->">x</a></svg>', '<A HREF = "<!--slot:url/-->">x</A>']){
                expect(new LambderTemplatingEngine(template).render({ url: 'javascript:alert(1)' }), template).toContain('"about:invalid"');
            }
        });

        it('passes http, https, mailto, tel and every relative URL', () => {
            expect(link.render({ url: 'https://example.com/a?b=1&c=2' })).toBe('<a href="https://example.com/a?b=1&amp;c=2">x</a>');
            for(const url of ['http://example.com', 'HTTPS://EXAMPLE.COM', 'mailto:ada@example.com', 'tel:+15551234567', '/users/7', 'users/7', '../up', '#top', '?page=2', '//cdn.example.com/app.js', 'a/b:c']){
                expect(hrefOf(link.render({ url })), url).toBe(url);
            }
            // A number, the default content, and no value at all are the template's or plain text.
            expect(new LambderTemplatingEngine('<a href="<!--slot:url-->/home<!--/slot:url-->">x</a>').render({})).toBe('<a href="/home">x</a>');
            expect(link.render({ url: 7 })).toBe('<a href="7">x</a>');
            expect(link.render({})).toBe('<a href="">x</a>');
            // A non-URL attribute carries the text as text.
            expect(new LambderTemplatingEngine('<a title="<!--slot:t/-->">x</a>').render({ t: 'javascript:alert(1)' })).toBe('<a title="javascript:alert(1)">x</a>');
        });

        it('leaves a value whose scheme the template fixed before the slot', () => {
            expect(new LambderTemplatingEngine('<a href="/users/<!--slot:id/-->">x</a>').render({ id: 'javascript:alert(1)' }))
                .toBe('<a href="/users/javascript:alert(1)">x</a>');
            expect(new LambderTemplatingEngine('<a href="sms:<!--slot:n/-->">x</a>').render({ n: '+15551234567' }))
                .toBe('<a href="sms:+15551234567">x</a>');
            expect(new LambderTemplatingEngine('<a href="#<!--slot:anchor/-->">x</a>').render({ anchor: 'javascript:alert(1)' }))
                .toBe('<a href="#javascript:alert(1)">x</a>');
        });

        it('reads the value whole: other slots, the text after the slot and the branch that rendered all count', () => {
            const split = new LambderTemplatingEngine('<a href="<!--slot:first/--><!--slot:rest/-->">x</a>');
            expect(hrefOf(split.render({ first: 'javascript', rest: ':alert(1)' }))).toBe('about:invalid');
            expect(hrefOf(split.render({ first: 'https://example.com', rest: '/a' }))).toBe('https://example.com/a');
            const scheme = new LambderTemplatingEngine('<a href="<!--slot:scheme/-->://example.com/%0aalert(1)">x</a>');
            expect(hrefOf(scheme.render({ scheme: 'javascript' }))).toBe('about:invalid');
            expect(hrefOf(scheme.render({ scheme: 'https' }))).toBe('https://example.com/%0aalert(1)');
            // The fixed text sits in a branch: only the branch that rendered fixes anything.
            const branch = new LambderTemplatingEngine('<a href="<!--if:local-->/<!--/if:local--><!--slot:url/-->">x</a>');
            expect(hrefOf(branch.render({ local: true, url: 'javascript:alert(1)' }))).toBe('/javascript:alert(1)');
            expect(hrefOf(branch.render({ local: false, url: 'javascript:alert(1)' }))).toBe('about:invalid');
            expect(branch.slotNames).toEqual(['url']);
            expect(branch.conditionNames).toEqual(['local']);
        });

        it('refuses a character reference where the scheme would be, whatever kind of value brought it', () => {
            // `&colon;` and `&#58;` are colons by the time the browser reads the URL.
            for(const url of [raw('javascript&colon;alert(1)'), raw('&#106;avascript:alert(1)'), raw('java&Tab;script:alert(1)'), html`javascript:${'alert(1)'}`]){
                expect(hrefOf(link.render({ url }))).toBe('about:invalid');
            }
            // Escaped plain text is text: an ampersand past the path's first delimiter is fine.
            expect(hrefOf(link.render({ url: '/search?q=Tom&Jerry' }))).toBe('/search?q=Tom&amp;Jerry');
        });

        it('refuses a block that opens on one side of the value and closes on the other', () => {
            expect(() => new LambderTemplatingEngine('<!--if:a--><a href="<!--slot:u/--><!--/if:a-->">x</a>'))
                .toThrow(/<!--\/if:a--> belongs to a block opened outside the quoted href value/);
            expect(() => new LambderTemplatingEngine('<a href="<!--slot:u/--><!--if:a-->">x</a><!--/if:a-->'))
                .toThrow(/<!--if:a--> opens inside a quoted href value holding a slot and closes outside it/);
            expect(() => new LambderTemplatingEngine('<a href="<!--slot:u/-->')).toThrow(/never closes/);
            // Whole-tag variants around the value, and blocks inside it, both nest.
            expect(() => new LambderTemplatingEngine('<!--if:a--><a href="<!--slot:u/-->">x</a><!--else--><a href="/">x</a><!--/if:a-->')).not.toThrow();
            expect(() => new LambderTemplatingEngine('<a href="<!--if:a--><!--slot:u/--><!--else-->/<!--/if:a-->">x</a>')).not.toThrow();
        });
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

