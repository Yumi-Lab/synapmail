import NextAuth from 'next-auth'
import Credentials from 'next-auth/providers/credentials'
import { query } from './db'
import { normalizeEmail } from './emailAddress'
import bcrypt from 'bcryptjs'
import { authConfig } from '@/auth.config'

export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  providers: [
    Credentials({
      credentials: {
        email: { label: 'Email', type: 'email' },
        password: { label: 'Password', type: 'password' },
      },
      async authorize(credentials) {
        if (!credentials?.email || !credentials?.password) return null
        // La casse de l'identifiant ne doit jamais empêcher de se connecter : on compare
        // en minuscules des deux côtés. Pas de LIMIT 1 : si deux comptes ne différaient que
        // par la casse (données créées avant cette normalisation), choisir au hasard lequel
        // authentifier serait un défaut de sécurité — on refuse au lieu de deviner.
        const users = await query<{
          id: string; email: string; name: string;
          password_hash: string; role: string; avatar_url: string; status: string
        }>('SELECT * FROM users WHERE lower(email) = $1', [normalizeEmail(credentials.email as string)])
        if (users.length !== 1) return null
        const user = users[0]
        if (user.status !== 'active') return null
        const valid = await bcrypt.compare(credentials.password as string, user.password_hash)
        if (!valid) return null
        return { id: user.id, email: user.email, name: user.name, role: user.role, image: user.avatar_url }
      },
    }),
  ],
})
