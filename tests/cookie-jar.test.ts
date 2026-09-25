/**
 * LambderCookieJar as a browser's cookie storage: which Set-Cookie a jar
 * accepts from a given host, which of them a later request carries, and what
 * keeps two hosts' cookies apart. The transports that drive a jar are covered
 * in transports.test.ts; this is the storage itself.
 *
 * Domain matching is the part worth a table. A jar that believes a Domain
 * attribute hands one host's session to another: a cross-host leak in the
 * component whose job is to prevent them.
 */

import { describe, it, expect } from 'vitest';
import { LambderCookieJar, parseSetCookie } from '../src/shared/transport/LambderCookieJar.js';

describe('A Domain attribute is only kept when the sending host is under it', () => {
    const cases: { case: string; sentBy: string; header: string; kept: boolean }[] = [
        { case: 'the sending host itself', sentBy: 'app.example.com', header: 'a=1; Domain=app.example.com', kept: true },
        { case: 'a parent domain of the sender', sentBy: 'app.example.com', header: 'a=1; Domain=example.com', kept: true },
        { case: 'a leading dot, which names the same domain', sentBy: 'app.example.com', header: 'a=1; Domain=.example.com', kept: true },
        { case: 'the sender in another case', sentBy: 'App.Example.COM', header: 'a=1; Domain=EXAMPLE.com', kept: true },
        { case: 'a sibling subdomain', sentBy: 'evil.example.com', header: 'a=1; Domain=bank.example.com', kept: false },
        { case: 'a host that is not the sender at all', sentBy: 'attacker.test', header: 'a=1; Domain=victim.test', kept: false },
        { case: 'a domain the sender only ends with, without the dot', sentBy: 'notexample.com', header: 'a=1; Domain=example.com', kept: false },
        { case: 'a registry suffix every site sits under', sentBy: 'shop.com', header: 'a=1; Domain=com', kept: false },
        // localhost is a special-use name rather than a registry suffix, and
        // a cookie scoped to it is what a local dev setup actually runs on.
        { case: 'localhost, which is special-use rather than a public suffix', sentBy: 'localhost', header: 'a=1; Domain=localhost', kept: true },
        { case: 'a domain on an IP literal, which has no domain tree', sentBy: '10.0.0.1', header: 'a=1; Domain=0.0.1', kept: false },
        // An IP host has no domain tree to scope to, so a Domain on one is
        // refused outright rather than quietly downgraded. The same cookie
        // without a Domain is kept, host-only, which is the working spelling.
        { case: 'a Domain on the IP literal that sent it', sentBy: '10.0.0.1', header: 'a=1; Domain=10.0.0.1', kept: false },
        { case: 'a cookie with no Domain from an IP literal', sentBy: '10.0.0.1', header: 'a=1', kept: true },
        { case: 'a cookie with no Domain at all', sentBy: 'app.example.com', header: 'a=1', kept: true },
    ];

    for(const { case: description, sentBy, header, kept } of cases){
        it(`${kept ? 'keeps' : 'refuses'} ${description}`, () => {
            const jar = new LambderCookieJar();
            jar.storeSetCookies([header], { host: sentBy });
            expect(jar.size).toBe(kept ? 1 : 0);
        });
    }

    it('refuses a Domain it has no host to check against, rather than trusting it', () => {
        // A jar nobody told a host to cannot run the check at all, and taking
        // the attribute at its word there is the same defect with the evidence
        // missing. The jar's own host, or the transport's, is how to keep them.
        const blind = new LambderCookieJar();
        blind.storeSetCookies(['sid=1; Domain=example.com; Path=/']);
        expect(blind.size).toBe(0);

        const known = new LambderCookieJar({ host: 'app.example.com' });
        known.storeSetCookies(['sid=1; Domain=example.com; Path=/']);
        expect(known.cookiePairs({ host: 'other.example.com' })).toEqual(['sid=1']);
    });

    it('refuses a multi-label public suffix, which needs the suffix list to recognise', () => {
        // co.uk passes every rule that can be applied by counting labels, so a
        // jar without the public suffix list either trusts it or bans every
        // two-label domain. This is the reason the matching rules are
        // tough-cookie's: the list is a data set to keep current, not a rule to
        // write.
        const jar = new LambderCookieJar();
        jar.storeSetCookies(['tracker=1; Domain=co.uk; Path=/'], { host: 'shop.co.uk' });
        expect(jar.cookiePairs({ host: 'bank.co.uk' })).toEqual([]);

        // The site under it is still a site.
        jar.storeSetCookies(['real=1; Domain=shop.co.uk; Path=/'], { host: 'www.shop.co.uk' });
        expect(jar.cookiePairs({ host: 'www.shop.co.uk' })).toEqual(['real=1']);
    });
});

describe('Where an accepted cookie then travels', () => {
    const jarWithScopes = () => {
        const jar = new LambderCookieJar();
        jar.storeSetCookies([
            'wide=1; Domain=example.com; Path=/',
            'admin=1; Path=/admin',
            'hostonly=1; Path=/',
        ], { host: 'app.example.com' });
        return jar;
    };

    it('sends a Domain cookie to the domain and under it, and a host-only cookie only home', () => {
        const jar = jarWithScopes();
        // Not sorted by the test: the order is the jar's answer, RFC 6265
        // section 5.4 order, longest Path first and then oldest first.
        expect(jar.cookiePairs({ host: 'app.example.com', path: '/api' })).toEqual(['wide=1', 'hostonly=1']);
        expect(jar.cookiePairs({ host: 'app.example.com', path: '/admin/users' })).toEqual(['admin=1', 'wide=1', 'hostonly=1']);
        // A sibling host under the same domain gets the Domain cookie only.
        expect(jar.cookiePairs({ host: 'other.example.com', path: '/api' })).toEqual(['wide=1']);
        // The apex gets it too, since the cookie names the apex.
        expect(jar.cookiePairs({ host: 'example.com', path: '/api' })).toEqual(['wide=1']);
        // An unrelated host gets nothing, port and case notwithstanding.
        expect(jar.cookiePairs({ host: 'evil.test:8443', path: '/api' })).toEqual([]);
        expect(jar.cookiePairs({ host: 'APP.example.com', path: '/api' })).toEqual(['wide=1', 'hostonly=1']);
    });

    it('hands everything over to a caller that says nothing about where it is going', () => {
        // One host is the whole world of a jar that never learned a host, and
        // that is the jar an in-process or mock transport gets.
        expect(jarWithScopes().cookiePairs().length).toBe(3);
    });

    it('answers a token read with the cookie that call would carry, not another host\'s', () => {
        const jar = new LambderCookieJar();
        jar.storeSetCookies(['CSRF=from-a'], { host: 'a.test' });
        jar.storeSetCookies(['CSRF=from-b'], { host: 'b.test' });
        expect(jar.get('CSRF', { host: 'b.test' })).toBe('from-b');
        expect(jar.get('CSRF', { host: 'c.test' })).toBeUndefined();
    });

    it('withholds a Secure cookie from a target known to speak plain http, and carries it otherwise', () => {
        const jar = new LambderCookieJar();
        jar.storeSetCookies(['sid=1; Path=/; Secure', 'plain=1; Path=/'], { host: 'app.test' });
        expect(jar.cookiePairs({ host: 'app.test', secure: false })).toEqual(['plain=1']);
        expect(jar.cookiePairs({ host: 'app.test', secure: true })).toEqual(['sid=1', 'plain=1']);
        // An in-process or mock target has no channel to be insecure on, and
        // withholding there would strand every session cookie a server marks
        // Secure, which is all of them under a secure-session config.
        expect(jar.cookiePairs({ host: 'app.test' })).toEqual(['sid=1', 'plain=1']);
    });

    it('refuses a Secure cookie from a plain-http answer, rather than keeping one it will never send', () => {
        // Storing and sending both read the target's own scheme. Judging the
        // set as https whatever the target said would store a Secure cookie
        // from an http answer and then withhold it from every call: a session
        // the jar holds but can never use, silently.
        const jar = new LambderCookieJar();
        jar.storeSetCookies(['sid=1; Path=/; Secure', 'plain=1; Path=/'], { host: 'localhost', secure: false });
        expect(jar.list().map((cookie) => cookie.name)).toEqual(['plain']);
        expect(jar.cookiePairs({ host: 'localhost', secure: false })).toEqual(['plain=1']);

        // The same answer over https is kept, which is the ordinary case.
        const secureJar = new LambderCookieJar();
        secureJar.storeSetCookies(['sid=1; Path=/; Secure'], { host: 'localhost', secure: true });
        expect(secureJar.cookiePairs({ host: 'localhost', secure: true })).toEqual(['sid=1']);
    });

    it('defaults a Path-less cookie to the directory it was set from, as RFC 6265 does', () => {
        const jar = new LambderCookieJar();
        jar.storeSetCookies(['sid=1'], { host: 'app.test', path: '/v1/api' });
        expect(parseSetCookie('sid=1', Date.now(), '/v1/api')?.path).toBe('/v1');
        expect(jar.cookiePairs({ host: 'app.test', path: '/v1/api' })).toEqual(['sid=1']);
        // "/" is only right for a request whose path has no directory, and
        // taking it for every request is how a cookie set by one mounted app
        // gets sent to another on the same host.
        expect(jar.cookiePairs({ host: 'app.test', path: '/v2/api' })).toEqual([]);
        expect(parseSetCookie('sid=1', Date.now(), '/api')?.path).toBe('/');
    });
});

describe('The attributes a browser enforces on the way in', () => {
    it('keeps a __Secure- cookie only when it is Secure, and a __Host- one only when it is host-only at the root', () => {
        // The prefixes are a server telling a browser "refuse this cookie
        // unless it was set the way I say", which is what makes them worth
        // anything against a sibling host that can write cookies.
        const jar = new LambderCookieJar();
        jar.storeSetCookies([
            '__Secure-good=1; Path=/; Secure',
            '__Secure-bad=1; Path=/',
            '__Host-good=1; Path=/; Secure',
            '__Host-domain=1; Path=/; Secure; Domain=example.com',
            '__Host-subpath=1; Path=/admin; Secure',
            '__Host-insecure=1; Path=/',
        ], { host: 'app.example.com' });

        expect(jar.list().map((cookie) => cookie.name).sort()).toEqual(['__Host-good', '__Secure-good']);
    });

    it('measures Max-Age from when the cookie arrived, and lets it beat an Expires beside it', () => {
        // Max-Age wins over Expires, and it is counted from the moment the
        // header arrived. Reading the Expires field alone would call a
        // Max-Age=0 deletion immortal and a Max-Age refresh already dead.
        // The clock starts at the real time because tough-cookie's own expiry
        // check reads the real clock.
        let now = Date.now();
        const jar = new LambderCookieJar({ now: () => now, host: 'app.test' });
        const longAgo = new Date(now - 60_000).toUTCString();
        jar.storeSetCookies([`sid=1; Path=/; Max-Age=60; Expires=${longAgo}`]);

        expect(jar.cookiePairs()).toEqual(['sid=1']);
        expect(parseSetCookie(`sid=1; Path=/; Max-Age=60; Expires=${longAgo}`, now)?.expires).toBe(now + 60_000);

        // Moving the injected clock past the Max-Age expires the cookie
        // without any real time passing.
        now += 59_000;
        expect(jar.cookiePairs()).toEqual(['sid=1']);
        now += 2_000;
        expect(jar.cookiePairs()).toEqual([]);
        expect(jar.size).toBe(0);
    });
});

describe('What tells two stored cookies apart', () => {
    it('keeps two hosts\' host-only cookies of the same name apart', () => {
        // Keyed on name, domain and path alone, b.test's login would
        // overwrite a.test's, signing a.test out and leaving its one jar
        // entry holding another host's session.
        const jar = new LambderCookieJar();
        jar.storeSetCookies(['sid=a; Path=/'], { host: 'a.test' });
        jar.storeSetCookies(['sid=b; Path=/'], { host: 'b.test' });

        expect(jar.size).toBe(2);
        expect(jar.cookiePairs({ host: 'a.test' })).toEqual(['sid=a']);
        expect(jar.cookiePairs({ host: 'b.test' })).toEqual(['sid=b']);
    });

    it('replaces, and deletes, only the cookie of the very same scope', () => {
        const jar = new LambderCookieJar();
        jar.storeSetCookies(['sid=first; Path=/'], { host: 'a.test' });
        jar.storeSetCookies(['sid=second; Path=/'], { host: 'a.test' });
        expect(jar.cookiePairs({ host: 'a.test' })).toEqual(['sid=second']);

        jar.storeSetCookies(['sid=x; Path=/'], { host: 'b.test' });
        jar.storeSetCookies(['sid=; Max-Age=0; Path=/'], { host: 'a.test' });
        expect(jar.cookiePairs({ host: 'a.test' })).toEqual([]);
        expect(jar.cookiePairs({ host: 'b.test' })).toEqual(['sid=x']);
    });

    it('cannot have one cookie\'s key spell another\'s, because a name and a path may hold the separator', () => {
        // Deliberately hostile, and legal: "|" is allowed in both fields, so
        // an unescaped join makes these two the same key and the second
        // silently replaces the first.
        const jar = new LambderCookieJar();
        jar.storeSetCookies(['a=1; Path=|||/b']);
        jar.storeSetCookies(['a|||=2; Path=/b']);
        expect(jar.size).toBe(2);
    });
});

describe('Parsing, replacing, expiring and hiding cookies', () => {
    it('parses Set-Cookie the way a browser reads it', () => {
        const now = Date.parse('2030-01-01T00:00:00Z');
        expect(parseSetCookie('a=1; Path=/x; Domain=.example.com; HttpOnly; Secure; SameSite=Lax', now)).toEqual({ name: 'a', value: '1', domain: 'example.com', path: '/x', expires: undefined, httpOnly: true, secure: true });
        expect(parseSetCookie('b=2; Max-Age=10; Expires=Thu, 01 Jan 1970 00:00:00 GMT', now)?.expires).toBe(now + 10_000);
        expect(parseSetCookie('c=3; Expires=Thu, 01 Jan 1970 00:00:00 GMT', now)?.expires).toBe(0);
        expect(parseSetCookie('=nothing', now)).toBeNull();
        expect(parseSetCookie('d=a=b', now)?.value).toBe('a=b');
    });

    it('stores, replaces, deletes and expires cookies, and shows HttpOnly ones only on request', () => {
        let now = 1_700_000_000_000;
        const jar = new LambderCookieJar({ now: () => now });
        jar.storeSetCookies(['sid=1; Path=/; HttpOnly', 'csrf=a; Path=/', 'temp=t; Max-Age=5']);
        expect(jar.cookiePairs()).toEqual(['sid=1', 'csrf=a', 'temp=t']);
        expect(jar.get('sid')).toBeUndefined();
        expect(jar.get('sid', { includeHttpOnly: true })).toBe('1');
        expect(jar.get('csrf')).toBe('a');

        jar.storeSetCookies(['csrf=b; Path=/']);
        expect(jar.get('csrf')).toBe('b');
        jar.storeSetCookies(['sid=; Max-Age=0; Path=/; HttpOnly']);
        expect(jar.get('sid', { includeHttpOnly: true })).toBeUndefined();
        // A deletion under another path is another cookie, as in a browser.
        jar.storeSetCookies(['csrf=; Max-Age=0; Path=/other']);
        expect(jar.get('csrf')).toBe('b');

        now += 6_000;
        expect(jar.cookiePairs()).toEqual(['csrf=b']);
        expect(jar.size).toBe(1);
        jar.clear();
        expect(jar.size).toBe(0);
    });
});
