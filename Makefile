.PHONY: phase0-up phase0-down phase0-seed phase0-token phase0-e2e-0 phase0-clean

COMPOSE := docker compose -p zuul-poc -f zuul/docker-compose.yaml

## Bring up the Phase 0 infrastructure spike stack (ZK, MariaDB, scheduler,
## web, executor, logs, gitserver) with pinned Zuul 14.2.0 images.
phase0-up:
	mkdir -p zuul/gitserver-repos
	$(COMPOSE) up -d certs-init
	sleep 5
	$(COMPOSE) up -d --build

## Seed the zuul-config (config-project) and agent-runs (untrusted-project)
## bare repos served by the gitserver container.
phase0-seed:
	./zuul/scripts/seed-repos.sh

## Mint a fresh JWT for enqueue-ref/enqueue calls (strips the "Bearer " prefix).
phase0-token:
	$(COMPOSE) exec scheduler zuul-admin create-auth-token \
		--auth-config zuul_operator --user run-api --tenant agents \
		--expires-in 86400 2>/dev/null | sed 's/^Bearer //'

## Gate E2E-0: enqueue-ref -> buildset -> executor-only job SUCCESS.
## Requires the stack to be up and seeded. Prints the buildsets JSON.
phase0-e2e-0:
	./zuul/scripts/e2e-0.sh

phase0-down:
	$(COMPOSE) down

phase0-clean:
	$(COMPOSE) down -v
