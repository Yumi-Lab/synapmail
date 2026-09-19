import { NextResponse } from 'next/server'
import { API_DOC_FILE, MARKDOWN_CONTENT_TYPE, readApiDoc } from '@/lib/apiDocs'

export const dynamic = 'force-dynamic'

/** Serves the API reference as markdown, to anyone — a key is what it explains how to use. */
export async function GET() {
  try {
    return new NextResponse(await readApiDoc(), {
      headers: { 'Content-Type': MARKDOWN_CONTENT_TYPE },
    })
  } catch {
    // The document ships with the image; its absence is a packaging fault, and
    // saying so plainly beats a 500 that reads like the mail server broke.
    return NextResponse.json({ error: `${API_DOC_FILE} is missing from this deployment` }, { status: 404 })
  }
}
