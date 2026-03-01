# Spotify Playback Refactor Testplan

## Doel
- Verifieer consistente player-initialisatie en identiek gedrag voor:
  - globale play/pause-knop in de player
  - play-knop in de tracklijst
- Verifieer dat UI-state, controller-state en daadwerkelijke Spotify playback synchroon blijven.

## Algemene Preconditions
- Geldige Spotify Premium account.
- App ingelogd met scopes voor playback.
- Ten minste 1 actief Spotify Connect device beschikbaar.
- Browser cache en storage getest in zowel schone als bestaande sessie.

## iPadOS Safari
1. **Cold load + direct play uit tracklijst**
   - Open app in nieuwe tab.
   - Klik direct op play in tracklijst.
   - Verwacht: playback start na eerste user gesture; actieve track highlight en player-state synchroon.
2. **Globale play/pause direct na load**
   - Herlaad pagina.
   - Klik globale play.
   - Verwacht: geen extra klikken nodig; knopstatus en Spotify playback gelijk.
3. **Tab switch + terugkeer**
   - Start playback.
   - Wissel tab/ga background, kom terug.
   - Verwacht: status herstelt, actieve track en play/pause correct.
4. **Pageshow/BFCache**
   - Navigeer weg en terug met browser back/forward.
   - Verwacht: controller blijft bruikbaar, geen dubbele init of ghost listeners.

## macOS Safari/Chrome
1. **Snel togglen**
   - Klik 10x snel op globale play/pause.
   - Verwacht: geen desync, geen vastlopen, uiteindelijke status klopt.
2. **Trackwissel via lijst**
   - Start track A via lijst, direct daarna track B.
   - Verwacht: laatste klik wint; track B speelt.
3. **Route wissel**
   - Start playback, navigeer tussen `/`, `/queue`, `/gsplayer`.
   - Verwacht: player blijft singleton; geen dubbele init.

## Windows 11 Edge/Chrome/Firefox
1. **Cold load + global play**
   - Open app met lege cache.
   - Klik globale play.
   - Verwacht: consistente start zonder refresh workaround.
2. **Cold load + list play**
   - Klik play op tracklijst.
   - Verwacht: identiek gedrag als globale play (zelfde command pipeline).
3. **Device switch + resume**
   - Wissel actief device in Spotify Connect.
   - Verwacht: state volgt actief device; play/pause werkt direct.

## Functionele regressies
1. **Queue gedrag**
   - Voeg tracks toe aan queue en start vanuit queue.
   - Verwacht: queue-mode blijft werken.
2. **Seek**
   - Versleep progress slider.
   - Verwacht: seek wordt toegepast en bevestigt zonder rollback-loop.
3. **Error recovery**
   - Simuleer token verlopen (logout/login of force refresh).
   - Verwacht: auth-fout zichtbaar en herstel na nieuwe sessie.

## Acceptatie Checklist
- Geen dubbele Spotify SDK initialisatie.
- Geen dubbele event listeners over route transitions heen.
- `controller.playTrack(...)` en `controller.toggle()` leveren stabiel gedrag op alle genoemde platformen.
- UI status (`play/pause`, actieve track, playback status) blijft gelijk aan feitelijke playback.
