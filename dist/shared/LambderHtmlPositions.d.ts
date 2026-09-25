export type HtmlPosition = "text" | "comment" | "tag" | "afterEquals" | "unquoted" | "quoted" | "rawText";
/** Where a point of a template sits in its HTML, and which attribute or element a value there belongs to. */
export type HtmlPoint = {
    position: HtmlPosition;
    /** For a value position (afterEquals, unquoted, quoted): the attribute it belongs to, lowercased. "" elsewhere. */
    attributeName: string;
    /** For a quoted point: the quote character its value opened with. "" elsewhere. */
    quote: string;
    /**
     * For a rawText point: the element whose content it is, lowercased, or
     * what left inline SVG and MathML reading the template apart from plain
     * HTML (see foreignPartedBy). "" elsewhere.
     */
    tagName: string;
};
/** Why an HtmlPositionReader cannot tell where the HTML read so far sits, and what a refusal names for it. */
export type HtmlUndecidable = {
    /**
     * "commentValue": a value inside a comment is followed by text that ends
     * the comment or not depending on how the value ends. "attributeEquals":
     * readings joined between attributes after different attribute names
     * (joinWith) met an "=", which gives its value to a different attribute
     * in each.
     */
    reason: "commentValue" | "attributeEquals";
    /** The label skipValue or joinWith was given for it. */
    label: string;
};
/**
 * Of those, the ones whose content is another language, where HTML escaping
 * is the wrong grammar: a value inside a <script> or <style> is refused. In
 * the rest an escaped value is text, since its "<" is escaped and cannot end
 * the element, until their content holds a tag (see foreignPartedBy).
 */
export declare const RAW_TEXT_ELEMENTS: ReadonlySet<string>;
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
export declare class HtmlPositionReader {
    private state;
    /** The name of the tag being read, or of the element whose content is, lowercased. */
    private tagName;
    /** The tag being read is an end tag, whose ">" never opens text content. */
    private endTag;
    /** The attribute whose name or value is being read; between attributes, the one an "=" gives a value to ("" for none). */
    private attributeName;
    /** The quote character the value being read opened with. */
    private quote;
    /** Between attributes: this reading joins readings that give an "=" to different attributes. */
    private equalsAmbiguous;
    /** Inside a comment: the COMMENT_ states it may be in, as bits. */
    private commentStates;
    /** Inside a <script>: 0 in script data, 1 escaped (after "<!--"), 2 double escaped (after "<!--" and "<script"). */
    private scriptLevel;
    /** Inside text content: the end tag name read so far, or the script tag name that double escapes a script or undoes that. */
    private nameBuffer;
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
    private foreignPartedBy;
    /** The label an undecidable reading is blamed on: the last value placed in a comment, or the join between attributes. */
    private blame;
    private undecidableReason;
    /** Read `html` on from where the last read stopped. */
    read(html: string): void;
    /** Where a value inserted at the end of the HTML read so far lands. */
    point(): HtmlPoint;
    /**
     * Move past a value inserted here. An escaped value holds no "<", ">" or
     * quote, so only a comment reads on differently after it: the value may
     * end in "-", "--" or "--!", and the text after it may then end the
     * comment on a ">" that ends it after no other value. The reader keeps
     * every comment state such an ending leaves, and loses track (blaming
     * `label`) when the text after them ends the comment in some and not in
     * others.
     */
    skipValue(label?: string): void;
    /** An independent copy of this reading, to read one branch of a template on from here. */
    copy(): HtmlPositionReader;
    /**
     * Take in `other`, a reading of the same template along another branch,
     * when both sit at the same position, and say whether they did: from
     * then on this reading reads for both. Between attributes, readings
     * whose last attribute names differ count as the same position, so a
     * conditional boolean attribute (`<input <!--if:x-->checked<!--/if:x--> name="a">`)
     * reads on as one reading. Only an "=" next reads them apart, and it
     * makes the joined reading lose track, blaming `label`.
     */
    joinWith(other: HtmlPositionReader, label?: string): boolean;
    /** Why the reader has lost track of where the HTML read so far sits, or null while it has not. A caller refuses the template then. */
    get undecidable(): HtmlUndecidable | null;
    /**
     * The HTML read so far ends in plain text, where complete markup ends:
     * outside any tag, comment and text content, and read alike by inline
     * SVG and MathML. A fragment inserted into another template has to end
     * here, since the template around it places its values without reading it.
     */
    get inPlainText(): boolean;
    /** The state and whichever fields it reads on with, as one string: two readings with the same key read any text the same way. */
    private positionKey;
    private openTag;
    private enterBetweenAttributes;
    /**
     * A tag's ">" leads into its content: text content for the
     * TEXT_CONTENT_ELEMENTS even when written `<script />`, which HTML reads
     * as an open element, and data after an end tag.
     */
    private closeTag;
    /**
     * A "<" in text content starts a tag, a comment or a bogus comment in
     * markup, and it is not the element's own end tag: inline SVG and MathML
     * read it as markup (see foreignPartedBy).
     */
    private noteMarkupInText;
    private loseTrack;
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
export declare const valueLanguageOf: (attributeName: string) => string | null;
/**
 * The attributes whose value is one URL. In several a `javascript:` value
 * runs script (a link, a form's action, a frame's src), and in the rest a
 * scheme an inserted value picked is still one the page never meant to point
 * at. A quoted value of one of them holding an inserted value is rendered
 * whole and checked (safeUrlValue). The list-valued ones (srcset, ping) are
 * left out: their entries never run.
 */
export declare const URL_ATTRIBUTE_NAMES: ReadonlySet<string>;
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
export declare const safeUrlValue: (url: string, firstValueIndex: number) => string;
