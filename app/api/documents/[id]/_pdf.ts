import { NextResponse } from 'next/server'
import type { AccessibleAccount } from '@/lib/accountAccess'
import { imapMailSource } from '@/lib/tagging/imapSource'
import { isPdf } from '@/lib/ged/intake'
import { documentPlace } from '@/lib/ged/documents'

/**
 * Relit le PDF d'un document DANS la boîte IMAP, en lecture seule (`imapMailSource` : EXAMINE +
 * BODY.PEEK, la même source que la chaîne de réception) — rien n'est stocké côté serveur, la base ne
 * garde que le texte OCR (décision 1). `null` si le mail ou la pièce n'y sont plus.
 */
export async function readDocumentPdf(account: AccessibleAccount, documentId: string): Promise<{ content: Buffer; filename: string; pages: number } | null> {
  const place = await documentPlace(account.id, documentId)
  if (!place) return null
  const source = imapMailSource(account)
  try {
    const [mail] = await source.fetchFull(place.folder, [place.uid])
    const attachment = mail?.attachments[place.part_idx]
    if (!attachment || !isPdf(attachment)) return null
    return { content: attachment.content, filename: place.filename, pages: place.pages }
  } finally {
    await source.close().catch(() => {})
  }
}

/** Un serveur IMAP injoignable n'est pas une faute de l'appelant : 502, pas 500. */
export const imapError = (err: unknown) =>
  NextResponse.json({ error: `mailbox unreachable: ${err instanceof Error ? err.message : String(err)}` }, { status: 502 })

/** Un nom de fichier dans `Content-Disposition`, sans guillemets ni retour de ligne — jamais le nom brut du mail. */
export const disposition = (kind: 'inline' | 'attachment', filename: string) =>
  `${kind}; filename="${encodeURIComponent(filename.replace(/[\r\n"]/g, '_'))}"`
