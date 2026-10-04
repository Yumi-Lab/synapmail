import RulesClient from '@/components/settings/RulesClient'
import { readRulePrefill } from '@/lib/rulePrefill'

export default function RulesPage({ searchParams }: { searchParams: Record<string, string | undefined> }) {
  return <RulesClient prefill={readRulePrefill(key => searchParams[key])} />
}
