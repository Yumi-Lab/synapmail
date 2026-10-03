import { Suspense } from 'react'
import { auth } from '@/lib/auth'
import { redirect } from 'next/navigation'
import { DocumentsClient } from './DocumentsClient'

export const dynamic = 'force-dynamic'

/** Les documents d'une boîte GED (lot G6, décision 8) : liste par dossier virtuel + volet de lecture. */
export default async function DocumentsPage() {
  const session = await auth()
  if (!session) redirect('/login')
  return (
    <Suspense fallback={null}>
      <DocumentsClient />
    </Suspense>
  )
}
