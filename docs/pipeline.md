# Pipeline configuratie (Next.js, snel en simpel)

## 1) Triggers & scope
- Workflow: `.github/workflows/deploy.yml`
- Triggers:
  - `pull_request` voor snelle CI-checks (lint/typecheck/test)
  - `push` naar `main` en `workflow_dispatch` voor build + deploy
- Paths-filter bevat app-, infra- en buildbestanden, inclusief `components/**`.
- Efficiëntie: docs-only commits triggeren geen build/deploy.

## 2) CI op PR
- `npm ci --no-audit --no-fund` + lint/typecheck/test.
- Efficiëntie: snelle feedback, minimale overhead.

## 3) Build op main
- Build draait op `ubuntu-latest` met Buildx + GHA cache.
- Docker build pushed direct twee tags in één stap:
  - immutable: `${GITHUB_SHA}`
  - convenience: `latest`
- Efficiëntie: geen extra `imagetools` stap meer nodig.

## 4) Dockerfile optimalisatie
- Multi-stage build met cache mounts.
- Productie dependencies komen uit `npm prune --omit=dev` i.p.v. een tweede `npm ci`.
- Efficiëntie: minder netwerk/download en snellere image build.

## 5) Deploy op Pi (SSH)
- Deploy gebruikt immutable image-tag (`IMAGE_TAG=${GITHUB_SHA}`).
- `.env` wordt atomisch geschreven (`tmp` + `mv`) met `chmod 600`.
- Deploy-lock met `flock` voorkomt parallelle deploys.
- Runtime update:
  - `docker compose pull web worker`
  - `docker compose up -d --remove-orphans --wait`
- Efficiëntie: alleen pull + restart op Pi, geen lokale build.

## 6) Runtime image selectie
- `infra/docker-compose.yml` gebruikt:
  - `image: ${IMAGE_NAME}:${IMAGE_TAG:-latest}`
- Efficiëntie/robuustheid: reproduceerbare deploy op SHA-tag, snelle rollback via vorige tag.

## 7) Healthcheck en fail-fast
- `/api/health` route is aanwezig en compose wacht op health met `--wait`.
- `APP_ENCRYPTION_KEY` wordt gevalideerd vóór deploy.
- Efficiëntie: misconfiguratie faalt vroeg en voorkomt langzame debug-cycli.

## 8) Belangrijkste snelheidswinsten
1. Eén Docker push stap voor `sha + latest`.
2. `npm prune --omit=dev` vervangt tweede install.
3. BuildKit/GHA caching blijft actief.
4. Paths-filter voorkomt onnodige CI/CD runs.
5. Pi doet alleen image pull + container update.
