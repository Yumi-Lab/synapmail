# Chercher dans le corps des mails — note de décision

Nicolas, 20/09/2026 : « recherche dans le corps des mails, à rajouter, voir comment ça pourrait être
rapide, j'ai peur de cette fonctionnalité ».

Cette note ne construit rien. Elle rassemble les chiffres mesurés sur le vrai serveur et la vraie
base, pour que la décision se prenne sur des nombres. **Le point à trancher est à la fin, et il
n'est pas technique.**

Les deux sondes qui produisent ces chiffres sont rejouables, en lecture seule :

```
node --experimental-strip-types scripts/probe-search-body.mjs
node --experimental-strip-types scripts/probe-body-index.mjs
```

## 1. Le serveur, lui, refuse — et il le dit

Mesuré le 20/09/2026 sur `imap.ionos.fr:993`, avec un mot de 6 lettres présent dans le CORPS d'un
message de la boîte et absent de tous ses en-têtes cherchables :

| Commande | Réponse du serveur | Durée |
|---|---|---|
| `UID SEARCH BODY <mot>` | `NO full text search not supported` | 454 ms |
| `UID SEARCH CHARSET UTF-8 BODY <mot>` | `NO full text search not supported` | 447 ms |
| `UID SEARCH TEXT <mot>` | `NO full text search not supported` | 1 216 ms |
| `UID SEARCH CHARSET UTF-8 TEXT <mot>` | `NO full text search not supported` | 1 233 ms |
| RÉFÉRENCE, même run — `SEARCH SUBJECT <mot>` | **107 093 résultats** | 17 187 ms |

La ligne de référence est ce qui rend les quatre autres lisibles : la même connexion, la même
seconde, la même boîte, répond normalement à une recherche sur l'objet. Le refus vient donc bien du
critère, pas de la sonde.

**Deux corrections à ce qu'on croyait depuis le 19/09** — la doc `docs/SEARCH.md` disait « `BODY` et
`TEXT` renvoient 0 résultat » et « ajouter `body` au `OR` fait tomber le `OR` entier à 0 » :

1. Ce n'est pas « 0 résultat », c'est un **refus explicite**. `imapflow` traduit le `NO` du serveur en
   `false`, que le code lisait comme « aucun résultat ». La différence compte : un serveur qui répond
   0 pourrait chercher et ne rien trouver ; celui-ci dit qu'il ne sait pas faire.
2. Le `OR` **n'est pas empoisonné**. Mesuré trois fois d'affilée sur le plus gros dossier, le `OR` du
   produit encadrant la version élargie : **163 765** sans le terme de corps, **163 769** avec,
   **163 765** de nouveau — dérive de la boîte entre les deux références : **0 message**. L'écart de
   +4 est reproductible et n'est donc pas du bruit, mais il va dans le sens inverse d'un
   empoisonnement. L'observation du 19/09 portait vraisemblablement sur une autre forme de requête.

Conséquence : sur ce serveur, **chercher dans le corps ne peut pas se faire côté serveur**. Il n'y a
pas de réglage à trouver. La seule voie restante est un **index local**.

## 2. Ce que coûterait un index local

Mesuré le 20/09/2026, PostgreSQL 16, `tsvector` + index GIN natifs (aucune dépendance nouvelle),
sur la boîte de test (7 dossiers, **164 003 messages**) et un échantillon de 200 messages réels :

**Le texte à stocker**

| | |
|---|---|
| Texte utile par message (brut, HTML dépouillé, plafonné à 16 Kio) | moyenne **7 229 o** · médiane **1 848 o** · p90 et p99 **16 384 o** |
| Messages tronqués par le plafond de 16 Kio | **64 sur 200**, soit près d'un tiers |
| Texte total pour cette boîte | **≈ 1,1 Gio** |

La médiane à 1,8 Kio contre une moyenne à 7,2 Kio dit l'essentiel : la plupart des messages sont
courts, une minorité pèse tout le poids. Le plafond est donc un vrai arbitrage — à 16 Kio, un message
sur trois est coupé, et ce qui est coupé n'est pas cherchable.

**La première indexation**

| | |
|---|---|
| Débit de lecture mesuré (FETCH IMAP) | **9,1 ms/message** |
| Pour cette boîte, en un seul flux | **≈ 25 min** |

C'est le débit IMAP qui borne, pas l'écriture en base. Sur la vraie boîte de Nicolas
(nicolas@3d-expert.fr, 1 226 dossiers), ce chiffre est à remesurer : il sera plus élevé.

**La recherche, une fois l'index construit** (200 000 lignes synthétiques du même volume)

| | |
|---|---|
| RÉFÉRENCE — la même requête SANS index, même table, même run | **43 376 ms** (balayage complet) |
| La même requête AVEC l'index GIN | **1 ms** |
| Construction de l'index | 43 838 ms |
| Taille de l'index | 23,4 Mio pour 200 000 lignes, soit **≈ 19 Mio** extrapolés pour cette boîte |

La référence sans index est ce qui donne son sens au « 1 ms » : sur la même machine, la même table et
la même requête, l'écart est de quatre ordres de grandeur. Techniquement, **un index local rend la
recherche dans le corps instantanée.**

**Ce que ce chiffre de 19 Mio ne dit pas** : les lignes synthétiques répètent un même jeton, donc
elles contiennent très peu de mots distincts. Un index GIN sur de la vraie prose en contient beaucoup
plus. **19 Mio est un plancher, pas une estimation** — le vrai chiffre ne s'obtient qu'en indexant du
vrai texte, c'est-à-dire en le stockant. Il reste petit devant le 1,1 Gio de texte : c'est le TEXTE
qui coûte, pas l'index.

## 3. Le point que seul Nicolas peut trancher

Rien de ce qui précède n'est un obstacle technique. Le seul obstacle est celui-ci :

> **Un index local STOCKE le texte des mails sur le serveur.** Environ 1,1 Gio pour une seule boîte de
> test. Or le choix d'origine de ce webmail était « aucun mail stocké sur le serveur » : aujourd'hui
> le cache (`messages_cache`) ne garde qu'un extrait de 200 caractères, jamais le corps.

Indexer le corps, c'est renoncer à cette propriété. Une base compromise cesse d'exposer des
métadonnées pour exposer le contenu des correspondances — et pour toutes les boîtes, y compris celles
reçues en partage. Le chiffrement de la base repousse le problème sans le supprimer : le serveur doit
pouvoir lire l'index pour s'en servir.

Trois voies, aucune n'est recommandée ici — c'est la décision de Nicolas :

1. **Ne rien faire.** La recherche reste sur expéditeur / destinataires / copie / objet, et le dit.
   Coût nul, propriété « aucun mail stocké » conservée. C'est l'état actuel.
2. **Index local, sur demande et par boîte.** Rien n'est indexé tant que la personne ne l'a pas
   demandé POUR une boîte donnée ; ce qui est indexé est effaçable d'un geste. ≈ 25 min et ≈ 1,1 Gio
   par boîte de cette taille, recherche à 1 ms. La propriété devient « aucun mail stocké, sauf ceux
   que vous avez explicitement demandé à indexer ».
3. **Index local plafonné dans le temps.** Idem, mais borné aux N derniers mois : le volume et la
   durée tombent proportionnellement, et la recherche dans le corps ne marche que sur la période
   couverte — ce qu'il faudra dire clairement dans l'interface, sous peine de faire croire à une
   absence de résultat là où il n'y a qu'une absence d'index.

Une remarque de méthode : quelle que soit la voie choisie, les chiffres ci-dessus valent pour la
boîte de TEST (164 003 messages, 7 dossiers). La vraie boîte de Nicolas en compte 1 226 dossiers ; les
deux sondes sont faites pour être rejouées sur elle avant toute décision d'ingénierie.
