// Bridges a real gap between two tools this project needs simultaneously: tsconfig.json uses
// "moduleResolution": "Bundler" (correct for wrangler/esbuild, which resolve extensionless
// relative imports themselves — the actual convention every source file in src/ follows), but
// Node's native --test runner does strict ESM resolution and requires explicit extensions.
//
// Found live (2026-09-18) writing judge.test.ts: it's the first test to import a module
// (judge.ts) with a *real* runtime relative import (flattenChart from verify.ts) rather than
// only type-only imports (which --experimental-strip-types erases before resolution ever runs).
// agent.ts has the identical latent issue — it was never caught only because no agent.test.ts
// exists yet. Without this loader, any test file that transitively imports a module with a real
// relative import fails with ERR_MODULE_NOT_FOUND, regardless of which file that import is.
//
// This tries the specifier as given first (test files' own imports already use explicit .ts and
// must keep working unchanged), and only falls back to appending .ts on failure — so it never
// masks a genuinely wrong import path, only bridges the missing-extension case.
export async function resolve(specifier, context, nextResolve) {
	try {
		return await nextResolve(specifier, context);
	} catch (err) {
		const isRelative = specifier.startsWith('./') || specifier.startsWith('../');
		if (isRelative && !specifier.endsWith('.ts') && err.code === 'ERR_MODULE_NOT_FOUND') {
			return nextResolve(`${specifier}.ts`, context);
		}
		throw err;
	}
}
