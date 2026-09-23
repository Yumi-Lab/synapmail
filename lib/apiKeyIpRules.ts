/**
 * La liste d'IP autorisées d'une clé — LE verrou, et la seule façon de le lire.
 *
 * Vide = aucune restriction, comme avant ce lot. Non vide : une requête dont
 * l'adresse ne correspond à AUCUNE entrée est refusée, et le refus NOMME l'adresse.
 *
 * CE QUE CE VERROU VAUT RÉELLEMENT : l'adresse comparée est celle que l'application
 * peut voir (`clientIp`, `lib/apiLog.ts`) — `x-forwarded-for`, un en-tête, donc
 * FORGEABLE par quiconque atteint l'application sans passer par le reverse proxy.
 * Le verrou n'est donc étanche que si ce proxy est le SEUL chemin vers l'application
 * et qu'il réécrit l'en-tête. Sans cette garantie, c'est un garde-fou d'exploitation
 * (« cette clé ne sert que depuis ce serveur »), pas une barrière de sécurité.
 *
 * Une session humaine n'est jamais concernée : comme les portées et les boîtes, la
 * restriction ne s'applique qu'aux clés.
 */

/** Une entrée : une adresse exacte (`198.51.100.4`) ou un préfixe CIDR (`198.51.100.0/24`). */
export type IpRule = string

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/

/** `null` si ce n'est pas une IPv4 : une entrée illisible n'autorise rien. */
function toNumber(ip: string): number | null {
  const m = ip.trim().match(IPV4)
  if (!m) return null
  let n = 0
  for (let i = 1; i <= 4; i++) {
    const part = Number(m[i])
    if (part > 255) return null
    n = n * 256 + part
  }
  return n
}

/**
 * Une entrée est-elle valide ? Sert à REFUSER une saisie à l'enregistrement plutôt
 * qu'à la laisser bloquer silencieusement toute la clé.
 */
export function isIpRule(value: unknown): value is IpRule {
  if (typeof value !== 'string' || !value.trim()) return false
  const [addr, bits] = value.trim().split('/')
  if (toNumber(addr) === null) return false
  if (bits === undefined) return true
  const n = Number(bits)
  return Number.isInteger(n) && n >= 0 && n <= 32
}

/** Ne garde que les entrées lisibles, sans doublon — comme `sanitizeScopes` pour les portées. */
export function sanitizeIpRules(values: unknown): IpRule[] {
  if (!Array.isArray(values)) return []
  return Array.from(new Set(values.filter(isIpRule).map(v => v.trim())))
}

/**
 * L'adresse est-elle admise ? Une liste VIDE admet tout : c'est le comportement
 * d'avant ce lot, et le défaut de toute clé existante.
 *
 * Une adresse absente (aucun en-tête, appel direct sans proxy) face à une liste NON
 * vide est refusée : on ne peut pas affirmer qu'elle est dans la liste.
 */
export function ipAllowed(rules: IpRule[] | null | undefined, ip: string | null): boolean {
  if (!rules?.length) return true
  const value = toNumber(ip ?? '')
  if (value === null) return false

  return rules.some(rule => {
    const [addr, bits] = rule.split('/')
    const base = toNumber(addr)
    if (base === null) return false
    if (bits === undefined) return base === value
    const prefix = Number(bits)
    if (prefix === 0) return true
    const mask = (0xffffffff << (32 - prefix)) >>> 0
    return ((base >>> 0) & mask) === ((value >>> 0) & mask)
  })
}
