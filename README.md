# Nous Deux 💕

L'appli privée de **Dali & Rahma**, ensemble depuis le 15 septembre 2025, à distance.

## Fonctionnalités

- 🔐 **Code secret** choisi à la première ouverture (stocké haché, 10 essais ratés max par 15 min).
- ⏳ **Compteur** depuis le 15/09/2025 et prochain « moisiversaire ».
- ✈️ **Retrouvailles** : compte à rebours jusqu'au jour où vous vous revoyez.
- 🕐 **Heure chez l'autre** quand vous n'êtes pas dans le même fuseau horaire.
- 😊 **Humeurs** à envoyer (dont 😈 « Envie de toi »), reçues en notification.
- 💌 **Petits mots** avec « vu » et cœur, reçus en notification.
- 📸 **Souvenirs** : photos façon polaroid, avec une légende et des petits mots écrits dessus.
- 📅 **Dates importantes** avec compte à rebours.
- ❓ **Question du jour** : on voit la réponse de l'autre seulement après avoir répondu.
- 💶 **Comptes** à deux.
- 🔔 **Notifications push** (Android, et iPhone une fois l'appli ajoutée à l'écran d'accueil, iOS 16.4+).

## Structure

- `index.html` : l'appli.
- `sw.js` : service worker (réception des notifications).
- `api/nous.js` : l'API (prénoms, date de début, questions en haut du fichier).
- `api/_lib.js` : stockage Upstash Redis et outils HTTP.
- `manifest.webmanifest` et `*.png` : installation sur l'écran d'accueil.
- `package.json` : dépendance `web-push` (installée automatiquement par Vercel).

## Hébergement

Vercel + **Upstash for Redis** (onglet Storage du projet). Chaque push sur `main` est mis en ligne automatiquement.
Les clés des notifications (VAPID) sont générées automatiquement au premier lancement et stockées dans Upstash.
