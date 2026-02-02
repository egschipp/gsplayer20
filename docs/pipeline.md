# Pipeline configuratie (Next.js)

## 1) Triggers & scope
- Workflow: `.github/workflows/deploy.yml`
- Trigger: `push` naar `main` met paths-filter op `app/**`, `infra/**`, `Dockerfile`, `.dockerignore` en de workflow.
- Efficiëntie: docs-only commits triggeren geen build/deploy.

## 2) Runner-keuze
- `runs-on: [self-hosted, arm64, pi, gsplayer]`
- Efficiëntie: builds draaien native op ARM (geen QEMU/Buildx emulatie), minder overhead.

## 3) Build-stappen
- Checkout → Docker build → Docker push → SSH deploy
- Lint/typecheck/test alleen op PR, niet op push naar main.
- Efficiëntie: op productie-push geen extra Node install + lint/typecheck/test.

## 4) Docker build optimalisatie
- `Dockerfile` gebruikt multi-stage + Next.js standalone (`output: "standalone"`).
- `npm ci` draait met BuildKit cache mount:
  - `RUN --mount=type=cache,target=/root/.npm npm ci`
- Efficiëntie: dependency-laag hergebruikt zolang `package-lock.json` gelijk blijft.

## 5) Build context verkleind
- `.dockerignore` sluit `.git`, `node_modules`, `.next`, logs, docs, en `.env` uit.
- Efficiëntie: minder data naar Docker daemon → sneller build start.

## 6) Image tagging
- `latest` + `${{ github.sha }}` tags.
- Efficiëntie/robustness: immutable tags voor rollback; `latest` voor simpele deploy.

## 7) Deploy stap (SSH)
- Op Pi:
  - `docker-compose pull`
  - `docker-compose up -d --remove-orphans`
  - `docker image prune -f`
- Efficiëntie: alleen image-pull + container restart (geen build op Pi).

## 8) Healthcheck
- `/api/health` endpoint (Next.js route handler).
- Compose healthcheck:
  - `test: ["CMD", "node", "-e", "fetch('http://localhost:3000/api/health')..."]`
- Efficiëntie/robustness: snelle detectie van ready-state.

## 9) Secrets & config
- Secrets worden via SSH-step naar `.env` geschreven.
- Validatie op `APP_ENCRYPTION_KEY` (moet 32-byte base64 zijn).
- Efficiëntie: misconfig faalt vroeg, voorkomt lang debuggen.

## Belangrijkste snelheidswinsten
1. Native ARM build op self-hosted runner (geen QEMU).
2. BuildKit cache voor `npm ci` layer.
3. Geen lint/typecheck/test op main-deploy (alleen PR).
4. Paths-filter om onnodige deploys te voorkomen.
5. Kleine build context via `.dockerignore`.
