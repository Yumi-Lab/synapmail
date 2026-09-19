import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { NextResponse } from 'next/server'
import { OPENAPI_CONTENT_TYPE, OPENAPI_FILE } from '@/lib/apiDocs'

export const dynamic = 'force-dynamic'

/** Serves the Bearer contract, to anyone — a key is what it explains how to use. */
export async function GET() {
  try {
    return new NextResponse(await readFile(join(process.cwd(), OPENAPI_FILE), 'utf8'), {
      headers: { 'Content-Type': OPENAPI_CONTENT_TYPE },
    })
  } catch {
    // The contract ships with the image; its absence is a packaging fault, and
    // saying so plainly beats a 500 that reads like the mail server broke.
    return NextResponse.json({ error: `${OPENAPI_FILE} is missing from this deployment` }, { status: 404 })
  }
}
