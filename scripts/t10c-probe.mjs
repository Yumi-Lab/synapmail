const { query } = await import('../lib/db.ts')
console.log('mailbox:', JSON.stringify(await query("SELECT account_id, bulk_state, engine_id IS NOT NULL AS eng, live, tagged, skipped FROM mailbox_tagging")))
console.log('banc rows left:', JSON.stringify(await query("SELECT COUNT(*) n FROM message_tags WHERE message_id LIKE '<banc-t3-%'")))
process.exit(0)
