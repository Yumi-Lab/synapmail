/**
 * Quick translation — the PURE half: how a message is cut up, what URL is
 * called, and how the answer is read. No `fetch` at import time, no DOM, no
 * server: this file is imported as-is by `scripts/check-quick-translate.mjs`.
 *
 * It calls a public, UNOFFICIAL endpoint of Google Translate, from the READER'S
 * browser only (see `components/ai/AIToolbar.tsx`) — never from the server, so
 * the request carries the reader's own address and no instance-wide quota
 * exists to exhaust. This is the one place in the product allowed to name a
 * Google domain, under the explicit, informed derogation recorded in GOAL.md
 * (lot S9); it is unreachable from behind the Chinese firewall and is meant for
 * a PRIVATE instance. The setting that turns it off lives in Settings → AI.
 *
 * The message text is never logged here, nor anywhere on its path.
 */

/** Translation engine behind the "Translate" button. Single source: the setting, the API and the toolbar all read THIS list. */
export const TRANSLATE_QUICK = 'quick'
export const TRANSLATE_MODEL = 'model'
export const TRANSLATE_OFF = 'off'
export const TRANSLATE_MODES = [TRANSLATE_QUICK, TRANSLATE_MODEL, TRANSLATE_OFF] as const
export type TranslateMode = typeof TRANSLATE_MODES[number]
/** The default: it needs no model, no server and no setup. */
export const TRANSLATE_MODE_DEFAULT: TranslateMode = TRANSLATE_QUICK

/** i18n key (namespace `mail.ai`) of each mode's label. Single source, so the setting screen cannot name a mode differently from the doc. */
export const TRANSLATE_MODE_LABEL: Record<TranslateMode, 'translateModeQuick' | 'translateModeModel' | 'translateModeOff'> = {
  [TRANSLATE_QUICK]: 'translateModeQuick',
  [TRANSLATE_MODEL]: 'translateModeModel',
  [TRANSLATE_OFF]: 'translateModeOff',
}

export function asTranslateMode(value: unknown): TranslateMode {
  return TRANSLATE_MODES.includes(value as TranslateMode) ? value as TranslateMode : TRANSLATE_MODE_DEFAULT
}

export const QUICK_TRANSLATE_ENDPOINT = 'https://translate.googleapis.com/translate_a/single'

/**
 * Characters sent in one call. The service silently TRUNCATES past roughly
 * 5 000 characters — a shorter ceiling leaves room for the URL encoding of
 * multi-byte text, which counts against the same limit.
 * ponytail: a plain constant, not a setting. Nothing measured asks for a knob;
 * if a longer limit is ever proven safe, raise it here and nowhere else.
 */
export const QUICK_TRANSLATE_CHUNK = 4000

/** Where a cut is allowed, best first: paragraph, then end of sentence, then any space. Never inside a word. */
const BOUNDARIES = ['\n', '. ', '! ', '? ', ' ']

/**
 * Cuts `text` into pieces of at most `QUICK_TRANSLATE_CHUNK` characters.
 *
 * Concatenating the pieces gives back the input EXACTLY — nothing is trimmed,
 * so line breaks survive the round trip and the translated pieces can simply be
 * joined back together.
 */
export function splitForTranslation(text: string, limit = QUICK_TRANSLATE_CHUNK): string[] {
  if (typeof text !== 'string' || text.length === 0) return []
  if (text.length <= limit) return [text]

  const chunks: string[] = []
  let rest = text
  while (rest.length > limit) {
    const window = rest.slice(0, limit)
    let cut = -1
    for (const boundary of BOUNDARIES) {
      const at = window.lastIndexOf(boundary)
      if (at > 0) { cut = at + boundary.length; break }
    }
    // ponytail: no boundary in a whole window means one unbroken run longer than
    // the limit (a base64 blob, a URL). Cutting it mid-"word" is the only way to
    // stay under the ceiling; the alternative is silent truncation by the service.
    if (cut <= 0) cut = limit
    chunks.push(rest.slice(0, cut))
    rest = rest.slice(cut)
  }
  if (rest.length > 0) chunks.push(rest)
  return chunks
}

/** The URL for one chunk. `sl=auto` lets the service detect the source language. */
export function quickTranslateUrl(chunk: string, targetLang: string): string {
  const params = new URLSearchParams({ client: 'gtx', sl: 'auto', tl: targetLang, dt: 't', q: chunk })
  return `${QUICK_TRANSLATE_ENDPOINT}?${params}`
}

/**
 * Reads one answer: a nested array whose first entry holds the segments, each
 * segment carrying the translated text first. Anything else (an HTML block
 * page, a quota error, a shape change) raises instead of returning a half
 * translation the reader would take for the real thing.
 */
export function readTranslateResponse(payload: unknown): string {
  const segments = Array.isArray(payload) ? payload[0] : null
  if (!Array.isArray(segments)) throw new Error('quick-translate: unreadable answer')
  let out = ''
  for (const segment of segments) {
    if (!Array.isArray(segment) || typeof segment[0] !== 'string') {
      throw new Error('quick-translate: unreadable answer')
    }
    out += segment[0]
  }
  return out
}

/**
 * Translates `text`, chunk by chunk, IN ORDER — the pieces are recombined in
 * the order they were cut, so a late chunk cannot land before an early one.
 * `fetchJson` is injected so the self-check can run this without a network.
 * ponytail: sequential on purpose. Parallel calls buy nothing on a message-sized
 * text and would make a quota block hit every chunk at once instead of the first.
 */
export async function quickTranslate(
  text: string,
  targetLang: string,
  fetchJson: (url: string) => Promise<unknown>,
): Promise<string> {
  const chunks = splitForTranslation(text)
  let out = ''
  for (const chunk of chunks) {
    out += readTranslateResponse(await fetchJson(quickTranslateUrl(chunk, targetLang)))
  }
  return out
}
