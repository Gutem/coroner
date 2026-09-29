.PHONY: help dev test lint format typecheck install clean

help:
	@echo "Available commands:"
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-20s\033[0m %s\n", $$1, $$2}'

dev: ## Run with watch
	bun run dev

test: ## Run tests
	bun test

coverage: ## Run tests with coverage
	bun run test:coverage

lint: ## Lint + format check
	bun run lint

format: ## Auto-fix format
	bun run format

typecheck: ## JSDoc typecheck
	bun run typecheck

install: ## Install dependencies
	bun install

clean: ## Clean build artifacts
	rm -rf node_modules/ coverage/
