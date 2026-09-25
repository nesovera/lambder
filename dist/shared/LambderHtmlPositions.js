/*
 * Where a value inserted into HTML lands, and what HTML escaping cannot
 * protect there. The html`...` tagged template (LambderHtml) and the file
 * template engine (core/LambderTemplatingEngine) both place their values
 * with it, so the two refuse the same positions and check a URL value by the
 * same rule. Pure string code: it ships to the browser with html`...`.
 */
/**
 * The elements whose content the browser reads as text up to their own end
 * tag, with no tags or comments inside: script data, RAWTEXT (style, xmp,
 * iframe, noembed, noframes) and RCDATA (title, textarea). <noscript> is read
 * as markup, the way a parser with scripting off (DOMParser, a mail client)
 * reads it.
 */
const TEXT_CONTENT_ELEMENTS = new Set(["script", "style", "xmp", "iframe", "noembed", "noframes", "title", "textarea"]);
/**
 * Of those, the ones whose content is another language, where HTML escaping
 * is the wrong grammar: a value inside a <script> or <style> is refused. In
 * the rest an escaped value is text, since its "<" is escaped and cannot end
 * the element, until their content holds a tag (see foreignPartedBy).
 */
export const RAW_TEXT_ELEMENTS = new Set(["script", "style"]);
/** What HTML reads as whitespace between a tag's parts: tab, line feed, form feed, carriage return and space, and no other \s. */
const HTML_WHITESPACE = /[\t\n\f\r ]/;
const ASCII_LETTER = /[A-Za-z]/;
/** A run of tag name characters, up to the whitespace, "/" or ">" that ends the name. */
const TAG_NAME_RUN = /[^\t\n\f\r />]*/y;
/** A run of attribute name characters, up to the whitespace, "/", "=" or ">" that ends the name. */
const ATTRIBUTE_NAME_RUN = /[^\t\n\f\r />=]*/y;
/** What changes the state of a script's escaped content: a "-" or a "<". */
const SCRIPT_ESCAPED_STOP = /[-<]/g;
/** What follows "<!" to open a CDATA section, which only inline SVG and MathML read as one. */
const CDATA_OPENER = "[CDATA[";
// The tokenizer's comment states, as bits, so a comment can be in several at
// once right after a value (see skipValue). Between them they end a comment
// where the browser does: at "-->" and "--!>", and at "<!-->" and "<!--->"
// right after it opens. The comment less-than sign states the standard adds
// for a "<!--" inside a comment end it at the same place as these.
const COMMENT_START = 1;
const COMMENT_START_DASH = 2;
const COMMENT_TEXT = 4;
const COMMENT_END_DASH = 8;
const COMMENT_END = 16;
const COMMENT_END_BANG = 32;
/** What nextCommentState answers for a character that ends the comment. */
const COMMENT_CLOSED = 0;
/** The comment state `state` moves to on `character`, or COMMENT_CLOSED when the character ends the comment. */
const nextCommentState = (state, character) => {
    if (character === ">")
        return state === COMMENT_TEXT || state === COMMENT_END_DASH ? COMMENT_TEXT : COMMENT_CLOSED;
    if (character === "-") {
        if (state === COMMENT_START)
            return COMMENT_START_DASH;
        return state === COMMENT_TEXT || state === COMMENT_END_BANG ? COMMENT_END_DASH : COMMENT_END;
    }
    return character === "!" && state === COMMENT_END ? COMMENT_END_BANG : COMMENT_TEXT;
};
/**
 * Says where the end of the HTML read so far sits, with the part of the HTML
 * standard's tokenizer that decides it (ReaderState): an `=` or a `>` inside
 * a quoted value, or in text and comments, counts for nothing, a comment ends
 * where the browser ends it, and the content of a <script>, <style>, <title>
 * and the other TEXT_CONTENT_ELEMENTS is skipped up to its own end tag.
 *
 * A template's static pieces are read one after another, and a piece may end
 * anywhere, in the middle of "<!-" included: the reader asks where each value
 * between them lands (point) and moves past it (skipValue). The values
 * themselves are never read, since an escaped one holds no "<", ">" or
 * quote, so the position a value lands in is a property of the template. A
 * reading can be copied and joined with another reading of the same
 * template, which is how the template engine reads the branches of an
 * if/else.
 */
export class HtmlPositionReader {
    state = "data";
    /** The name of the tag being read, or of the element whose content is, lowercased. */
    tagName = "";
    /** The tag being read is an end tag, whose ">" never opens text content. */
    endTag = false;
    /** The attribute whose name or value is being read; between attributes, the one an "=" gives a value to ("" for none). */
    attributeName = "";
    /** The quote character the value being read opened with. */
    quote = "";
    /** Between attributes: this reading joins readings that give an "=" to different attributes. */
    equalsAmbiguous = false;
    /** Inside a comment: the COMMENT_ states it may be in, as bits. */
    commentStates = 0;
    /** Inside a <script>: 0 in script data, 1 escaped (after "<!--"), 2 double escaped (after "<!--" and "<script"). */
    scriptLevel = 0;
    /** Inside text content: the end tag name read so far, or the script tag name that double escapes a script or undoes that. */
    nameBuffer = "";
    /**
     * What has left inline SVG and MathML reading the HTML read so far apart
     * from plain HTML, or "" while the two read it alike. Inside them the
     * content of the TEXT_CONTENT_ELEMENTS is markup, and "<![CDATA[" runs to
     * "]]>" where plain HTML ends a bogus comment at the first ">". Once
     * text-only content holds a tag, or a CDATA section may end elsewhere
     * than plain HTML's comment, one reading can sit inside a tag where the
     * other sits in text, past the element's end tag too, so every value
     * from there on is a rawText point. A <script> or <style> is left out: a
     * value inside one is refused anyway, and a "<" in them (`a<b`) is common
     * enough that parting there would refuse every value after most inline
     * scripts.
     */
    foreignPartedBy = "";
    /** The label an undecidable reading is blamed on: the last value placed in a comment, or the join between attributes. */
    blame = "";
    undecidableReason = null;
    /** Read `html` on from where the last read stopped. */
    read(html) {
        let index = 0;
        while (index < html.length && this.state !== "undecidable") {
            const character = html[index];
            switch (this.state) {
                case "data": {
                    const open = html.indexOf("<", index);
                    if (open === -1)
                        return;
                    this.state = "tagOpen";
                    index = open + 1;
                    break;
                }
                case "tagOpen":
                    if (character === "!" || character === "/") {
                        this.state = character === "!" ? "markupOpen" : "endTagOpen";
                        index += 1;
                    }
                    else if (ASCII_LETTER.test(character))
                        this.openTag(false);
                    else
                        this.state = character === "?" ? "bogusComment" : "data";
                    break;
                case "endTagOpen":
                    if (ASCII_LETTER.test(character))
                        this.openTag(true);
                    else if (character === ">") {
                        this.state = "data";
                        index += 1;
                    }
                    else
                        this.state = "bogusComment";
                    break;
                case "markupOpen":
                case "markupOpenDash":
                    if (character !== "-") {
                        // A CDATA section, or a "<![" this piece ends in,
                        // reads alike both ways only when the first ">" is
                        // the one of "]]>" and this piece holds it.
                        if (this.state === "markupOpen" && CDATA_OPENER.startsWith(html.slice(index, index + CDATA_OPENER.length))) {
                            const close = html.indexOf(">", index);
                            if (close === -1 || !html.startsWith("]]", close - 2))
                                this.foreignPartedBy = "![CDATA[ ... ]]";
                        }
                        this.state = "bogusComment";
                        break;
                    }
                    index += 1;
                    if (this.state === "markupOpen")
                        this.state = "markupOpenDash";
                    else {
                        this.state = "comment";
                        this.commentStates = COMMENT_START;
                    }
                    break;
                case "tagName":
                    if (HTML_WHITESPACE.test(character) || character === "/") {
                        this.enterBetweenAttributes("");
                        index += 1;
                    }
                    else if (character === ">") {
                        this.closeTag();
                        index += 1;
                    }
                    else {
                        TAG_NAME_RUN.lastIndex = index;
                        const name = TAG_NAME_RUN.exec(html)[0];
                        this.tagName += name.toLowerCase();
                        index += name.length;
                    }
                    break;
                case "betweenAttributes":
                    if (HTML_WHITESPACE.test(character)) {
                        index += 1;
                        break;
                    }
                    if (character === "=" && this.equalsAmbiguous) {
                        this.loseTrack("attributeEquals");
                        break;
                    }
                    this.equalsAmbiguous = false;
                    if (character === "/") {
                        this.attributeName = "";
                        index += 1;
                    }
                    else if (character === ">") {
                        this.closeTag();
                        index += 1;
                    }
                    else if (character === "=") {
                        // With no name waiting for a value, an "=" starts
                        // the next attribute's name.
                        if (this.attributeName === "") {
                            this.state = "attributeName";
                            this.attributeName = "=";
                        }
                        else
                            this.state = "beforeValue";
                        index += 1;
                    }
                    else {
                        this.state = "attributeName";
                        this.attributeName = "";
                    }
                    break;
                case "attributeName":
                    if (HTML_WHITESPACE.test(character)) {
                        this.enterBetweenAttributes(this.attributeName);
                        index += 1;
                    }
                    else if (character === "/") {
                        this.enterBetweenAttributes("");
                        index += 1;
                    }
                    else if (character === ">") {
                        this.closeTag();
                        index += 1;
                    }
                    else if (character === "=") {
                        this.state = "beforeValue";
                        index += 1;
                    }
                    else {
                        ATTRIBUTE_NAME_RUN.lastIndex = index;
                        const name = ATTRIBUTE_NAME_RUN.exec(html)[0];
                        this.attributeName += name.toLowerCase();
                        index += name.length;
                    }
                    break;
                case "beforeValue":
                    if (character === '"' || character === "'") {
                        this.state = "quotedValue";
                        this.quote = character;
                    }
                    else if (character === ">")
                        this.closeTag();
                    else if (!HTML_WHITESPACE.test(character))
                        this.state = "unquotedValue";
                    index += 1;
                    break;
                case "unquotedValue":
                    if (HTML_WHITESPACE.test(character))
                        this.enterBetweenAttributes("");
                    else if (character === ">")
                        this.closeTag();
                    index += 1;
                    break;
                case "quotedValue": {
                    const close = html.indexOf(this.quote, index);
                    if (close === -1)
                        return;
                    this.enterBetweenAttributes("");
                    index = close + 1;
                    break;
                }
                case "bogusComment": {
                    const close = html.indexOf(">", index);
                    if (close === -1)
                        return;
                    this.state = "data";
                    index = close + 1;
                    break;
                }
                case "comment": {
                    // Plain comment text changes nothing up to its next "-".
                    if (this.commentStates === COMMENT_TEXT) {
                        const dash = html.indexOf("-", index);
                        if (dash === -1)
                            return;
                        index = dash;
                    }
                    let nextStates = 0;
                    let closes = false;
                    for (let commentState = COMMENT_START; commentState <= COMMENT_END_BANG; commentState <<= 1) {
                        if (!(this.commentStates & commentState))
                            continue;
                        const next = nextCommentState(commentState, html[index]);
                        if (next === COMMENT_CLOSED)
                            closes = true;
                        else
                            nextStates |= next;
                    }
                    index += 1;
                    if (closes && nextStates !== 0)
                        this.loseTrack("commentValue");
                    else if (closes)
                        this.state = "data";
                    else
                        this.commentStates = nextStates;
                    break;
                }
                case "rawText": {
                    // A script's escaped content changes state on a "-" as
                    // well as on a "<".
                    let stop = -1;
                    if (this.scriptLevel === 0)
                        stop = html.indexOf("<", index);
                    else {
                        SCRIPT_ESCAPED_STOP.lastIndex = index;
                        stop = SCRIPT_ESCAPED_STOP.exec(html)?.index ?? -1;
                    }
                    if (stop === -1)
                        return;
                    this.state = html[stop] === "-" ? "rawTextDash" : "rawTextLessThan";
                    index = stop + 1;
                    break;
                }
                case "rawTextDash":
                case "rawTextDashDash":
                    if (character === "<")
                        this.state = "rawTextLessThan";
                    else if (character === "-")
                        this.state = "rawTextDashDash";
                    else {
                        // "-->" ends a script's escaped content.
                        if (character === ">" && this.state === "rawTextDashDash")
                            this.scriptLevel = 0;
                        this.state = "rawText";
                    }
                    index += 1;
                    break;
                case "rawTextLessThan":
                    if (character === "/") {
                        this.state = this.scriptLevel === 2 ? "scriptDoubleEscapeEnd" : "rawTextEndTagOpen";
                        this.nameBuffer = "";
                        index += 1;
                    }
                    else if (character === "!" && this.tagName === "script" && this.scriptLevel === 0) {
                        this.state = "scriptEscapeStart";
                        index += 1;
                    }
                    else if (ASCII_LETTER.test(character) && this.scriptLevel === 1) {
                        this.state = "scriptDoubleEscapeStart";
                        this.nameBuffer = "";
                    }
                    else {
                        if (ASCII_LETTER.test(character) || character === "!" || character === "?")
                            this.noteMarkupInText();
                        this.state = "rawText";
                    }
                    break;
                case "rawTextEndTagOpen":
                    if (ASCII_LETTER.test(character))
                        this.state = "rawTextEndTagName";
                    else {
                        this.noteMarkupInText();
                        this.state = "rawText";
                    }
                    break;
                case "rawTextEndTagName":
                    if (ASCII_LETTER.test(character)) {
                        this.nameBuffer += character.toLowerCase();
                        index += 1;
                    }
                    else if (this.nameBuffer === this.tagName && (HTML_WHITESPACE.test(character) || character === "/" || character === ">")) {
                        // The element's own end tag, whose attributes are
                        // read like any tag's.
                        this.endTag = true;
                        if (character === ">")
                            this.closeTag();
                        else
                            this.enterBetweenAttributes("");
                        index += 1;
                    }
                    else {
                        this.noteMarkupInText();
                        this.state = "rawText";
                    }
                    break;
                case "scriptEscapeStart":
                case "scriptEscapeStartDash":
                    if (character !== "-") {
                        this.state = "rawText";
                        break;
                    }
                    index += 1;
                    if (this.state === "scriptEscapeStart")
                        this.state = "scriptEscapeStartDash";
                    else {
                        this.state = "rawTextDashDash";
                        this.scriptLevel = 1;
                    }
                    break;
                case "scriptDoubleEscapeStart":
                case "scriptDoubleEscapeEnd":
                    if (ASCII_LETTER.test(character)) {
                        this.nameBuffer += character.toLowerCase();
                        index += 1;
                        break;
                    }
                    if (HTML_WHITESPACE.test(character) || character === "/" || character === ">") {
                        // A "<script" in escaped script content double
                        // escapes it, so its own "</script>" does not end
                        // the element; that "</script>" only undoes it.
                        if (this.nameBuffer === "script")
                            this.scriptLevel = this.state === "scriptDoubleEscapeStart" ? 2 : 1;
                        index += 1;
                    }
                    this.state = "rawText";
                    break;
            }
        }
    }
    /** Where a value inserted at the end of the HTML read so far lands. */
    point() {
        const point = { position: "tag", attributeName: "", quote: "", tagName: "" };
        if (this.foreignPartedBy) {
            point.position = "rawText";
            point.tagName = this.foreignPartedBy;
            return point;
        }
        switch (this.state) {
            case "data":
                point.position = "text";
                break;
            case "bogusComment":
            case "comment":
                point.position = "comment";
                break;
            case "beforeValue":
            case "unquotedValue":
            case "quotedValue":
                point.position = this.state === "beforeValue" ? "afterEquals" : this.state === "unquotedValue" ? "unquoted" : "quoted";
                point.attributeName = this.attributeName;
                if (this.state === "quotedValue")
                    point.quote = this.quote;
                break;
            case "rawText":
            case "rawTextDash":
            case "rawTextDashDash":
            case "rawTextLessThan":
            case "rawTextEndTagOpen":
            case "rawTextEndTagName":
            case "scriptEscapeStart":
            case "scriptEscapeStartDash":
            case "scriptDoubleEscapeStart":
            case "scriptDoubleEscapeEnd":
                // Inside other text content a value is text, unless it
                // follows a "<" or an end tag's start, which it could finish.
                if (RAW_TEXT_ELEMENTS.has(this.tagName)) {
                    point.position = "rawText";
                    point.tagName = this.tagName;
                }
                else if (this.state === "rawText")
                    point.position = "text";
                break;
            default:
                // A tag, or a "<", "</", "<!" or "<!-" a value would finish:
                // where a value goes on the markup the template started.
                break;
        }
        return point;
    }
    /**
     * Move past a value inserted here. An escaped value holds no "<", ">" or
     * quote, so only a comment reads on differently after it: the value may
     * end in "-", "--" or "--!", and the text after it may then end the
     * comment on a ">" that ends it after no other value. The reader keeps
     * every comment state such an ending leaves, and loses track (blaming
     * `label`) when the text after them ends the comment in some and not in
     * others.
     */
    skipValue(label = "") {
        if (this.state !== "comment")
            return;
        this.commentStates |= COMMENT_TEXT | COMMENT_END_DASH | COMMENT_END | COMMENT_END_BANG
            | (this.commentStates & COMMENT_START ? COMMENT_START_DASH : 0);
        this.blame = label;
    }
    /** An independent copy of this reading, to read one branch of a template on from here. */
    copy() {
        return Object.assign(new HtmlPositionReader(), this);
    }
    /**
     * Take in `other`, a reading of the same template along another branch,
     * when both sit at the same position, and say whether they did: from
     * then on this reading reads for both. Between attributes, readings
     * whose last attribute names differ count as the same position, so a
     * conditional boolean attribute (`<input <!--if:x-->checked<!--/if:x--> name="a">`)
     * reads on as one reading. Only an "=" next reads them apart, and it
     * makes the joined reading lose track, blaming `label`.
     */
    joinWith(other, label = "") {
        if (this.positionKey() !== other.positionKey() || this.foreignPartedBy !== other.foreignPartedBy)
            return false;
        if (this.state === "betweenAttributes" && !this.equalsAmbiguous) {
            if (other.equalsAmbiguous) {
                this.equalsAmbiguous = true;
                this.blame = other.blame;
            }
            else if (other.attributeName !== this.attributeName) {
                this.equalsAmbiguous = true;
                this.blame = label;
            }
        }
        return true;
    }
    /** Why the reader has lost track of where the HTML read so far sits, or null while it has not. A caller refuses the template then. */
    get undecidable() {
        return this.undecidableReason ? { reason: this.undecidableReason, label: this.blame } : null;
    }
    /**
     * The HTML read so far ends in plain text, where complete markup ends:
     * outside any tag, comment and text content, and read alike by inline
     * SVG and MathML. A fragment inserted into another template has to end
     * here, since the template around it places its values without reading it.
     */
    get inPlainText() {
        return this.state === "data" && !this.foreignPartedBy;
    }
    /** The state and whichever fields it reads on with, as one string: two readings with the same key read any text the same way. */
    positionKey() {
        switch (this.state) {
            case "comment":
                return `comment ${this.commentStates}`;
            case "tagName":
                return `tagName ${this.endTag} ${this.tagName}`;
            case "betweenAttributes":
            case "attributeName":
            case "beforeValue":
            case "unquotedValue":
            case "quotedValue": {
                // Past its name, a tag's name matters only where its ">"
                // opens text content.
                const opens = this.endTag || !TEXT_CONTENT_ELEMENTS.has(this.tagName) ? "" : this.tagName;
                return `${this.state} ${opens} ${this.state === "betweenAttributes" ? "" : this.attributeName} ${this.state === "quotedValue" ? this.quote : ""}`;
            }
            case "rawText":
            case "rawTextDash":
            case "rawTextDashDash":
            case "rawTextLessThan":
            case "rawTextEndTagOpen":
            case "scriptEscapeStart":
            case "scriptEscapeStartDash":
                return `${this.state} ${this.tagName} ${this.scriptLevel}`;
            case "rawTextEndTagName":
            case "scriptDoubleEscapeStart":
            case "scriptDoubleEscapeEnd":
                return `${this.state} ${this.tagName} ${this.scriptLevel} ${this.nameBuffer}`;
            default:
                return this.state;
        }
    }
    openTag(endTag) {
        this.state = "tagName";
        this.tagName = "";
        this.endTag = endTag;
    }
    enterBetweenAttributes(attributeName) {
        this.state = "betweenAttributes";
        this.attributeName = attributeName;
        this.equalsAmbiguous = false;
    }
    /**
     * A tag's ">" leads into its content: text content for the
     * TEXT_CONTENT_ELEMENTS even when written `<script />`, which HTML reads
     * as an open element, and data after an end tag.
     */
    closeTag() {
        this.state = !this.endTag && TEXT_CONTENT_ELEMENTS.has(this.tagName) ? "rawText" : "data";
        this.scriptLevel = 0;
    }
    /**
     * A "<" in text content starts a tag, a comment or a bogus comment in
     * markup, and it is not the element's own end tag: inline SVG and MathML
     * read it as markup (see foreignPartedBy).
     */
    noteMarkupInText() {
        if (!RAW_TEXT_ELEMENTS.has(this.tagName))
            this.foreignPartedBy = this.tagName;
    }
    loseTrack(reason) {
        this.state = "undecidable";
        this.undecidableReason = reason;
    }
}
/**
 * The language the browser reads an attribute's value in once it has
 * decoded the HTML escapes, for the attributes whose value is not text: an
 * event handler (any `on` attribute) runs as JavaScript, `style` is read as
 * CSS and `srcdoc` as a whole document. Escaping keeps a value inside the
 * quotes and nothing more there: `onclick="go('${x}')"` runs
 * `');alert(1);//`, since `&#39;` is a quote again by the time the script
 * sees it.
 */
export const valueLanguageOf = (attributeName) => {
    if (attributeName.startsWith("on"))
        return "JavaScript";
    if (attributeName === "style")
        return "CSS";
    if (attributeName === "srcdoc")
        return "an HTML document";
    return null;
};
/**
 * The attributes whose value is one URL. In several a `javascript:` value
 * runs script (a link, a form's action, a frame's src), and in the rest a
 * scheme an inserted value picked is still one the page never meant to point
 * at. A quoted value of one of them holding an inserted value is rendered
 * whole and checked (safeUrlValue). The list-valued ones (srcset, ping) are
 * left out: their entries never run.
 */
export const URL_ATTRIBUTE_NAMES = new Set([
    "href", "src", "action", "formaction", "xlink:href", "poster", "cite",
    "data", "background", "codebase", "longdesc", "manifest",
]);
/** The schemes an inserted value may give a URL attribute: the ones a link or a resource uses, and none that runs code or carries its own document. */
const SAFE_URL_SCHEMES = new Set(["http", "https", "mailto", "tel"]);
/** What a URL value renders as when an inserted value gave it any other scheme: a URL that goes nowhere and runs nothing. */
const NEUTRALIZED_URL_VALUE = "about:invalid";
/**
 * A rendered URL value `url`, or NEUTRALIZED_URL_VALUE when an inserted value
 * may have given it a scheme outside SAFE_URL_SCHEMES. `firstValueIndex` is
 * where in `url` the first inserted value landed, -1 when none did. Once the
 * template's own text before that point holds a `:`, `/`, `?` or `#`, the
 * template fixed the scheme (`/users/${id}`, `sms:${number}`) and the value
 * stands as rendered. Otherwise the whole value is read for its scheme the
 * way a browser reads it: leading and trailing control characters and spaces
 * dropped, tabs and line breaks removed wherever they are, letters in any
 * case. A value with no scheme is relative and stands. A character reference
 * (`&`) where the scheme or its colon would be is refused rather than
 * decoded: `&colon;` and `&#58;` are colons to the browser. Whatever kind of
 * value was inserted, html`...` and raw() included, the rule is the same.
 */
export const safeUrlValue = (url, firstValueIndex) => {
    if (firstValueIndex === -1 || /^[^&:/?#]*[:/?#]/.test(url.slice(0, firstValueIndex)))
        return url;
    // A URL parser drops C0 controls and spaces (U+0000 to U+0020) at both ends.
    let first = 0;
    let last = url.length;
    while (first < last && url.charCodeAt(first) <= 0x20)
        first += 1;
    while (last > first && url.charCodeAt(last - 1) <= 0x20)
        last -= 1;
    const urlText = url.slice(first, last).replace(/[\t\n\r]/g, "");
    const scheme = /^[A-Za-z][A-Za-z0-9+.-]*/.exec(urlText)?.[0] ?? "";
    const afterScheme = urlText.charAt(scheme.length);
    if (afterScheme === "&")
        return NEUTRALIZED_URL_VALUE;
    if (afterScheme === ":" && scheme !== "" && !SAFE_URL_SCHEMES.has(scheme.toLowerCase()))
        return NEUTRALIZED_URL_VALUE;
    return url;
};
