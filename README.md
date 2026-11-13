# Nous Deux 💕

L'appli privée de **Dali & Rahma**, ensemble depuis le 15 septembre 2025.

## Fonctionnalités

- 🔐 **Code secret** choisi à la première ouverture (stocké haché, 10 essais ratés max par 15 min).
- ⏳ **Compteur** depuis le 15/09/2025, prochain « moisiversaire » et prochain cap des 100 jours.
- 📅 **Dates importantes** avec compte à rebours (anniversaires, rendez-vous…).
- 😊 **Humeur du jour** de chacun.
- 💌 **Petits mots** avec « vu » et cœur.
- 📝 **Listes partagées** : courses, films, restos, sorties, voyages, et **idées cadeaux secrètes** (invisibles pour l'autre).
- 🎲 **« On fait quoi ce soir ? »** : tirage au sort dans les films, restos et sorties.
- 💶 **Comptes** : qui a payé quoi, qui doit combien, remboursement en un clic.
- ❓ **Question du jour** : on voit la réponse de l'autre seulement après avoir répondu.
- 📲 S'installe sur l'écran d'accueil comme une vraie appli.

## Structure

- `index.html` : l'appli.
- `api/nous.js` : l'API (prénoms, date de début et questions en haut du fichier).
- `api/_lib.js` : stockage Upstash Redis et outils HTTP.
- `manifest.webmanifest` et `*.png` : installation sur l'écran d'accueil.

## Hébergement

Vercel + **Upstash for Redis** (onglet Storage du projet). Chaque push sur `main` est mis en ligne automatiquement.
Les données de l'appli sont permanentes dans Upstash.
