# Croquis Express

Jeu de dessin multijoueur : chaque joueur joue **sur son propre téléphone**.
Tout le monde dessine le même mot en même temps, un seul joueur devine, et les dessins les plus rapides passent en premier.

## Structure

- `index.html` : le jeu (interface).
- `api/room.js` : petite API serverless (Vercel) qui synchronise les parties entre les téléphones.
- `api/_words.js` : les listes de mots (côté serveur, pour que le devineur ne puisse pas les lire).

L'état des parties est stocké dans **Upstash Redis** (offre gratuite suffisante).

## Mise en ligne sur Vercel

1. Importer le repo dans Vercel (Framework Preset : **Other**, aucune commande de build).
2. Dans le projet Vercel : onglet **Storage** → **Create Database** (ou *Marketplace*) → **Upstash for Redis** → offre gratuite → **Connect** au projet.
   Vercel ajoute automatiquement les variables `KV_REST_API_URL` et `KV_REST_API_TOKEN`.
3. **Redéployer** (onglet *Deployments* → ⋯ → *Redeploy*) pour que l'API voie ces variables.

## Jouer

1. Un joueur ouvre le site, entre son prénom et appuie sur **Créer une partie**.
2. Les autres scannent le QR code, ouvrent le lien d'invitation, ou tapent le code à 4 lettres.
3. L'hôte (👑) choisit les réglages et lance la partie (3 à 8 joueurs).

## Tester en local

`vercel dev` (avec la CLI Vercel) lance le site et l'API. Sans variables Upstash, l'API utilise un stockage en mémoire, pratique pour tester en local.

## Déploiement automatique

Le projet Vercel est relié à ce repo GitHub : chaque push sur la branche de production est mis en ligne automatiquement (environ 30 s).
