/**
 * A request path between the spelling a gateway delivers and the one routes,
 * files and redirects work with.
 *
 * The gateways disagree: a REST API and a Function URL hand the path over
 * percent-encoded, an HTTP API hands it over decoded. Routes and file
 * lookups need one form, or `addRoute("/hakkımızda")` and a file named
 * `team photo.jpg` are found on one gateway and not on another.
 *
 * That form, `ctx.path`, is the path decoded with two escapes kept: a slash
 * inside a segment stays `%2F`, so it cannot become a separator, and a
 * percent sign stays `%25`, so no decoded text can pass for an escape. Every
 * path is decoded exactly once, whoever sent it: `/%2561dmin` names the text
 * `%61dmin` (written `/%2561dmin`), and never `/admin`.
 */
/** An encoded slash: a slash that belongs to a segment's text rather than separating two segments. */
const ENCODED_SLASH = /%2F/gi;
/** Decoded text as ctx.path writes it: every percent sign kept as `%25`. */
const keepPercentSigns = (text) => text.replaceAll("%", "%25");
/**
 * One segment decoded, its encoded slashes kept as `%2F` and its percent
 * signs as `%25`. A segment whose escapes do not decode (a stray `%`, a byte
 * sequence that is not UTF-8) is read as the text it arrived as: it names
 * nothing that decoding would have named.
 */
const decodeSegment = (segment) => {
    if (!segment.includes("%"))
        return segment;
    try {
        return segment.split(ENCODED_SLASH).map((piece) => keepPercentSigns(decodeURIComponent(piece))).join("%2F");
    }
    catch {
        return keepPercentSigns(segment);
    }
};
/**
 * The path routes and files see (`ctx.path`), from the path the gateway
 * delivered. `alreadyDecoded` for an HTTP API, which decodes the path before
 * the function sees it (its encoded slashes into separators, too): decoded
 * again, a `/%2561dmin` the gateway handed over as `/%61dmin` would route to
 * `/admin`, past an authorizer, a WAF rule or a CloudFront behavior in front
 * of the function that checked the path once. The segment checks that guard
 * file reads (no `..`, no empty or backslashed segment) run on this form, so
 * an encoded `%2e%2e` is refused as the `..` it is.
 */
export const decodeRequestPath = (rawPath, alreadyDecoded) => rawPath.split("/").map(alreadyDecoded ? keepPercentSigns : decodeSegment).join("/");
/** A path parameter's value: its text from ctx.path, with the kept `%2F` and `%25` turned back into `/` and `%`. */
export const decodePathParam = (value) => value.replace(/%2F|%25/gi, (escape) => (escape === "%25" ? "%" : "/"));
/**
 * The file a path names, for servePublicFiles: the kept `%25` turned back
 * into `%`, or null for a path with a slash inside a segment, which no file
 * name holds.
 */
export const filePathOf = (path) => /%2F/i.test(path) ? null : path.replaceAll("%25", "%");
/**
 * A decoded path as a Location header: every character a URL path may not
 * carry is percent-encoded, `%` itself left alone so the kept `%2F` and `%25`
 * stay the escapes they are. A browser drops a TAB or line break inside a
 * Location before resolving it, so `/<TAB>/evil.example` sent as it is would
 * reach the browser as `//evil.example`, another host; encoded, it stays a
 * path on this one.
 */
export const encodePathForLocation = (path) => path.replace(/[^A-Za-z0-9\-._~!$&'()*+,;=:@/%]/gu, (character) => encodeURIComponent(character));
