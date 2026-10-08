# Comment fonctionne la recherche

Ce que le champ de recherche cherche, comment il découpe une requête, où il regarde, et ce qu'il ne
peut pas faire. Le contrat vit dans `lib/search.ts` — les valeurs citées ici en sont extraites, elles
ne sont jamais recopiées ailleurs dans le code.

## Les champs cherchés

Un terme est cherché dans **l'expéditeur, les destinataires, la copie et l'objet**
(`SEARCH_FIELDS = ['from', 'to', 'cc', 'subject']`), côté serveur, par un `SEARCH` IMAP.

**Le corps des messages n'est PAS cherché.** Ce n'est pas un choix d'ergonomie, c'est une mesure : sur
IONOS, les critères `BODY` et `TEXT` sont REFUSÉS par le serveur, qui répond
`NO full text search not supported` (mesuré le 20/09/2026, contre une recherche sur l'objet qui
répond normalement dans le même run). La bannière le dit à la personne quand une recherche ne donne
aucun résultat.

Avant de rétablir la recherche dans le corps sur un autre serveur, il faut la MESURER sur ce serveur :
`scripts/check-search-capability.mjs` lit ce que le serveur annonce, et
`scripts/probe-search-body.mjs` lui pose directement la question. Ce que coûterait un index local, et
le choix de fond qu'il engage, sont chiffrés dans [RECHERCHE-CORPS.md](RECHERCHE-CORPS.md).

## Comment une requête est découpée

`parseQuery(q)` (fonction pure, auto-contrôlée par `scripts/check-search-parse.mjs`) :

- **plusieurs mots = ET** — chaque mot doit se trouver dans au moins un des champs ci-dessus, dans
  n'importe quel ordre : « 3d cpi » et « cpi 3d » donnent le même ensemble ;
- **les guillemets** gardent une sous-chaîne exacte : `"3d cpi"` ne trouve que cette suite-là ;
- la casse et les espaces multiples sont ignorés, les doublons sont fondus ;
- un mot de **moins de 2 caractères** est ignoré (il ramènerait la boîte entière).

## Où l'on cherche : la portée

Trois portées, écrites dans l'URL (`SEARCH_SCOPES` : `scope=folder` par défaut, `scope=all`,
`scope=accounts`) :

- **ce dossier** — un `SELECT` + un `SEARCH` sur le dossier ouvert ;
- **tous les dossiers** — les dossiers de la boîte courante sont parcourus **dans l'ordre de leur
  utilité** (boîte de réception, envoyés, puis les autres par date du dernier message connu du
  cache), et les résultats sont **diffusés au fil de l'eau** (NDJSON) : les premières lignes
  s'affichent pendant que la recherche continue. La bannière avance (« 5 dossiers sur 23 ») et un
  bouton **Arrêter** interrompt le flux ; la liste déjà reçue reste à l'écran ;
- **toutes les boîtes** — le même flux, étendu à **toutes les boîtes accessibles** : les siennes,
  plus celles reçues en partage actif et non expiré. Quelles boîtes exactement, c'est la règle
  d'accès du produit qui le dit, et elle n'est écrite qu'à UN endroit
  (`ACTIVE_SHARE_SQL` / `listAccessibleAccounts` dans `lib/accountAccess.ts`, gardés par
  `scripts/check-share-rule.mjs`) : une boîte qu'on ne peut pas ouvrir ne peut pas être cherchée.
  La boîte active passe en premier, puis `ACCOUNT_CONCURRENCY` boîtes au plus sont ouvertes de
  front, chacune en deux passes (réception + envoyés d'abord). Une boîte injoignable n'arrête pas
  les autres : elle est signalée en fin de flux.

Changer de requête, ou quitter la page, annule proprement le flux en cours (`AbortController` côté
navigateur, fermeture des connexions IMAP côté serveur).

## L'identité d'un résultat

Un `uid` n'est unique que DANS un dossier d'une boîte : deux messages sans rapport peuvent porter
l'uid 3231 dans « Réception » et dans « Objets envoyés ». Dès que la portée sort du dossier affiché
(`isWideScope`), la liste mêle des origines — un résultat ne se désigne donc jamais par son uid seul.

Tout le parcours (ouvrir, cocher, agir, glisser, transférer) transporte le **triplet**
`{ accountId, folder, uid }` (`MessageOrigin` dans `lib/mailOrigin.ts`, source unique), et les
requêtes se construisent à partir de lui. C'est ce qui fait qu'un résultat trouvé dans « Objets
envoyés » s'OUVRE dans « Objets envoyés », et qu'une suppression porte sur le message affiché et non
sur son homonyme du dossier courant.

## Les plafonds, et pourquoi ils sont là

- **200 résultats affichés** (`SEARCH_RESULT_LIMIT`), les plus récents d'abord. La bannière ne le cache
  pas : « 2 406 résultats · 200 affichés ». `total` compte **toutes** les correspondances, pas
  seulement celles qui tiennent à l'écran.
- **Pas d'index plein texte local.** Ce serait la seule façon de chercher dans le corps sur un serveur
  qui refuse `BODY`, mais cela veut dire stocker les corps de tous les messages de toutes les boîtes
  dans PostgreSQL, les tenir synchronisés, et assumer ce que cela représente en volume et en
  confidentialité. `ponytail:` plafond connu, chemin d'évolution = décision produit à prendre
  explicitement, pas un détail d'implémentation.

## Ce que la recherche ne dit pas

Elle ne cherche pas dans les pièces jointes, ni dans le corps (voir plus haut) ; un dossier que le
serveur refuse d'ouvrir est sauté sans faire échouer la recherche, et une boîte injoignable l'est
aussi. Le plafond de 200 résultats vaut **par dossier interrogé** : en portée large, la liste en
garde les 200 plus récents tous dossiers confondus, et `total` compte toutes les correspondances. Les mesures de cette page ont été
prises sur **IONOS** : un autre serveur peut répondre autrement, et rien ici ne permet de l'extrapoler.
