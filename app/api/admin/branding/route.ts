import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { query } from '@/lib/db'
import { isAdmin } from '@/lib/requireAdmin'
import { BRANDING_ERRORS, FAVICON_MAX_BYTES, cleanAppName, detectImageType } from '@/lib/branding'
import { readBranding } from '@/lib/brandingStore'

export const dynamic = 'force-dynamic'

const FORBIDDEN = 403
const BAD_REQUEST = 400

async function guard() {
  const session = await auth()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!(await isAdmin(session))) return NextResponse.json({ error: 'Forbidden' }, { status: FORBIDDEN })
  return null
}

/** La ligne d'instance existe toujours après ceci : tout le reste est un UPDATE. */
async function ensureRow() {
  await query('INSERT INTO instance_settings (id) VALUES (TRUE) ON CONFLICT (id) DO NOTHING')
}

export async function GET() {
  const refused = await guard()
  if (refused) return refused
  return NextResponse.json({ data: await readBranding() })
}

/**
 * Enregistre le nom, l'icône, ou les deux. Le corps est un `multipart/form-data`
 * parce qu'il porte un fichier : `appName` (texte) et `favicon` (fichier) sont
 * tous deux facultatifs, ce qui permet de ne changer qu'un des deux.
 *
 * Le type de l'icône est décidé sur ses OCTETS et jamais sur son extension ni
 * sur le type déclaré par le navigateur : c'est ce type détecté qui est stocké,
 * puis re-servi par `GET /api/branding/favicon`.
 */
export async function PUT(req: Request) {
  const refused = await guard()
  if (refused) return refused

  try {
    const form = await req.formData()
    const rawName = form.get('appName')
    const file = form.get('favicon')

    let appName: string | null = null
    if (rawName !== null) {
      appName = cleanAppName(rawName)
      if (appName === null) {
        return NextResponse.json({ error: BRANDING_ERRORS.badName }, { status: BAD_REQUEST })
      }
    }

    let favicon: { bytes: Buffer; type: string } | null = null
    if (file instanceof File && file.size > 0) {
      if (file.size > FAVICON_MAX_BYTES) {
        return NextResponse.json({ error: BRANDING_ERRORS.tooLarge }, { status: BAD_REQUEST })
      }
      const bytes = Buffer.from(await file.arrayBuffer())
      // Deuxième mesure de la taille, sur les octets réellement lus : `file.size`
      // vient du client et ne prouve rien.
      if (bytes.length > FAVICON_MAX_BYTES) {
        return NextResponse.json({ error: BRANDING_ERRORS.tooLarge }, { status: BAD_REQUEST })
      }
      const type = detectImageType(bytes)
      if (!type) return NextResponse.json({ error: BRANDING_ERRORS.badType }, { status: BAD_REQUEST })
      favicon = { bytes, type }
    }

    if (!appName && !favicon) {
      return NextResponse.json({ error: BRANDING_ERRORS.badName }, { status: BAD_REQUEST })
    }

    await ensureRow()
    if (appName) await query('UPDATE instance_settings SET app_name = $1 WHERE id = TRUE', [appName])
    if (favicon) {
      await query(
        'UPDATE instance_settings SET favicon = $1, favicon_type = $2, favicon_updated_at = NOW() WHERE id = TRUE',
        [favicon.bytes, favicon.type]
      )
    }

    return NextResponse.json({ data: await readBranding() })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}

/**
 * Remise à zéro, champ par champ : `?target=name` rend le nom d'origine,
 * `?target=favicon` rend les fichiers de `public/`. Sans cible reconnue, rien
 * n'est effacé — une remise à zéro totale par accident serait irréversible.
 */
export async function DELETE(req: Request) {
  const refused = await guard()
  if (refused) return refused

  const target = new URL(req.url).searchParams.get('target')
  try {
    if (target === 'name') {
      await query('UPDATE instance_settings SET app_name = NULL WHERE id = TRUE')
    } else if (target === 'favicon') {
      await query(
        'UPDATE instance_settings SET favicon = NULL, favicon_type = NULL, favicon_updated_at = NULL WHERE id = TRUE'
      )
    } else {
      return NextResponse.json({ error: 'target must be name or favicon' }, { status: BAD_REQUEST })
    }
    return NextResponse.json({ data: await readBranding() })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
