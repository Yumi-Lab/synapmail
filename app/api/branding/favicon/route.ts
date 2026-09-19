import { NextResponse } from 'next/server'
import { readFavicon } from '@/lib/brandingStore'

export const dynamic = 'force-dynamic'

/**
 * Icône de l'instance, en accès PUBLIC : la page de connexion en a besoin avant
 * toute session (voir `lib/publicPaths.ts`).
 *
 * Le type servi est celui DÉTECTÉ à l'enregistrement, jamais celui déclaré par
 * le navigateur ; `nosniff` interdit au client de le réinterpréter, donc un
 * fichier à double lecture (octets PNG valides, HTML dans la charge utile) ne
 * peut pas s'exécuter depuis notre origine. L'URL porte sa version, d'où le
 * cache long et immuable : une nouvelle icône change l'URL.
 */
export async function GET() {
  const favicon = await readFavicon()
  if (!favicon) return new NextResponse(null, { status: 404 })

  return new NextResponse(new Uint8Array(favicon.bytes), {
    headers: {
      'Content-Type': favicon.type,
      'Content-Length': String(favicon.bytes.length),
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  })
}
