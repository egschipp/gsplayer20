- Centrale responsive laag toegevoegd onder `lib/responsive/`:
  - `breakpoints.ts` met vaste breakpoints (`360/768/1024/1280/1536`) en query helpers.
  - `viewportStore.ts` als gedeelde, SSR-safe viewport store met `visualViewport` support, orientation, reduced motion en color-scheme signalen.
  - `useViewport.ts`, `useBreakpoint.ts`, `useMediaQuery.ts` hooks voor client-side responsive gedrag zonder ad-hoc listeners per component.
  - `layout.ts` met gedeelde layout helpers (`computeTrackListHeight`, compact/full track layout switches).
  - `index.ts` barrel export.

- `app/components/PlaylistBrowser.tsx` herstructureerd:
  - Ad-hoc `window.innerHeight` + `resize` listener verwijderd.
  - Virtuele lijsthoogte nu via centrale `useViewport` + `computeTrackListHeight` (SSR-safe en `visualViewport`-aware).
  - Tracklayout schakelt nu centraal tussen compact/full op breakpoint (`<1024` compact), inclusief:
    - `track-header` kolommen compact/full.
    - Conditoneel tonen van `jaar/playlists/duur` kolommen.
    - Compact/full kolomdefinitie in beide row renderers (`TrackRowRenderer` en `TrackItemRenderer`).

- `app/globals.css` verbeterd voor cross-browser viewport en responsive robustness:
  - `100vh` issues gemitigeerd met `100svh` en `100dvh`.
  - iOS/Safari fallback via `-webkit-fill-available`.
  - Safe-area ondersteuning (`env(safe-area-inset-*)`) toegepast op `.page` en `.shell`.
  - Nieuwe `track-header.columns-3` voor compacte layout.
  - `prefers-reduced-motion` fallback toegevoegd.

- Basistests toegevoegd:
  - `lib/responsive/responsive.test.ts` met unit checks op breakpoint-resolutie, hoogte-clamping en layout helper gedrag.

- Breaking changes:
  - Geen functionele route/API breaking changes.
  - Layoutgedrag voor tracktabellen is nu breakpoint-gestuurd (compact onder laptop breakpoint).

- Lokaal testen:
  - `npm run typecheck`
  - `npm run build`
  - Handmatige scenario’s:
    - iPad portrait/landscape + split view: lijsthoogte en compacte kolommen.
    - Windows/macOS resizes en snap layouts: live omschakeling compact/full.
    - Safari/iOS: viewport-hoogte bij adresbalk show/hide en safe areas.
    - Keyboard navigatie: focus states op track rows/buttons en interactieve controls.
