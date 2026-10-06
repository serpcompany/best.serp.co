import {
  type DefaultTreeAdapterMap,
  defaultTreeAdapter,
  Parser,
  type Token,
  Tokenizer,
  type TokenizerOptions,
  type TreeAdapter
} from 'parse5'

/**
 * `parse5` within fixed limits, for HTML from sites we don't control (PR #84 review round 2,
 * finding 2). parse5 runs the WHATWG algorithm, and parts of it are not linear: many steps
 * scan the stack of open elements, each new attribute is compared with the earlier ones on
 * its tag, inserting a node before a sibling (foster parenting out of a table, misnested
 * formatting) searches the sibling list, and reopening formatting elements can create
 * elements the page never wrote. On 1 MB of crafted HTML (deeply nested `<div>`s, one tag
 * with 100,000 attributes, thousands of links fostered out of a table) plain parse5 takes
 * seconds to minutes of CPU, or runs out of memory.
 *
 * So a parse stops with `HtmlTooComplexError` past any of `HTML_LIMITS`:
 * - `depth`: open elements nested 512 deep (Chromium's parser stops nesting there too);
 * - `elements`: 100,000 elements created;
 * - `work`: 10 million units, charged close to each step's real cost: a token, and opening
 *   an element, cost the open-element depth (what their scans can walk) plus 1 for a token;
 *   an attribute is 1 plus the attributes already on its tag (the duplicate check); and
 *   inserting before a sibling or detaching a node is the parent's child count.
 * Large real pages stay far below them (`bounded-html.test.ts` records several), and crafted
 * 1 MB pages stop within tens of milliseconds.
 *
 * `<html>` and `<body>` attributes repeated later in the page are not merged into those
 * elements (the merge is quadratic and nothing reads them).
 *
 * The meter subclasses parse5's `Parser` and `Tokenizer`, which parse5 exports but does not
 * document as stable, so `apps/web/package.json` pins parse5 to an exact version, and the
 * unit tests fail if a hook stops firing.
 */
export interface HtmlLimits {
  depth: number
  elements: number
  work: number
}

export const HTML_LIMITS: HtmlLimits = { depth: 512, elements: 100_000, work: 10_000_000 }

export class HtmlTooComplexError extends Error {
  constructor() {
    super('The HTML is too complex to parse within the limits')
    this.name = 'HtmlTooComplexError'
  }
}

type Document = DefaultTreeAdapterMap['document']

class WorkMeter {
  depth = 0
  elements = 0
  maxDepth = 0
  spent = 0

  constructor(private readonly limits: HtmlLimits) {}

  charge(units: number): void {
    this.spent += units
    if (this.spent > this.limits.work) throw new HtmlTooComplexError()
  }

  element(): void {
    this.elements += 1
    if (this.elements > this.limits.elements) throw new HtmlTooComplexError()
  }

  push(): void {
    this.depth += 1
    if (this.depth > this.maxDepth) this.maxDepth = this.depth
    if (this.depth > this.limits.depth) throw new HtmlTooComplexError()
    // Reopening a formatting element (`<b>` left open across a `</p>`) searches the stack.
    this.charge(this.depth)
  }
}

class MeteredTokenizer extends Tokenizer {
  private readonly meter: WorkMeter

  constructor(options: TokenizerOptions, handler: Parser<DefaultTreeAdapterMap>, meter: WorkMeter) {
    super(options, handler)
    this.meter = meter
  }

  /** parse5 compares each attribute's name with every attribute already on the tag. */
  protected override _createAttr(attrNameFirstCh: string): void {
    const token = this.currentToken
    this.meter.charge(1 + (token && 'attrs' in token ? token.attrs.length : 0))
    super._createAttr(attrNameFirstCh)
  }
}

function meteredTreeAdapter(meter: WorkMeter): TreeAdapter<DefaultTreeAdapterMap> {
  return {
    ...defaultTreeAdapter,
    adoptAttributes() {},
    detachNode(node) {
      meter.charge(node.parentNode?.childNodes.length ?? 0)
      defaultTreeAdapter.detachNode(node)
    },
    insertBefore(parentNode, newNode, referenceNode) {
      meter.charge(parentNode.childNodes.length)
      defaultTreeAdapter.insertBefore(parentNode, newNode, referenceNode)
    },
    insertTextBefore(parentNode, text, referenceNode) {
      meter.charge(2 * parentNode.childNodes.length)
      defaultTreeAdapter.insertTextBefore(parentNode, text, referenceNode)
    },
    createElement(tagName, namespaceURI, attrs) {
      meter.element()
      return defaultTreeAdapter.createElement(tagName, namespaceURI, attrs)
    },
    onItemPop() {
      meter.depth -= 1
    },
    onItemPush() {
      meter.push()
    }
  }
}

class MeteredParser extends Parser<DefaultTreeAdapterMap> {
  private readonly meter: WorkMeter

  constructor(meter: WorkMeter) {
    // Scripting on, as for Googlebot: `<noscript>` content is raw text.
    super({ scriptingEnabled: true, treeAdapter: meteredTreeAdapter(meter) })
    this.meter = meter
    // A fresh tokenizer, in the same initial state as the one `super` made and has not used.
    this.tokenizer = new MeteredTokenizer(this.options, this, meter)
  }

  private chargeToken(): void {
    this.meter.charge(1 + this.meter.depth)
  }

  override onCharacter(token: Token.CharacterToken): void {
    this.chargeToken()
    super.onCharacter(token)
  }

  override onComment(token: Token.CommentToken): void {
    this.chargeToken()
    super.onComment(token)
  }

  override onDoctype(token: Token.DoctypeToken): void {
    this.chargeToken()
    super.onDoctype(token)
  }

  override onEndTag(token: Token.TagToken): void {
    this.chargeToken()
    super.onEndTag(token)
  }

  override onEof(token: Token.EOFToken): void {
    this.chargeToken()
    super.onEof(token)
  }

  override onNullCharacter(token: Token.CharacterToken): void {
    this.chargeToken()
    super.onNullCharacter(token)
  }

  override onStartTag(token: Token.TagToken): void {
    this.chargeToken()
    super.onStartTag(token)
  }

  override onWhitespaceCharacter(token: Token.CharacterToken): void {
    this.chargeToken()
    super.onWhitespaceCharacter(token)
  }
}

/** The document, and how much of each limit the parse used. */
export interface BoundedParse {
  document: Document
  elements: number
  maxDepth: number
  work: number
}

/**
 * Parses a whole HTML document as a browser would (scripting on), or throws
 * `HtmlTooComplexError` when the page goes past any of `limits`.
 */
export function parseBoundedHtml(html: string, limits: HtmlLimits = HTML_LIMITS): BoundedParse {
  const meter = new WorkMeter(limits)
  const parser = new MeteredParser(meter)
  parser.tokenizer.write(html, true)
  return {
    document: parser.document,
    elements: meter.elements,
    maxDepth: meter.maxDepth,
    work: meter.spent
  }
}
