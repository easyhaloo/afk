.PHONY: desktop-dev desktop-build desktop-test desktop-e2e desktop-package-mac desktop-verify-mac

desktop-dev:
	pnpm --filter afk-control-electron dev

desktop-build:
	pnpm --filter afk-control-electron build

desktop-test:
	pnpm --filter afk-control-electron test

desktop-e2e:
	pnpm --filter afk-control-electron build:main && pnpm --filter afk-control-electron e2e

desktop-package-mac:
	pnpm --filter afk-control-electron package:mac

desktop-verify-mac:
	pnpm --filter afk-control-electron verify:mac
