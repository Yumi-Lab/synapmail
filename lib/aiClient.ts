/**
 * THE browser-side entry point to the assistant — used by every AI component.
 *
 * `POST /api/ai/action` either answers with a `result` (the server called a
 * hosted provider) or with `mode: 'local'` plus the messages it prepared, which
 * this module carries to a model running on the user's own machine. The prompt
 * is never rebuilt here: the guard, the delimiters and the system turn all come
 * from the server (lib/ai.ts `buildMessages`), so both paths send the same
 * thing to the model.
 */

import { AIMessage, LOCAL_PROVIDER, isLoopbackUrl } from './ai'

export type AIFailureKind =
  /** The server refused, or a hosted provider did. */
  | 'server'
  /** Nothing is listening on the local address. */
  | 'unreachable'
  /** Something answered, but the browser blocked the response (no CORS header). */
  | 'cors'
  /** The local model answered with an error status. */
  | 'model'

export class AIClientError extends Error {
  constructor(public kind: AIFailureKind, message: string) {
    super(message)
    this.name = 'AIClientError'
  }
}

interface LocalPlan {
  mode: typeof LOCAL_PROVIDER
  baseUrl: string
  model: string
  messages: AIMessage[]
}

type ActionResponse = { data?: { result?: string } & Partial<LocalPlan>; error?: string }

export interface AIActionRequest {
  action: string
  content: string
  accountId?: string
  context?: string
  tone?: string
  targetLang?: string
}

/** Chat completion on an OpenAI-compatible server (Ollama `/v1`, LM Studio, llama.cpp). */
export async function callLocalModel(plan: LocalPlan): Promise<string> {
  if (!isLoopbackUrl(plan.baseUrl)) {
    throw new AIClientError('server', 'The local provider only accepts a loopback address')
  }

  let res: Response
  try {
    res = await fetch(`${plan.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: plan.model, messages: plan.messages, stream: false }),
    })
  } catch {
    // A browser reports "nothing listening" and "blocked by CORS" the same way:
    // a TypeError with no status. Probing the address tells the two apart.
    throw new AIClientError(await probeLocal(plan.baseUrl) ? 'cors' : 'unreachable', plan.baseUrl)
  }

  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as { error?: { message?: string } | string }
    const detail = typeof err.error === 'string' ? err.error : err.error?.message
    throw new AIClientError('model', detail || `Local model error: ${res.status}`)
  }

  const data = await res.json() as { choices?: { message?: { content?: string } }[] }
  return data.choices?.[0]?.message?.content ?? ''
}

/**
 * True when something answers at that address. `no-cors` gets an opaque
 * response rather than an exception, so a server that is up but refuses this
 * origin still resolves — which is exactly the distinction we need.
 */
async function probeLocal(baseUrl: string): Promise<boolean> {
  try {
    await fetch(`${baseUrl.replace(/\/+$/, '')}/models`, { mode: 'no-cors' })
    return true
  } catch {
    return false
  }
}

/** Models advertised by a local server, read by the BROWSER (the server cannot reach it). */
export async function listLocalModels(baseUrl: string): Promise<string[]> {
  if (!isLoopbackUrl(baseUrl)) throw new AIClientError('server', baseUrl)
  const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/models`)
  if (!res.ok) throw new AIClientError('model', `HTTP ${res.status}`)
  const data = await res.json() as { data?: { id: string }[] }
  return (data.data ?? []).map(m => m.id)
}

/** Runs an assistant action, whichever side ends up calling the model. */
export async function runAIAction(req: AIActionRequest): Promise<string> {
  let res: Response
  try {
    res = await fetch('/api/ai/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
    })
  } catch {
    throw new AIClientError('server', 'network')
  }

  const json = await res.json().catch(() => ({})) as ActionResponse
  if (!res.ok) throw new AIClientError('server', json.error || `HTTP ${res.status}`)

  if (json.data?.mode === LOCAL_PROVIDER) {
    return callLocalModel(json.data as LocalPlan)
  }
  if (typeof json.data?.result === 'string') return json.data.result
  throw new AIClientError('server', json.error || 'Empty response')
}

/**
 * i18n key describing a failure, under the `mail.ai` namespace. One place maps
 * a failure kind to what the user reads, so both components say the same thing.
 */
export function aiFailureKey(err: unknown): string {
  const kind = err instanceof AIClientError ? err.kind : 'server'
  return `errors.${kind}`
}
