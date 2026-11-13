# Salle de Jeux

Des jeux de soirée multijoueurs : chaque joueur joue **sur son propre téléphone**.

| Jeu | Adresse | Principe |
|---|---|---|
| ✏️ Croquis Express | `/croquis/` | Tout le monde dessine le même mot le plus vite possible, un seul devine. |
| 🎤 Karaoké Battle | `/karaoke/` | Chacun chante à son tour (avec des défis), le public réagit en direct et note de 1 à 5 étoiles. |

## Structure

- `index.html` : la galerie des jeux (page d'accueil).
- `croquis/index.html` et `api/room.js` (+ `api/_words.js`) : Croquis Express.
- `karaoke/index.html` et `api/karaoke.js` : Karaoké Battle.
- `api/_lib.js` : outils communs (stockage Redis, HTTP).

L'état des parties est stocké dans **Upstash Redis** (offre gratuite suffisante).
Le karaoké n'embarque aucune parole : le chanteur trouve la version karaoké sur YouTube (lien de recherche ou lien collé, lu directement dans la page).

## Mise en ligne sur Vercel

1. Importer le repo dans Vercel (Framework Preset : **Other**, aucune commande de build).
2. Dans le projet Vercel : onglet **Storage** → **Create Database** (ou *Marketplace*) → **Upstash for Redis** → offre gratuite → **Connect** au projet.
   Vercel ajoute automatiquement les variables `KV_REST_API_URL` et `KV_REST_API_TOKEN`.
3. **Redéployer** (onglet *Deployments* → ⋯ → *Redeploy*) pour que l'API voie ces variables.

## Jouer

1. Un joueur ouvre le site, choisit un jeu, entre son prénom et appuie sur **Créer une partie**.
2. Les autres scannent le QR code, ouvrent le lien d'invitation, ou tapent le code à 4 lettres.
3. L'hôte (👑) choisit les réglages et lance la partie.

## Tester en local

`vercel dev` (avec la CLI Vercel) lance le site et l'API. Sans variables Upstash, l'API utilise un stockage en mémoire, pratique pour tester en local.

## Déploiement automatique

Le projet Vercel est relié à ce repo GitHub : chaque push sur la branche `main` est mis en ligne automatiquement (environ 30 s).
