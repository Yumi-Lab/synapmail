'use client'

/**
 * L'écran « Fiabilité » (décision 16, lot T14) : par question, UNE ligne — validations humaines,
 * exactitude moteur / humain sur l'AUDIT ALÉATOIRE seulement, confusions les plus fréquentes,
 * courbe confiance → exactitude par tranche de 0,1, accord JEV / Yumi One. Un tableau, aucun
 * graphe. La mesure vient de `lib/tagging/audit.ts` ; les libellés de `useTagLabels`.
 *
 * « Tirer l'audit » complète `tag_audits` jusqu'à la cible (`POST /api/tagging/run`, action
 * `audit`, sans appel moteur) ; « Valider » mène à la liste de courrier filtrée sur les mails
 * tirés non jugés (`/mail?tag=audit`), où le panneau de chaque mail corrige en un clic ;
 * « Valider au clavier » ouvre la file « À valider » (lot T15), qui enchaîne les étiquettes.
 */
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useFormatter, useTranslations } from 'next-intl'
import useSWR from 'swr'
import { Button } from '@/components/ui/button'
import { SettingsSection } from '@/components/settings/primitives'
import { useTagLabels } from '@/hooks/useTagLabels'
import { MAIL_PATH } from '@/lib/compose'
import { AUDIT_FILTER, TAG_FILTER_PARAM, VALIDATE_ACCOUNT_PARAM, VALIDATE_PATH } from '@/lib/tagging/view'
import type { AuditStatus, QuestionReliability } from '@/lib/tagging/audit'
import { useAccountAccent } from '@/components/layout/AccountAvatar'

const fetcher = (url: string) => fetch(url).then(r => r.json())
const STATUS_ENDPOINT = '/api/tagging/status'
const RUN_ENDPOINT = '/api/tagging/run'


export function TagReliabilitySection({ accountId }: { accountId: string }) {
  const t = useTranslations('settings.tagging')
  const format = useFormatter()
  // Pourcentages et décimales dans la langue de l'écran (« 50 % » et « 0,9 » en français).
  const pct = (correct: number, judged: number) => format.number(correct / judged, { style: 'percent', maximumFractionDigits: 0 })
  const { q, v } = useTagLabels()
  const router = useRouter()
  const { switchAccount } = useAccountAccent()
  const [busy, setBusy] = useState(false)
  const { data, mutate } = useSWR<{ data: { reliability: QuestionReliability[]; audit: AuditStatus } }>(
    `${STATUS_ENDPOINT}?account=${accountId}&reliability=1`, fetcher,
  )
  const audit = data?.data?.audit ?? null
  const rows = data?.data?.reliability ?? []
  const missing = audit ? audit.target - audit.drawn : 0
  const pending = audit ? audit.drawn - audit.validated : 0

  async function draw() {
    setBusy(true)
    try {
      await fetch(RUN_ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accountId, action: 'audit' }) })
      await mutate()
    } finally { setBusy(false) }
  }
  // La liste filtre la boîte ACTIVE : on la bascule sur celle de l'écran avant d'y aller.
  function validate() {
    switchAccount(accountId)
    router.push(`${MAIL_PATH}?${TAG_FILTER_PARAM}=${AUDIT_FILTER}`)
  }

  return (
    <SettingsSection title={t('reliability')} description={t('reliabilityDesc')}>
      {audit && (
        <div className="flex flex-wrap items-center gap-2" data-audit-state={`${audit.drawn}/${audit.target}`}>
          <p className="text-xs text-muted-foreground tabular-nums">
            {/* Tout sous une ancienne version : le badge ambre dit déjà quoi faire, « rien à auditer » le contredirait. */}
            {audit.tagged === 0 ? (audit.stale === 0 && t('auditNothing')) : t('auditState', { ...audit })}
            {audit.stale > 0 && (
              <span className="ml-2 rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] text-amber-700 dark:text-amber-400" data-audit-stale={audit.stale}>
                {t('auditStale', { count: audit.stale })}
              </span>
            )}
          </p>
          <span className="ml-auto flex gap-2">
            {missing > 0 && (
              <Button type="button" variant="ghost" size="sm" onClick={draw} disabled={busy} data-audit-draw>
                {audit.drawn === 0 ? t('auditDraw') : t('auditComplete', { missing })}
              </Button>
            )}
            {pending > 0 && (
              <Button type="button" size="sm" onClick={validate} data-audit-validate={pending}>
                {t('auditValidate', { pending })}
              </Button>
            )}
            {/* La file au clavier vaut aussi sans tirage : désaccords et confiances basses y entrent. */}
            {audit.tagged > 0 && (
              <Button type="button" variant="ghost" size="sm" onClick={() => router.push(`${VALIDATE_PATH}?${VALIDATE_ACCOUNT_PARAM}=${accountId}`)} data-audit-keyboard>
                {t('validateKeyboard')}
              </Button>
            )}
          </span>
        </div>
      )}
      {rows.length === 0 ? (
        // « Tirez l'audit » n'a de sens que s'il y a quelque chose à tirer.
        audit?.tagged !== 0 && <p className="mt-3 text-xs text-muted-foreground">{t('reliabilityEmpty')}</p>
      ) : (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-xs" data-reliability-rows={rows.length}>
            <thead className="text-left text-muted-foreground">
              <tr>
                <th className="py-1 pr-3 font-medium">{t('colQuestion')}</th>
                <th className="py-1 pr-3 font-medium tabular-nums">{t('colHuman')}</th>
                <th className="py-1 pr-3 font-medium">{t('colAccuracy')}</th>
                <th className="py-1 pr-3 font-medium">{t('colConfusions')}</th>
                <th className="py-1 pr-3 font-medium">{t('colCurve')}</th>
                <th className="py-1 font-medium">{t('colAgreement')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.question} className="border-t border-border align-top" data-reliability-question={r.question}>
                  <td className="py-1.5 pr-3 font-medium">{q(r.question)}</td>
                  <td className="py-1.5 pr-3 tabular-nums">{r.humanCount}</td>
                  <td className="py-1.5 pr-3 tabular-nums" data-audit-accuracy={r.audit.judged ? r.audit.correct / r.audit.judged : ''}>
                    {r.audit.judged ? `${pct(r.audit.correct, r.audit.judged)} · ${t('accuracyOf', { ...r.audit })}` : '—'}
                  </td>
                  <td className="py-1.5 pr-3 text-muted-foreground">
                    {r.confusions.length ? r.confusions.map(c => t('confusionPair', { engine: v(c.moteur), human: v(c.humain), count: c.count })).join(', ') : '—'}
                  </td>
                  <td className="py-1.5 pr-3 tabular-nums text-muted-foreground">
                    {r.byConfidence.length ? r.byConfidence.map(b => t('curveBucket', { bucket: format.number(b.bucket, { minimumFractionDigits: 1, maximumFractionDigits: 1 }), correct: b.correct, judged: b.judged })).join(' · ') : '—'}
                  </td>
                  <td className="py-1.5 tabular-nums">
                    {r.engineAgreement ? `${pct(r.engineAgreement.agree, r.engineAgreement.both)} · ${t('agreementOf', { ...r.engineAgreement })}` : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </SettingsSection>
  )
}
