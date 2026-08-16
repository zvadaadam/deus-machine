import { escapeTagValue, parseTagAttributes, unescapeTagValue } from "./messageTagCodec";

/**
 * Parse <inspect> XML tags in message text into structured segments.
 *
 * Format varies by context:
 *   Local:    <inspect ref="ref-abc" tag="button" path="body > div" context="local" react="Component" file="src/ui/Button.tsx" line="42">Label</inspect>
 *   External: <inspect ref="ref-abc" tag="button" path="body > div" context="external" styles="background-color: #635bff; border-radius: 8px; font-size: 16px">Label</inspect>
 *
 * `parseUserMessageReferences` does the splitting; this module owns the
 * element shape plus its tag codec.
 */

export interface InspectElement {
  ref: string;
  tagName: string;
  path: string;
  innerText?: string;
  /** "local" = own dev server, "external" = any other website */
  context?: "local" | "external";
  reactComponent?: string;
  /** Source file path (local context only, from React fiber _debugSource) */
  file?: string;
  /** Source line number (local context only) */
  line?: string;
  /** Context-aware CSS styles as semicolon-separated key: value pairs */
  styles?: string;
  /** Serialized React props: "variant=primary; size=sm; disabled=false" */
  props?: string;
  /** Key HTML attributes: "type=submit; data-testid=checkout-btn" */
  attributes?: string;
  /** Shallow innerHTML showing element structure */
  innerHTML?: string;
}

export function inspectElementFromTag(attrString: string, encodedText: string): InspectElement {
  const attrs = parseTagAttributes(attrString);
  return {
    ref: attrs.ref ?? "",
    tagName: attrs.tag ?? "div",
    path: attrs.path ?? "",
    innerText: unescapeTagValue(encodedText),
    context: (attrs.context as "local" | "external") || undefined,
    reactComponent: attrs.react || undefined,
    file: attrs.file || undefined,
    line: attrs.line || undefined,
    styles: attrs.styles || undefined,
    props: attrs.props || undefined,
    attributes: attrs.attributes || undefined,
    innerHTML: attrs.innerHTML || undefined,
  };
}

/** Serialize an InspectElement into the <inspect> XML tag format.
 *  All values are HTML-escaped to survive round-trip parsing. */
export function serializeInspectElement(el: {
  ref: string;
  tagName: string;
  path: string;
  innerText?: string;
  context?: "local" | "external";
  reactComponent?: string;
  file?: string;
  line?: string;
  styles?: string;
  props?: string;
  attributes?: string;
  innerHTML?: string;
}): string {
  const label = el.innerText?.slice(0, 80) ?? el.tagName;
  const contextAttr = el.context ? ` context="${escapeTagValue(el.context)}"` : "";
  const reactAttr = el.reactComponent ? ` react="${escapeTagValue(el.reactComponent)}"` : "";
  const fileAttr = el.file ? ` file="${escapeTagValue(el.file)}"` : "";
  const lineAttr = el.line ? ` line="${escapeTagValue(el.line)}"` : "";
  const propsAttr = el.props ? ` props="${escapeTagValue(el.props)}"` : "";
  const attrsAttr = el.attributes ? ` attributes="${escapeTagValue(el.attributes)}"` : "";
  const stylesAttr = el.styles ? ` styles="${escapeTagValue(el.styles)}"` : "";
  const innerHTMLAttr = el.innerHTML ? ` innerHTML="${escapeTagValue(el.innerHTML)}"` : "";
  return `<inspect ref="${escapeTagValue(el.ref)}" tag="${escapeTagValue(el.tagName)}" path="${escapeTagValue(el.path)}"${contextAttr}${reactAttr}${fileAttr}${lineAttr}${propsAttr}${attrsAttr}${stylesAttr}${innerHTMLAttr}>${escapeTagValue(label)}</inspect>`;
}
