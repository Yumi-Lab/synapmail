export interface PgpContactKey {
  id: string
  userId: string
  email: string
  name: string | null
  fingerprint: string
  armoredKey: string
  createdAt: string
}

export interface PgpIdentity {
  userId: string
  fingerprint: string
  armoredPublicKey: string
  createdAt: string
  updatedAt: string
}
