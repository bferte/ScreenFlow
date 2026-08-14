# ScreenFlow

Enregistreur d'écran local avec montage automatisé pour démos logicielles, dans l'esprit de
Screen Studio. Application desktop Electron + React, hors ligne à une exception près (la
voix-off, qui appelle un service externe).

Le principe : on capture l'écran **et** la trajectoire de la souris avec ses clics. Le montage
n'est ensuite pas dessiné à la main — il est *dérivé* de cette télémétrie. Les clics deviennent
des zooms, des cercles d'annotation, des zones de spotlight ; le curseur pilote le recadrage
vertical ; la parole pilote l'atténuation du reste.

Le projet couvre aussi le **montage multi-clips** (intro / jingle / outro, insertion au milieu
par découpe), le **format Shorts 9:16** avec recadrage automatique, la **voix-off générée**
(OpenAI ou ElevenLabs) et un **overlay avatar**.

---

## Démarrage

```bash
npm install
```

```bash
npm run dev
```

Une seule commande : Vite compile le renderer, le processus principal et le preload, puis lance
Electron avec rechargement à chaud. Aucun ffmpeg système requis — `ffmpeg-static` fournit le
binaire.

Les enregistrements atterrissent dans `Vidéos/ScreenFlow/<horodatage>/`.

---

## Ce que fait le logiciel

### 1. Capture

Trois flux sont enregistrés **séparément** puis écrits sur disque :

| Fichier | Contenu |
|---|---|
| `screen.webm` | Vidéo VP9, résolution native de l'écran |
| `mic.webm` | Micro seul, Opus |
| `system.webm` | Son système (loopback), Opus |
| `telemetry.json` | Curseur à 60 Hz + clics horodatés |
| `manifest.json` | Chemins, durée, drapeau `seekable`, nom donné à la capture |

En parallèle, le processus principal échantillonne `screen.getCursorScreenPoint()` à 60 Hz et
capte les clics globaux via `uiohook-napi`.

Juste après l'écriture, chaque conteneur est **remuxé** (`-c copy`, sans perte).

### 2. Montage

L'éditeur ne modifie jamais les fichiers sources. Il construit à la volée :

- une **trajectoire de caméra** (zoom + panoramique) à partir des clics, réglable à la main ;
- une **couche d'annotations** (cercles, spotlight) à partir des clics et du curseur ;
- une **enveloppe de ducking** à partir du niveau du micro ;
- un **son de clic** synthétisé à chaque clic enregistré, si on l'active (six timbres au choix).

Tout est recalculé instantanément quand un réglage bouge.

### 3. Export

Chaque image de sortie est rendue hors écran par le compositeur, encodée en PNG, et poussée
dans l'entrée standard de ffmpeg. L'audio est mixé séparément dans un `OfflineAudioContext`
puis muxé. Résultat : un MP4 h264 + aac.

---

## Architecture

```
┌─────────────────── processus principal (Node) ───────────────────┐
│  main.ts            fenêtre, IPC, protocole de streaming          │
│  mouse-tracker.ts   curseur 60 Hz + clics globaux                 │
│  ffmpeg.ts          binaire ffmpeg, remux, sonde média            │
│  export.ts          processus ffmpeg, pipe PNG, contre-pression   │
│  settings.ts        🔒 clés API — ne sortent jamais d'ici         │
│  tts.ts             appels OpenAI / ElevenLabs, cache disque      │
└───────────────────────────┬───────────────────────────────────────┘
                            │ contextBridge (preload.ts)
┌───────────────────────────┴─────────── renderer (React) ─────────┐
│  recorder.ts        3 MediaRecorder → disque                      │
│  sequence.ts        resolve(t) → clip + temps source              │
│  media-pool.ts      un élément média par clip, esclaves           │
│  zoom-engine.ts     clics → segments → trajectoire ressort        │
│  overlays.ts        cercles, spotlight, échantillonnage curseur   │
│  compositor.ts      ⭐ rendu d'une image de clip                  │
│  renderer.ts        ⭐ rendu de la séquence + overlays timeline   │
│  click-sound.ts     palette de clics synthétisés + planification  │
│  ducking.ts         courbe d'atténuation globale timeline         │
│  speech-sources.ts  collecte micro + voix-off pour le ducking     │
│  audio-engine.ts    graphe Web Audio d'un enregistrement          │
│  voiceover-engine.ts lecture des répliques générées               │
│  avatar.ts          AvatarSource + dessin de l'overlay            │
│  exporter.ts        boucle de rendu + mixage hors ligne           │
└───────────────────────────────────────────────────────────────────┘
```

Les deux ⭐ sont les points de passage obligés : `renderer.ts` pour la séquence entière,
`compositor.ts` pour une image de clip. L'aperçu et l'export appellent **exactement** ces
deux fonctions.

### Flux de données

```
capture ──> screen.webm + mic.webm + system.webm + telemetry.json
                                │
                                ▼
              generateSegments(clics)  ──>  ZoomTrack (ressort précalculé 120 Hz)
              DuckingEnvelope(micro)   ──>  courbe de gain 100 Hz
                                │
                    ┌───────────┴───────────┐
                    ▼                       ▼
              drawComposite()         drawComposite()
              (aperçu, 60 fps)        (export, image par image)
                    │                       │
                    ▼                       ▼
               <canvas>                PNG → ffmpeg → MP4
```

---

## Invariants à ne pas casser

Ces règles ne sont pas stylistiques. Chacune corrige un défaut réel rencontré pendant le
développement, et les violer produit des bugs silencieux.

### 1. Tout ce qui dépend du temps est une fonction pure de `t`

`ZoomTrack` et `DuckingEnvelope` **intègrent une fois d'avance** puis se contentent d'indexer.

Un ressort intégré image par image dépendrait du chemin parcouru : reculer le playhead donnerait
une image différente d'une lecture continue, et l'export divergerait de l'aperçu. Même chose
pour le ducking : une analyse temps réel dépendrait de l'instant où la lecture a démarré.

> **Si vous ajoutez un effet animé, précalculez sa trajectoire.** Ne gardez pas d'état entre
> deux images.

### 2. L'aperçu et l'export appellent le même `drawComposite`

`compositor.ts` est le seul endroit où une image finie est produite. Le MP4 correspond à
l'aperçu *par construction*, pas par vigilance.

> **N'ajoutez jamais de dessin uniquement dans `CanvasPlayer`.** Passez par le compositeur ou
> par le renderer d'overlay, sinon l'effet manquera à l'export.

### 3. `DrawFrame` sépare dimensions source et sortie

L'aperçu rend à la taille native, l'export peut viser 1080p depuis une source 1440p. Toute
projection de télémétrie doit passer par `toCanvas()`, qui utilise les deux.

> Un `frame.width` servant des deux usages a déjà provoqué un décalage des annotations. Ne
> refusionnez pas ces champs.

### 4. La télémétrie est stockée en coordonnées normalisées

Chaque échantillon porte `x/y` (DIP bruts) **et** `nx/ny` (0..1 dans les bornes de l'écran).
L'éditeur n'utilise que `nx/ny`, donc la télémétrie rejoue correctement quelle que soit la
résolution d'encodage.

### 5. La caméra est bridée pour rester dans le cadre

`clampCenter()` limite le centre à `0.5/scale` de chaque bord. Le compositeur **ne re-bride pas**
volontairement : un dépassement doit se voir comme un bug de `ZoomTrack`, pas être masqué.

### 6. Les pistes audio restent séparées sur disque

Un mixage à l'enregistrement rendrait le ducking impossible *a posteriori*.

### 7. `Sequence.resolve(t)` est pur, et rend un temps **source**

C'est l'équivalent multi-clips de l'invariant 1. Il rend le temps *dans le média source*
(point d'entrée du rognage inclus), pas le temps depuis le début du clip.

C'est ce qui rend la découpe gratuite : deux moitiés d'une capture partagent la même
télémétrie et la même `ZoomTrack`, et échantillonnent au bon endroit sans savoir qu'une
coupe existe. Le harnais vérifie que couper ne déplace l'image d'aucune milliseconde.

### 8. L'horloge est la timeline, jamais un élément média

Rien ne décode à travers une coupe, et un clip audio-seul n'a pas d'horloge vidéo. La
timeline avance seule (accumulateur `requestAnimationFrame`) et tire les médias derrière
elle via `MediaPool.sync()` / `AudioEngine.sync()` / `VoiceoverEngine.sync()`.

> **N'ajoutez jamais d'écouteur `timeupdate` pour piloter quoi que ce soit.**

### 9. La courbe de ducking est globale à la timeline

Une réplique de voix-off peut commencer sur un jingle et finir sur une capture, donc une
courbe locale à un clip ne peut pas la représenter. `DuckingEnvelope.fromSources()` prend
toutes les sources de parole (micro de chaque capture, chaque réplique générée) avec leur
décalage, et rend une courbe unique en temps timeline. Les moteurs de lecture la
**reçoivent**, ils ne la calculent pas.

Ce qui atténue : la parole. Ce qui est atténué : le son système et les clips importés.

### 10. Un bloc de voix-off n'existe qu'une fois généré

`VoiceoverBlock.audioPath` n'est pas nullable : une ligne non synthétisée est un brouillon
du panneau, pas un objet de timeline. Cette séparation est ce qui rend le déplacement
trivialement sûr — rien dans un déplacement ne peut invalider l'audio.

Le déplacement ne modifie **que** `timelineOffsetMs`. La clé de cache
(`sha256(service|modèle|voix|texte)`) ne contient ni position, ni volume, ni identifiant de
bloc : glisser un bloc est donc *structurellement* incapable de déclencher un appel API.
`electron/cache-key.ts` est isolé d'Electron et du réseau précisément pour que cette
propriété soit testable plutôt que supposée.

> **N'ajoutez jamais la position ou le volume à la clé de cache.**

### 11. Les clés API ne franchissent jamais l'IPC vers le renderer

Le renderer envoie du texte et reçoit un chemin de fichier. La clé reste dans le processus
principal, ce qui la met hors de portée de tout code de page et de DevTools.
`getPublicSettings()` ne rend qu'un booléen `hasOpenaiKey` — jamais la valeur.

> **Ne jamais logger l'objet de paramètres**, il peut contenir une clé.

---

## Pièges rencontrés (et pourquoi ils sont non évidents)

Ces quatre problèmes ont chacun coûté du temps parce qu'ils **ne produisent aucune erreur**.

### Les WebM de `MediaRecorder` ne sont pas seekables

Le conteneur écrit en flux ne porte ni durée ni cues : `video.duration` vaut `Infinity` et le
seek échoue silencieusement. → Remux systématique en `-c copy` après capture
(`remuxInPlace`), drapeau `manifest.seekable`.

### Une URL de scheme standard doit avoir un host

`screenflow:///C:/Users/…` était parsé par Chromium avec **`host="c"`** — la lettre de lecteur
était mangée comme autorité, le chemin devenait relatif, et le garde de sécurité renvoyait 403
sur le fichier légitime. → Host explicite : `screenflow://local/C:/…`.

### Web Audio devient muet sur un média d'origine différente

`createMediaElementSource()` sur un élément « tainted » produit un graphe qui **ne sort rien,
sans lever d'erreur**. → En-tête `Access-Control-Allow-Origin` sur le protocole +
`crossOrigin='anonymous'` sur les éléments audio.

### `useMemo` + destruction dans un effet = objet mort en StrictMode

Le piège le plus coûteux du projet, parce qu'il est **intermittent**.

```ts
const pool = useMemo(() => new MediaPool(...), [key])   // ❌
useEffect(() => () => pool.dispose(), [pool])
```

React 18 en `StrictMode` monte les effets, les démonte, puis les remonte —
**sans recalculer les `useMemo`**. L'objet est donc détruit au faux démontage et
jamais reconstruit. Ici, tous les `get()` renvoyaient `null` et le canvas se
remplissait de noir sans la moindre erreur.

L'intermittence vient de ceci : le double-montage n'a lieu qu'au **montage
initial**, pas après une mise à jour HMR. Tester après un rechargement à chaud
donne une app qui marche ; démarrer à froid la casse. On peut y perdre un temps
considérable en croyant à un correctif qui n'en était pas un.

> **Toute ressource détruite par un effet doit être créée par ce même effet**,
> jamais par un `useMemo` en amont. Voir `pool` et `avatarSource` dans
> `Editor.tsx` pour le motif correct.

`MediaPool.describe()` distingue explicitement « pas encore chargé » de
« pool détruit » — sans cette distinction, le diagnostic est indécidable.

### Un échec de nettoyage ne doit jamais détruire la donnée

Sur Windows, `rename` refuse de remplacer un fichier dont un handle reste
ouvert, et celui de ffmpeg survit quelques centaines de millisecondes à son
propre processus (Defender, indexeur). Le `rename` du remux échouait, puis le
`fs.rm` de nettoyage échouait aussi — et **cette seconde exception s'échappait**,
tuant `recording:save` avant l'écriture du manifeste. Une capture entière était
perdue à cause d'une optimisation de confort.

D'où trois règles : `renameWithRetry` temporise sur `EBUSY`/`EPERM`/`EACCES`,
`remuxInPlace` ne lève **jamais**, et `recording:list` reconstruit un manifeste
manquant à partir des fichiers présents.

> **Une étape facultative ne doit pas pouvoir faire échouer l'étape obligatoire
> qui la précède.**

### Un élément média détaché ne se charge pas tout seul

`MediaPool` crée ses `<video>` par `document.createElement` sans jamais les insérer dans le
DOM. Affecter `.src` ne suffit alors pas à déclencher le chargement : il faut appeler
`load()` explicitement. Sans ça, `ready` reste faux, `get()` rend `null`, et le canvas
affiche du noir — **avec une timeline qui avance normalement**, puisqu'elle ne dépend
d'aucun média. Le symptôme ne ressemble pas du tout à sa cause.

`SequenceRenderer` signale désormais, une fois par seconde, laquelle des trois causes
possibles bloque le rendu (runtime absent / clip sans vidéo / média non prêt).

### Les requêtes Range sont indispensables

Sans réponses 206, Chromium refuse de seeker et télécharge le fichier entier avant lecture —
intenable dès qu'un enregistrement atteint le gigaoctet. Le handler dans `main.ts` implémente
206 et 416, et refuse tout chemin hors du dossier d'enregistrements.

---

## Réglages notables

### Pontage entre zooms (`bridgeMs`, `bridgeMaxDistance`)

Deux segments proches dans le temps laissaient la caméra retomber vers 1× avant de re-zoomer —
un « pompage » visible. Le pontage maintient le zoom et fait glisser la caméra, **mais
seulement si les deux points de focus sont proches**. Sur un grand déplacement, le dézoom est
conservé : il se lit comme un plan de réétablissement volontaire, pas comme un défaut.

### Les zooms se reprennent à la main, par clip entier

Tirer le bord d'un bloc sur la piste change sa durée, et un zoom peut être ajouté à la tête
de lecture — visant l'endroit où était le curseur à cet instant, puisque c'est presque
toujours le sujet dont on parle.

Toucher **un** segment fait passer **tout le clip** en manuel. Ce n'est pas de la paresse :
la passe automatique numérote ses segments à partir des grappes de clics, donc changer ensuite
un réglage de regroupement les renumérote et une modification atterrirait sur le mauvais zoom.
Figer la liste au moment de la première retouche est la seule version qui ne peut pas déplacer
le travail de quelqu'un en silence. Un bouton rend le clip à la génération automatique.

Les segments manuels ont le droit de se chevaucher : `targetAt` prend le dernier qui contient
l'instant, donc un recouvrement produit une priorité, jamais un trou.

### Maintien du zoom sur curseur immobile (`dwellMaxMs`)

Cliquer dans un champ puis y taper est **une** action, mais seule sa première moitié est un
clic : le maintien expirait en pleine phrase et sortait la caméra du champ en train d'être
rempli. Le compte à rebours ne démarre donc plus au clic, mais **une fois le curseur reparti**.

Un curseur immobile est le signal que l'attention n'a pas bougé — le clavier est utilisé, ou
l'écran est lu. Aucune capture supplémentaire n'est nécessaire : la trajectoire est déjà
enregistrée, et rien ne va lire le clavier pour ça. Un plafond (6 s par défaut) évite qu'une
souris simplement abandonnée fige le zoom indéfiniment, et un rayon de tolérance absorbe le
tremblement d'une main posée dessus.

### Ducking asymétrique

Attaque rapide (~120 ms), retour lent (~420 ms), plus un temps de maintien (~260 ms) pour que
les silences entre les mots ne fassent pas pomper le son système.

### Son de clic (désactivé par défaut)

Une capture d'écran est muette sur la seule chose que le spectateur a besoin de suivre : le
moment où quelque chose a été pressé. La télémétrie le sait déjà, donc le son en est *dérivé*
comme le reste du montage — aucun fichier d'asset, rien à resynchroniser avec la vidéo.

Chaque son empile des **couches** : du bruit pour un impact, un ton aigu court pour un
contacteur, un ton grave qui décroît assez lentement pour être ressenti. C'est ce qui fait
entendre un objet frappé plutôt qu'un bip. Un son est donc de la *donnée*, pas du code —
en ajouter un, c'est ajouter des couches, et il hérite de la même synthèse, de la même
normalisation et du même fondu que les autres.

| Son | Caractère |
|---|---|
| Clic de souris | Net et sec, le défaut |
| Clic doux | Feutré, sans attaque agressive |
| Touche mécanique | Le clic, puis la **butée** 20 ms après — ce qui fait entendre la course d'une touche plutôt qu'un contact unique |
| Touche de portable | Chiclet mat et court, presque sans résonance |
| Machine à écrire | Frappe métallique appuyée, très présente |
| Pop | Bulle synthétique, aucune couche de bruit |

Le choix se fait dans l'onglet Audio, et changer de son en **joue** un aussitôt : une liste de
noms seule obligerait à tous les essayer un par un pour trouver le bon.

Le bruit est déterministe : l'aperçu et le mix exporté doivent synthétiser exactement la même
onde, `Math.random` en donnerait une différente à chacun. Les clics sont atténués par le
ducking comme le son système, et ceux qu'un rognage écarte ne sonnent pas — ils annonceraient
un moment que le montage ne montre pas.

Désactivé par défaut : c'est un son que la capture ne contenait pas, l'ajouter doit rester un
choix délibéré.

---

## Harnais de vérification

L'UI Electron n'est pas pilotable en automatique, donc la logique est validée hors application.

```bash
npx esbuild scripts/zoomcheck.ts --bundle --platform=node --format=cjs --outfile=/tmp/z.cjs && node /tmp/z.cjs "<chemin>/telemetry.json"
```

| Script | Ce qu'il prouve |
|---|---|
| `scripts/zoomcheck.ts` | Clustering, bornes du cadre, absence d'overshoot, déterminisme au seek |
| `scripts/duckcheck.ts` | Constantes d'attaque/retour, maintien, absence de faux positifs sur piste muette |
| `scripts/exportcheck.ts` | Pipeline ffmpeg complet : arguments, pipe PNG, contre-pression, MP4 produit |
| `scripts/protocol-check.cjs` | Routage du scheme, 206/416, garde de traversée de chemin |
| `scripts/seqcheck.ts` | Frontières de clips, rognage, découpe sans dérive, géométrie 9:16, auto-framing |
| `scripts/voicecheck.ts` | Clé de cache indépendante de la position, déplacement n'altérant qu'un champ, bridage |
| `scripts/clickcheck.ts` | Forme d'onde de chaque son, déterminisme de la synthèse, planification sur clips rognés |

`protocol-check.cjs` se lance avec `npx electron`, les autres avec Node après bundling esbuild
(`--external:electron --external:ffmpeg-static`, et sortie **dans le projet** pour que la
résolution de modules fonctionne).

---

## Limites connues

- **L'export est lent.** Chaque image est obtenue par un seek exact, et les codecs décodent
  depuis une image-clé. C'est le prix du déterminisme. Piste d'amélioration : lire la vidéo en
  continu via `requestVideoFrameCallback`, au prix d'un export borné à la durée réelle.
- **Le son système Windows** n'est exposé en loopback que pour certaines sources ; l'app
  dégrade proprement avec un avertissement.
- **Sans `uiohook-napi`**, les positions du curseur sont toujours capturées mais pas les clics :
  les zooms doivent alors être placés à la main (`telemetry.clicksAvailable === false`).
- **Les segments de zoom ne sont pas encore éditables** individuellement. La timeline les
  sélectionne déjà (`selectedId`), le point d'accroche existe.
- **Le projet n'est pas persisté.** Clips, répliques et réglages vivent en mémoire dans
  `Editor` et disparaissent à la fermeture. `Project` (dans `types/project.ts`) est le type
  à sérialiser pour y remédier.
- **L'avatar animé n'est pas branché.** `AvatarSource.imageAt(t)` prend déjà un timestamp
  et `StaticAvatar` l'ignore ; une implémentation adossée à une vidéo générée (SadTalker,
  LivePortrait, D-ID…) se substituerait sans toucher au compositeur. Il lui faudra la
  boucle de seek exact de l'exporteur, sinon les images exportées viendraient de la
  position courante de l'élément au lieu d'un seek déterministe.
- **Le chemin TTS n'a jamais été exécuté** au moment où ces lignes sont écrites : il exige
  une clé API. La gestion d'erreur distingue 401 (clé refusée), 429 (quota) et les réponses
  non-JSON des passerelles, mais aucun appel réel n'a été observé.

---

## Pistes suivantes

1. Édition manuelle des segments (déplacer, supprimer, changer le facteur).
2. Rognage début/fin.
3. Fond dégradé + coins arrondis autour de la capture (esthétique Screen Studio).
4. Lissage du curseur, ou curseur synthétique redessiné.
5. Remplacer ffmpeg par `VideoEncoder` (WebCodecs) — encodage matériel, bien plus rapide.
