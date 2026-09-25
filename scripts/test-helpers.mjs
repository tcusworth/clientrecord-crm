// Shared harness for scripts/test-*.mjs: an in-memory D1 stand-in built on
// node:sqlite plus a tiny CommonJS loader that runs app TypeScript directly.
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import ts from "typescript";

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migrationsDir = path.join(projectRoot, "drizzle");

/** Sorted drizzle/*.sql file names (e.g. "0006_rainy_microchip.sql"). */
export function migrationFiles() {
  return fs.readdirSync(migrationsDir).filter((file) => file.endsWith(".sql")).sort();
}

export function applyMigrations(sqlite, files = migrationFiles()) {
  for (const file of files) sqlite.exec(fs.readFileSync(path.join(migrationsDir, file), "utf8"));
}

/** In-memory SQLite with foreign keys on and the given migrations applied (all by default). */
export function createSqlite({ migrations = migrationFiles() } = {}) {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys=ON");
  applyMigrations(sqlite, migrations);
  return sqlite;
}

/** Minimal D1Database shim: prepare/bind/all/first/run and transactional batch. */
export function createD1(sqlite) {
  return {
    prepare(sql) {
      return {
        args: [],
        bind(...args) { this.args = args; return this; },
        async all() { return { results: sqlite.prepare(sql).all(...this.args) }; },
        async first() { return sqlite.prepare(sql).get(...this.args) || null; },
        async run() {
          const result = sqlite.prepare(sql).run(...this.args);
          return { meta: { last_row_id: Number(result.lastInsertRowid), changes: result.changes } };
        },
        // Like D1's batch(): row-returning statements yield { results }, writes yield { meta }.
        async batchResult() {
          const statement = sqlite.prepare(sql);
          if (statement.columns().length) return { results: statement.all(...this.args), meta: { changes: 0 } };
          return { results: [], ...(await this.run()) };
        },
      };
    },
    async batch(statements) {
      sqlite.exec("BEGIN");
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.batchResult());
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  };
}

const SOURCE_SUFFIXES = ["", ".ts", ".tsx", "/index.ts", "/index.tsx"];

function resolveSource(base) {
  for (const suffix of SOURCE_SUFFIXES) {
    const candidate = base + suffix;
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  throw new Error(`Cannot resolve module ${path.relative(projectRoot, base)}`);
}

/**
 * Returns load(file): transpiles a project TypeScript file to CommonJS and runs it.
 * Resolves "cloudflare:workers" (to { env }), "@/..." aliases and relative imports;
 * any other import throws so tests never silently pull in real packages.
 */
export function createModuleLoader(env = {}) {
  const cache = new Map();

  function loadAbsolute(file) {
    const cached = cache.get(file);
    if (cached) return cached.exports;
    const cjsModule = { exports: {} };
    cache.set(file, cjsModule);
    const code = ts.transpileModule(fs.readFileSync(file, "utf8"), {
      fileName: file,
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
    }).outputText;
    const requireFrom = (name) => {
      if (name === "cloudflare:workers") return { env };
      if (name.startsWith("@/")) return loadAbsolute(resolveSource(path.join(projectRoot, name.slice(2))));
      if (name.startsWith("./") || name.startsWith("../")) return loadAbsolute(resolveSource(path.resolve(path.dirname(file), name)));
      throw new Error(`Unexpected module ${name} (imported from ${path.relative(projectRoot, file)})`);
    };
    const run = vm.runInThisContext(`(function(require,module,exports){${code}\n})`, { filename: file });
    run(requireFrom, cjsModule, cjsModule.exports);
    return cjsModule.exports;
  }

  return (file) => loadAbsolute(resolveSource(path.resolve(projectRoot, file)));
}

/** Convenience: all migrations + D1 shim + env + loader, the common route-test setup. */
export function createTestContext(envOverrides = {}) {
  const sqlite = createSqlite();
  // Route tests authenticate with oai-authenticated-* headers, which are only honoured when opted in.
  const env = { DB: createD1(sqlite), CRM_ALLOWED_EMAILS: "owner@example.com", TRUST_PLATFORM_IDENTITY_HEADERS: "true", ...envOverrides };
  return { sqlite, env, load: createModuleLoader(env) };
}
