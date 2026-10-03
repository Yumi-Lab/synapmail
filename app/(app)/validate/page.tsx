import { Suspense } from 'react'
import { auth } from '@/lib/auth'
import { redirect } from 'next/navigation'
import { ValidateClient } from './ValidateClient'

export const dynamic = 'force-dynamic'

export default async function ValidatePage() {
  const session = await auth()
  if (!session) redirect('/login')
  return (
    <Suspense fallback={null}>
      <ValidateClient />
    </Suspense>
  )
}
