import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { NextResponse } from 'next/server'
import { OPENAPI_CONTENT_TYPE, OPENAPI_FILE, withServedOrigin } from '@/lib/apiDocs'
import { appOrigin } from '@/lib/appOrigin'

export const dynamic = 'force-dynamic'

/** Serves the Bearer contract, to anyone — a key is what it explains how to use. */
export async function GET(req: Request) {
  try {
    const contract = await readFile(join(process.cwd(), OPENAPI_FILE), 'utf8')
    return new NextResponse(withServedOrigin(contract, appOrigin(req)), {
      headers: { 'Content-Type': OPENAPI_CONTENT_TYPE },
    })
  } catch {
    // The contract ships with the image; its absence is a packaging fault, and
    // saying so plainly beats a 500 that reads like the mail server broke.
    return NextResponse.json({ error: `${OPENAPI_FILE} is missing from this deployment` }, { status: 404 })
  }
}
