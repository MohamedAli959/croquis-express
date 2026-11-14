# Nous Deux 💕

L'appli privée de **Dali & Rahma**, ensemble depuis le 15 septembre 2025, à distance.

Fonctionnalités inspirées des applis pour couples à distance (Paired, Together, Long Goodbye, Letterbox…).

## Fonctionnalités

- 🔐 **Code secret** choisi à la première ouverture (stocké haché, 10 essais ratés max par 15 min).
- ⏳ **Compteur** depuis le 15/09/2025 et prochain « moisiversaire ».
- ✈️ **Retrouvailles** : compte à rebours jusqu'au jour où vous vous revoyez.
- 🕐 **Heure chez l'autre** quand vous n'êtes pas dans le même fuseau horaire.
- 😊 **Humeurs** à envoyer (dont 😈 « Envie de toi »), reçues en notification.
- 📸 **Snaps du jour** : photo (appareil ou galerie) avec une petite note par-dessus, notification, « vu », disparaît après 24 h sauf si on la garde dans les souvenirs.
- 💗 **« Je pense à toi »** : un cœur à toucher, l'autre reçoit une notification et voit le compteur du jour.
- 💌 **Petits mots** avec « vu » et cœur, **messages vocaux** (2 min max, réécoute avant envoi) et **dessins à la main**, reçus en notification.
- ✉️ **Lettres « Ouvre quand… »** (tu es triste, je te manque…) et **lettres datées** qui ne s'ouvrent qu'à une date précise.
- 🫙 **Bocal « Pourquoi je t'aime »** : chacun remplit le bocal de l'autre, qui tire un papier quand il veut.
- 🗺️ **Carte avec vos visages** : chacun partage volontairement sa position (précise ou ~1 km), mise à jour à l'ouverture de l'appli ; photo de profil, ligne entre vous, distance et météo chez l'autre (Leaflet, fond de carte OpenStreetMap assombri, météo Open-Meteo).
- 📸 **Souvenirs** : photos façon polaroid, avec une légende et des petits mots écrits dessus.
- 📅 **Dates importantes** avec compte à rebours.
- ❓ **Question du jour** : on voit la réponse de l'autre seulement après avoir répondu.
- 🎁 **Surprises programmées** : un mot qui arrive à la date et l'heure choisies (livré dès que l'un de vous ouvre l'appli après l'heure prévue, ou par un appel à `/api/nous?tick=1`).
- 📖 **Notre histoire** : frise de vos grands moments, avec photos.
- 🎵 **Notre playlist** : les chansons qui vous font penser l'un à l'autre.
- 🌙 **Bonne nuit / ☀️ Bonjour** : on voit quand l'autre dort.
- 🔥 **Série** de jours d'affilée où vous vous êtes envoyé quelque chose.
- 🎬 **Soirée film** : compte à rebours synchronisé pour lancer le film en même temps.
- 📞 **Appels audio et vidéo** (WebRTC, de téléphone à téléphone) : notification « t'appelle », accepter/refuser, micro, caméra, changement de caméra. Sur les réseaux mobiles, un relais TURN est nécessaire : créer un compte gratuit sur metered.ca, puis ajouter dans Vercel les variables `METERED_DOMAIN` et `METERED_API_KEY` (ou `TURN_URLS`, `TURN_USERNAME`, `TURN_CREDENTIAL` pour un autre fournisseur), et redéployer.
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
