#!/usr/bin/env node
/**
 * Guard on the right-click menu's SURFACE and its submenus (`components/ui/ContextMenu.tsx`,
 * `components/ui/MessageContextMenu.tsx`). Read on the shipped sources, no server, no account:
 * the defects this covers were all reported in production and every one of them is a property
 * of the code, not of a mailbox.
 *
 * What it refuses:
 *  1. a scroll listener that closes the menu unconditionally — scrolling the menu's OWN folder
 *     list closed it, which is exactly the gesture of someone looking for a folder;
 *  2. a submenu that exists only on CSS hover — grabbing its scrollbar or crossing diagonally
 *     made it vanish;
 *  3. a submenu panel that is never brought back inside the window;
 *  4. a folder list on a bare `overflow-y-auto` instead of the app's `ThinScroll`;
 *  5. a filter that re-implements `foldText` instead of reusing the omnibar's.
 *
 * Exit 0 when every property holds, 1 otherwise. Node built-ins only.
 *
 *   node scripts/check-context-menu.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = name => readFileSync(new URL(`../components/ui/${name}`, import.meta.url), 'utf8')
const surface = read('ContextMenu.tsx')
const message = read('MessageContextMenu.tsx')

/** 1. A scroll inside the menu (or its panel) must NOT close it. */
assert.ok(!/addEventListener\('scroll', onClose/.test(surface),
  'the scroll listener still closes the menu unconditionally — scrolling its own folder list would close it')
const scrollHandler = surface.slice(surface.indexOf('const onScroll = (e: Event)'))
assert.ok(/inside\(node\)\)\s*return/.test(scrollHandler.slice(0, scrollHandler.indexOf('}\n'))),
  'the scroll handler must return early for a scroll that happens INSIDE the menu')
assert.ok(/panelRef\.current\?\.contains\(node\)/.test(surface),
  'the open submenu panel must count as inside the menu (it lives in the portal, not under the surface)')

/** 2. The submenu is state-driven, not a CSS hover. */
assert.ok(!/group-hover:block/.test(surface),
  'the submenu is still a pure CSS hover — it disappears when the pointer leaves the row')
assert.ok(/ctx\?\.openKey === itemKey/.test(surface), 'the submenu must read its open state from the surface')
assert.ok(/SUBMENU_SWITCH_MS/.test(surface) && /closeTimer\.current = setTimeout/.test(surface),
  'switching away from an open panel must be DELAYED, so a diagonal crossing can still reach it')
assert.ok(/onMouseEnter=\{\(\) => ctx\?\.request\(null\)\}/.test(surface),
  'hovering a plain entry must ask the open panel to give way')
assert.ok(/onClick=\{\(\) => \(open \? ctx\?\.close\(\) : ctx\?\.open\(itemKey\)\)\}/.test(surface),
  'the submenu must open on click as well as on hover')

/** 3. The panel is clamped inside the window, on both axes. */
const place = surface.slice(surface.indexOf('const place = useCallback'))
const body = place.slice(0, place.indexOf('}, [rowRef])'))
assert.ok(/window\.innerWidth/.test(body), 'the panel must flip to the left when it would leave the window on the right')
assert.ok(/window\.innerHeight/.test(body), 'the panel must be pulled up when it would leave the window at the bottom')

/** 4. The folder list scrolls through the app's own scrollbar. */
assert.ok(/<ThinScroll/.test(message), 'the folder list must use ThinScroll, whose thumb is grabbable')
assert.ok(!/max-h-64 overflow-y-auto/.test(message), 'the bare native scroll area is still there')

/** 5. The filter reuses the omnibar's normalisation rather than copying it. */
assert.ok(/import \{ foldText \} from '@\/lib\/omnibarCommands'/.test(message),
  'the folder filter must reuse foldText from lib/omnibarCommands')
assert.ok(!/normalize\('NFD'\)/.test(message), 'the folder filter re-implements accent folding instead of reusing foldText')
assert.ok(/data-menu-folder-filter/.test(message), 'the filter field must be addressable by the browser bench')
assert.ok(/inputRef\.current\?\.focus\(\)/.test(message), 'the filter must take the focus when the submenu opens')

console.log('check-context-menu: OK')
