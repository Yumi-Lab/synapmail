'use client'

/**
 * Les étiquettes d'un message dans l'interface : les pastilles d'une LIGNE de liste, et le
 * panneau du volet de lecture. Les deux vivent ici parce qu'ils affichent la MÊME chose sous
 * deux tailles — un libellé, une valeur, et en infobulle la confiance et la source.
 *
 * Aucun libellé n'est écrit dans ce fichier : `tags.q.<question>` et `tags.v.<valeur>` viennent
 * des trois fichiers de `locales/` (décision 1), une question ajoutée à l'écran se lit par son
 * identifiant (`useTagLabels`). Les règles (pastille en liste, valeurs admises, ordre, groupe)
 * viennent du jeu de questions de l'utilisateur (`useQuestionSet`, lot T-Q).
 */

import { useMemo, useState } from 'react'
import useSWR from 'swr'
import { useFormatter, useTranslations } from 'next-intl'
import { Tags } from 'lucide-react'
import { cn } from '@/lib/utils'
import { isRuleQuestionId, valuesOf } from '@/lib/tagging/questions'
import { OCCURRENCES_KEY } from '@/lib/tagging/detectors'
import { HUMAN_SOURCE, RULE_SOURCE } from '@/lib/tagging/engine'
import { listPills, orderedTags, tagsByGroup } from '@/lib/tagging/view'
import { useQuestionSet } from '@/hooks/useQuestionSet'
import { useTagLabels } from '@/hooks/useTagLabels'
import type { StoredField, StoredTag } from '@/lib/tagging/store'
import { CARRIERS, TYPE_ECHEANCE, TYPE_MONTANT, type FieldName } from '@/lib/tagging/fields'
import type { Message } from '@/types/email'

/**
 * L'ORIGINE d'une étiquette, en clair (décision 23) : qui l'a écrite (le nom instantané), ce
 * qu'il a annoncé comme modèle, et quand. Une ligne migrée sans auteur nommable rend son modèle
 * ou sa source à la place du nom — jamais une chaîne vide.
 */
function useOriginText() {
  const t = useTranslations('tags')
  const format = useFormatter()
  const { q } = useTagLabels()
  return (tag: Pick<StoredTag, 'auteurNom' | 'modele' | 'source' | 'creeLe' | 'auteurId'>): string => {
    const name = tag.auteurNom || tag.modele || tag.source
    // Une source `regle` est soit une règle d'étiquetage (nommée par l'utilisateur), soit un
    // détecteur interne (lot T11b, `auteur_id` = l'id du détecteur) : les deux se disent en clair.
    const who = tag.source === HUMAN_SOURCE
      ? t('sourceHuman', { name })
      : tag.source === RULE_SOURCE
        ? (isRuleQuestionId(tag.auteurId) ? t('sourceDetector', { name: q(tag.auteurId) }) : t('sourceRule', { name }))
        : t('sourceEngine', { name, model: tag.modele ?? tag.source })
    return `${who} · ${format.dateTime(new Date(tag.creeLe), { dateStyle: 'short', timeStyle: 'short' })}`
  }
}

/** Ce qu'une étiquette dit d'elle-même quand on s'arrête dessus : valeur, confiance, origine. */
function useTagText() {
  const t = useTranslations('tags')
  const { pair } = useTagLabels()
  const origin = useOriginText()
  return (tag: StoredTag): string => {
    const parts = [pair(tag.question, tag.valeur)]
    if (tag.confiance !== null) parts.push(t('confidence', { percent: Math.round(tag.confiance * 100) }))
    const occurrences = tag.probabilites?.[OCCURRENCES_KEY]
    if (occurrences) parts.push(t('occurrences', { count: occurrences }))
    parts.push(origin(tag))
    return parts.join(' · ')
  }
}

/**
 * Les pastilles d'une ligne de liste : seulement les étiquettes que `questions.ts` marque
 * visibles en liste. L'infobulle porte TOUT le reste (décision 11) — c'est l'attribut `title`
 * natif, celui que la ligne emploie déjà pour son drapeau et sa boîte : rien à mesurer, rien à
 * positionner, et il survit à un défilement sous le pointeur.
 *
 * Hauteur : une pastille fait `h-4` (16 px, bordure comprise — `box-sizing: border-box`), soit
 * EXACTEMENT la boîte de ligne du `text-xs` de l'objet à côté duquel elle se pose. Une ligne
 * étiquetée mesure donc la même chose qu'une ligne nue ; c'est ce que le gate mesure.
 */
export function TagPills({ tags, compact }: { tags: readonly StoredTag[]; compact?: boolean }) {
  const t = useTranslations('tags')
  const { v } = useTagLabels()
  const describe = useTagText()
  const { set } = useQuestionSet()
  const visible = useMemo(() => orderedTags(set, tags), [set, tags])
  const pills = useMemo(() => listPills(set, visible), [set, visible])
  if (!pills.length) return null

  // Deux pastilles au plus : au-delà, la ligne ne dit plus rien de l'objet du mail. Le reste
  // se compte, et l'infobulle de ce compteur porte l'ENSEMBLE des étiquettes visibles du message.
  // Dans une colonne étroite, une pastille se TRONQUE (`min-w-0` + `truncate` sur son texte) et
  // l'ensemble cède avant ses voisins (`shrink-[3]`) ; le compteur, lui, ne cède jamais
  // (`shrink-0`) — avec `shrink-0` sur les pastilles, elles sortaient de la colonne et « +N »
  // passait hors écran à 390 px (gate du 03/10). ponytail: le plancher `min-w-[3.5rem]` est la
  // place de deux pastilles vides + « +NN » (mesuré 48 px à 320 px) ; un flex ne connaît pas le
  // minimum réel de ses enfants tronqués, sans ce plancher il écrasait le groupe sous ce seuil
  // et « +N » débordait. Un « +NNN » déborderait de quelques pixels : élargir le plancher alors.
  const shown = pills.slice(0, compact ? 1 : 2)
  const hidden = visible.length - shown.length
  const all = visible.map(describe).join('\n')

  return (
    <span className="flex min-w-[3.5rem] shrink-[3] items-center gap-1" data-tag-pills={pills.length}>
      {shown.map(tag => (
        <span
          key={tag.question}
          data-tag-pill={tag.question}
          title={describe(tag)}
          className="flex h-4 min-w-0 max-w-[10rem] items-center rounded border border-border bg-muted/60 px-1 text-[10px] leading-none text-muted-foreground"
        >
          <span className="truncate">{v(tag.valeur)}</span>
        </span>
      ))}
      {hidden > 0 && (
        <span data-tag-pill-more={hidden} title={all} className="flex h-4 shrink-0 items-center text-[10px] leading-none text-muted-foreground/70">
          {t('more', { count: hidden })}
        </span>
      )}
    </span>
  )
}

/** Une correction : la valeur choisie par un humain, pour cette question, sur ce message. */
type Correct = (question: string, valeur: string) => Promise<void>

/**
 * Une ligne du panneau : un libellé, sa valeur, et de quoi la corriger en UN clic.
 *
 * « Confirmer » écrit la valeur du moteur en `humain` : c'est ce qui la fait passer d'une réponse
 * de moteur à une étiquette validée par une main, donc ce n'est pas un geste vide.
 * Choisir une autre valeur en écrit une différente — dans les deux cas, la ligne du moteur reste
 * en base et reste LISIBLE en infobulle (décision 5).
 */
function TagRow({ tag, engine, history, correct, disabled }: {
  tag: StoredTag; engine: StoredTag | undefined; history: readonly StoredTag[]; correct: Correct; disabled: boolean
}) {
  const t = useTranslations('tags')
  const { q, v } = useTagLabels()
  const describe = useTagText()
  const origin = useOriginText()
  const { set } = useQuestionSet()
  const [busy, setBusy] = useState(false)
  const question = set.questionById(tag.question)
  if (!question) return null

  const confirmed = tag.source === HUMAN_SOURCE
  const run = async (valeur: string) => {
    if (busy || valeur === '') return
    setBusy(true)
    try { await correct(tag.question, valeur) } finally { setBusy(false) }
  }

  return (
    <div className="py-1 text-xs" data-tag-row={tag.question}>
    <div className="flex items-center gap-2">
      <span className="min-w-0 flex-1 truncate text-muted-foreground" title={describe(tag)}>
        {q(tag.question)}
      </span>
      <span
        className={cn('shrink-0 truncate', confirmed ? 'font-semibold text-foreground' : 'text-foreground/80')}
        // La valeur du moteur reste visible même après correction : c'est ce que le panneau doit
        // au lecteur qui compare, et c'est ce que la base conserve de toute façon.
        title={engine && engine.valeur !== tag.valeur ? t('engineSaid', { value: v(engine.valeur) }) : describe(tag)}
        data-tag-value={tag.valeur}
      >
        {v(tag.valeur)}
      </span>
      {!disabled && (
        <>
          {!confirmed && (
            <button
              type="button"
              onClick={() => run(tag.valeur)}
              disabled={busy}
              data-tag-confirm={tag.question}
              className="shrink-0 rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
            >
              {busy ? t('saving') : t('confirm')}
            </button>
          )}
          {/* `<select>` natif : la liste des valeurs d'une question est fermée et courte, le
              navigateur la rend déjà au clavier, au doigt et au lecteur d'écran. Sa valeur
              affichée reste `''` pour qu'il serve de bouton « Corriger » et non de miroir de
              l'étiquette, qui est déjà écrite à sa gauche. */}
          <select
            value=""
            onChange={e => run(e.target.value)}
            disabled={busy}
            aria-label={t('change')}
            data-tag-change={tag.question}
            className="shrink-0 rounded border border-border bg-transparent px-1 py-0.5 text-[10px] text-muted-foreground disabled:opacity-50"
          >
            <option value="">{t('change')}</option>
            {valuesOf(question).map(value => (
              <option key={value} value={value}>{v(value)}</option>
            ))}
          </select>
        </>
      )}
    </div>
    {/* L'HISTORIQUE des réponses à cette question (décision 23), replié : une ligne par
        origine, la plus récente en tête, la valeur et la date. `<details>` natif, comme le
        panneau lui-même. Une seule réponse n'a pas d'historique à montrer. */}
    {history.length > 1 && (
      <details className="ml-2 mt-0.5" data-tag-history={tag.question}>
        <summary className="cursor-pointer list-none text-[10px] text-muted-foreground/70 hover:text-foreground">
          {t('history', { count: history.length })}
        </summary>
        <ul className="mt-0.5 space-y-0.5">
          {history.map(h => (
            <li key={`${h.source}|${h.auteurId}|${h.modele}|${h.questionVersion}`}
              className="flex items-baseline gap-2 text-[10px] text-muted-foreground" data-tag-history-row={h.auteurId}>
              <span className="min-w-0 flex-1 truncate" title={describe(h)}>{origin(h)}</span>
              <span className={cn('shrink-0', h.source === HUMAN_SOURCE && 'font-semibold text-foreground/80')}>{v(h.valeur)}</span>
            </li>
          ))}
        </ul>
      </details>
    )}
    </div>
  )
}

/** Les champs dont la valeur se choisit dans une liste FERMÉE ; les autres se lisent dans le mail. */
const FIELD_CHOICES: Partial<Record<FieldName, readonly string[]>> = {
  type_montant: TYPE_MONTANT, type_echeance: TYPE_ECHEANCE, transporteur_suivi: CARRIERS,
}

/**
 * Une VALEUR extraite (décision 19) : libellé du champ, valeur, origine en infobulle, et de quoi
 * la corriger en un clic — les candidats que les regex avaient trouvés (les mêmes que le
 * moteur a vus), ou la liste fermée du champ, ou une valeur tapée (`prompt` natif : une
 * saisie par an ne justifie pas une modale). Pas de bouton « Confirmer » : une valeur lue n'a
 * rien à entraîner, la corriger suffit.
 */
function FieldRow({ field, correct, disabled }: { field: StoredField; correct: (champ: string, valeur: string) => Promise<boolean>; disabled: boolean }) {
  const t = useTranslations('tags')
  const origin = useOriginText()
  const [busy, setBusy] = useState(false)
  // La saisie que le serveur a REFUSÉE (422), montrée sous la ligne jusqu'à la prochaine tentative :
  // un refus muet laissait croire que la correction avait pris (gate T11).
  const [refused, setRefused] = useState<string | null>(null)
  const champ = field.question as FieldName
  const label = t.has(`f.${champ}`) ? t(`f.${champ}`) : champ
  const fv = (v: string) => (t.has(`fv.${v}`) ? t(`fv.${v}`) : v)
  const confirmed = field.source === HUMAN_SOURCE
  const choices = FIELD_CHOICES[champ]
  const options = choices ?? (field.candidats ?? []).map(c => c.valeur)

  const run = async (valeur: string) => {
    if (busy || valeur === '') return
    const chosen = valeur === '*' ? window.prompt(t('fieldPrompt', { field: label }), field.valeur)?.trim() : valeur
    if (!chosen) return
    setBusy(true)
    try { setRefused(await correct(champ, chosen) ? null : chosen) } finally { setBusy(false) }
  }

  return (
    <div className="py-1 text-xs" data-field-row={champ}>
    <div className="flex items-center gap-2">
      <span className="min-w-0 flex-1 truncate text-muted-foreground" title={origin(field)}>{label}</span>
      <span className={cn('shrink-0 truncate tabular-nums', confirmed ? 'font-semibold text-foreground' : 'text-foreground/80')}
        title={origin(field)} data-field-value={field.valeur}>
        {choices ? fv(field.valeur) : field.valeur}
      </span>
      {!disabled && (
        <select value="" onChange={e => run(e.target.value)} disabled={busy} aria-label={t('change')} data-field-change={champ}
          className="shrink-0 rounded border border-border bg-transparent px-1 py-0.5 text-[10px] text-muted-foreground disabled:opacity-50">
          <option value="">{busy ? t('saving') : t('change')}</option>
          {options.map(v => <option key={v} value={v}>{choices ? fv(v) : v}</option>)}
          {!choices && <option value="*">{t('fieldOther')}</option>}
        </select>
      )}
    </div>
    {refused !== null && (
      <p className="mt-0.5 text-[10px] text-destructive" role="alert" data-field-refused={champ}>{t('fieldRefused', { value: refused })}</p>
    )}
    </div>
  )
}

/**
 * Le panneau du volet de lecture, replié. `<details>` natif : le pli est un état du navigateur,
 * donc rien à tenir en React, rien à ré-ouvrir à chaque message, et il reste ouvrable au
 * clavier. Les étiquettes sont rangées par GROUPE de `questions.ts`, groupes vides omis.
 *
 * Le panneau lit ses étiquettes LUI-MÊME (une requête par message ouvert, et seulement quand il
 * en est un). C'est ce qui lui permet d'être posé tel quel dans le volet de lecture ET sur
 * chaque message déplié d'une conversation, sans que l'appelant recâble un chargement : une
 * seule source pour ce qu'une étiquette affiche et pour la façon de la corriger.
 */
export function TagsPanel({ message, accountId, canOrganize }: {
  message: Message
  accountId: string
  canOrganize: boolean
}) {
  const t = useTranslations('tags')
  const { g } = useTagLabels()
  const { set } = useQuestionSet()
  // `effective` = ce que le panneau affiche (décision 5) ; `tags` = toutes les sources, ce qui
  // fait tenir « le moteur a dit » en infobulle. Un mail sans `Message-ID` n'a pas de clé côté
  // client : rien n'est demandé (et la correction est refusée, voir plus bas).
  const fetcher = async (url: string) => {
    const res = await fetch(url)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return res.json()
  }
  const { data, mutate } = useSWR<{ data: { tags: StoredTag[]; effective: StoredTag[] } }>(
    message.messageId ? `/api/messages/${encodeURIComponent(message.messageId)}/tags?account=${encodeURIComponent(accountId)}` : null,
    fetcher,
  )
  // Les VALEURS extraites, lues à côté (décision 19) : même clé de message, même boîte.
  const fieldsUrl = message.messageId ? `/api/messages/${encodeURIComponent(message.messageId)}/fields?account=${encodeURIComponent(accountId)}` : null
  const { data: fieldsData, mutate: mutateFields } = useSWR<{ data: { effective: StoredField[] } }>(fieldsUrl, fetcher)
  const fields = fieldsData?.data.effective ?? []
  // Le jeu ACTIF seulement : une question désactivée n'a ni ligne ni part au compteur.
  const tags = useMemo(() => orderedTags(set, data?.data.effective ?? []), [set, data])
  const groups = useMemo(() => tagsByGroup(set, tags), [set, tags])
  const engineByQuestion = useMemo(
    () => new Map((data?.data.tags ?? []).filter(tag => tag.source !== HUMAN_SOURCE).map(tag => [tag.question, tag])),
    [data],
  )
  // Toutes les lignes, par question, dans l'ordre du serveur (l'effective d'abord, puis par
  // date) : c'est l'historique que chaque ligne du panneau replie sous elle.
  const historyByQuestion = useMemo(() => {
    const map = new Map<string, StoredTag[]>()
    for (const tag of data?.data.tags ?? []) map.set(tag.question, [...(map.get(tag.question) ?? []), tag])
    return map
  }, [data])

  // Un mail SANS `Message-ID` n'a pas d'identifiant côté client : le repli dérivé de la
  // décision 6 est un sha256 calculé par `store.ts`, côté serveur, et le recalculer ici en
  // ferait une seconde source. La correction est donc refusée dans ce cas (bouton désactivé)
  // plutôt qu'écrite sous une clé approximative. Mesuré sur la base de la lane le 27/09/2026 :
  // 0 des 2 900 lignes de `messages_cache` ont un `message_id` vide.
  const correct: Correct = async (question, valeur) => {
    const res = await fetch(`/api/messages/${encodeURIComponent(message.messageId)}/tags`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      // La position accompagne la correction : c'est elle qui permettra au filtre de retrouver
      // ce mail une fois sorti de la page chargée (`tagged_messages`).
      body: JSON.stringify({
        accountId: message.accountId, tags: [{ question, valeur }],
        folder: message.folder, uid: Number(message.uid),
        fromName: message.from.name, fromAddress: message.from.address,
        subject: message.subject, date: message.date,
      }),
    })
    if (res.ok) mutate()
  }
  const correctField = async (champ: string, valeur: string): Promise<boolean> => {
    const res = await fetch(`/api/messages/${encodeURIComponent(message.messageId)}/fields`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountId: message.accountId, fields: [{ champ, valeur }] }),
    })
    if (res.ok) mutateFields()
    return res.ok
  }

  return (
    <details className="group border-b border-border" data-tags-panel>
      <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-2 text-xs text-muted-foreground transition-colors hover:bg-muted/50">
        <Tags className="h-3.5 w-3.5 shrink-0" />
        <span className="font-medium">{t('panelTitle')}</span>
        <span className="tabular-nums text-muted-foreground/70">{(tags.length + fields.length) || ''}</span>
      </summary>
      <div className="px-4 pb-3">
        {!tags.length && !fields.length ? (
          <p className="text-xs text-muted-foreground/70">{t('none')}</p>
        ) : (
          groups.map(({ group, tags: groupTags }) => (
            <div key={group} className="mt-2 first:mt-0">
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground/60">{g(group)}</p>
              {groupTags.map(tag => (
                <TagRow
                  key={tag.question}
                  tag={tag}
                  engine={engineByQuestion.get(tag.question)}
                  history={historyByQuestion.get(tag.question) ?? []}
                  correct={correct}
                  disabled={!canOrganize || !message.messageId}
                />
              ))}
            </div>
          ))
        )}
        {fields.length > 0 && (
          <div className="mt-2" data-fields-panel={fields.length}>
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground/60">{t('fieldsTitle')}</p>
            {fields.map(field => (
              <FieldRow key={field.question} field={field} correct={correctField} disabled={!canOrganize || !message.messageId} />
            ))}
          </div>
        )}
      </div>
    </details>
  )
}
