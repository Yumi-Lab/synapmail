import { NextResponse } from 'next/server'
import { buildLlmsTxt, PLAIN_CONTENT_TYPE } from '@/lib/apiDocs'

export const dynamic = 'force-dynamic'

/** The llmstxt.org entry point: what this instance is, and where its reference lives. */
export function GET(req: Request) {
  return new NextResponse(buildLlmsTxt(new URL(req.url).origin), {
    headers: { 'Content-Type': PLAIN_CONTENT_TYPE },
  })
}
