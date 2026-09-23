/**
 * Shared HTML utilities — strip HTML to plain text, wrap in full document.
 * Used by: lib/smtp.ts (text/plain fallback), app/api/ai/action/route.ts (prompt cleaning).
 */

/**
 * Strip HTML tags and decode common entities, returning readable plain text.
 * Removes <style>, <script>, <head> blocks entirely before stripping tags,
 * so their contents don't pollute the output.
 */
export function htmlToText(html: string): string {
  return html
    // Remove invisible block content first
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<head[^>]*>[\s\S]*?<\/head>/gi, '')
    // Preserve link text + URL
    .replace(/<a[^>]+href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, '$2 ($1)')
    // Block elements → newlines
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?(p|div|h[1-6]|li|tr|blockquote)[^>]*>/gi, '\n')
    // Strip remaining tags
    .replace(/<[^>]+>/g, '')
    // Decode named entities
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    // Decode numeric entities (decimal + hex)
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    // Normalize whitespace
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * Wrap an HTML snippet in a full HTML document if it doesn't already have one.
 * Prevents SpamAssassin's HTML_MIME_NO_HTML_TAG flag on outgoing emails.
 */
export function wrapHtmlDocument(html: string): string {
  if (/<html[\s>]/i.test(html)) return html
  return `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>${html}</body></html>`
}

/**
 * The readable text of a message — what a human reads, with none of the
 * markup. The plain part is preferred when the sender sent one; otherwise the
 * HTML is stripped down. The subject is the last resort, for a message with an
 * empty body.
 *
 * Order matters: taking `bodyHtml` first hands markup to whatever consumes
 * this. A model ignores tags, but a translation service TRANSLATES them —
 * `head` came back as `tête` — and sending the technical head of an HTML
 * document to a third party leaks more than the body does.
 */
export function messageText(parts: { bodyPlain?: string; bodyHtml?: string; subject?: string }): string {
  const plain = parts.bodyPlain?.trim()
  if (plain) return plain
  const html = parts.bodyHtml?.trim()
  if (html) return htmlToText(html)
  return parts.subject?.trim() ?? ''
}
