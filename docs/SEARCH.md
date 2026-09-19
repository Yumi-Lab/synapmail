# Comment fonctionne la recherche

Ce que le champ de recherche cherche, comment il découpe une requête, où il regarde, et ce qu'il ne
peut pas faire. Le contrat vit dans `lib/search.ts` — les valeurs citées ici en sont extraites, elles
ne sont jamais recopiées ailleurs dans le code.

## Les champs cherchés

Un terme est cherché dans **l'expéditeur, les destinataires, la copie et l'objet**
(`SEARCH_FIELDS = ['from', 'to', 'cc', 'subject']`), côté serveur, par un `SEARCH` IMAP.

**Le corps des messages n'est PAS cherché.** Ce n'est pas un choix d'ergonomie, c'est une mesure : sur
IONOS, les critères `BODY` et `TEXT` renvoient **0 résultat** — et, pire, ajouter `body` au `OR` fait
tomber le `OR` entier à 0, c'est-à-dire que chercher « dans plus de champs » ne rendait plus rien du
tout. La bannière le dit à la personne quand une recherche ne donne aucun résultat.

Avant de rétablir la recherche dans le corps sur un autre serveur, il faut la MESURER sur ce serveur :
`scripts/check-search-capability.mjs` lit ce que le serveur annonce.

## Comment une requête est découpée

`parseQuery(q)` (fonction pure, auto-contrôlée par `scripts/check-search-parse.mjs`) :

- **plusieurs mots = ET** — chaque mot doit se trouver dans au moins un des champs ci-dessus, dans
  n'importe quel ordre : « 3d cpi » et « cpi 3d » donnent le même ensemble ;
- **les guillemets** gardent une sous-chaîne exacte : `"3d cpi"` ne trouve que cette suite-là ;
- la casse et les espaces multiples sont ignorés, les doublons sont fondus ;
- un mot de **moins de 2 caractères** est ignoré (il ramènerait la boîte entière).

## Où l'on cherche : la portée

Deux portées, écrites dans l'URL (`scope=folder` par défaut, `scope=all`) :

- **ce dossier** — un `SELECT` + un `SEARCH` sur le dossier ouvert ;
- **tous les dossiers** — les dossiers sont parcourus **dans l'ordre de leur utilité** (boîte de
  réception, envoyés, puis les autres par date du dernier message connu du cache), et les résultats
  sont **diffusés au fil de l'eau** (NDJSON) : les premières lignes s'affichent pendant que la
  recherche continue. La bannière avance (« 5 dossiers sur 23 ») et un bouton **Arrêter** interrompt
  le flux ; la liste déjà reçue reste à l'écran.

Changer de requête, ou quitter la page, annule proprement le flux en cours (`AbortController` côté
navigateur, fermeture des connexions IMAP côté serveur).

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

Elle ne cherche pas dans les pièces jointes, ni dans le corps (voir plus haut), et un dossier que le
serveur refuse d'ouvrir est sauté sans faire échouer la recherche. Les mesures de cette page ont été
prises sur **IONOS** : un autre serveur peut répondre autrement, et rien ici ne permet de l'extrapoler.
