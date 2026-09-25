// Runs every scripts/test-*.mjs sequentially from the project root; exits non-zero if any fail.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptsDir, "..");
const NON_TESTS = new Set(["test-helpers.mjs"]);

const tests = fs.readdirSync(scriptsDir)
  .filter((file) => file.startsWith("test-") && file.endsWith(".mjs") && !NON_TESTS.has(file))
  .sort();

const failed = [];
for (const file of tests) {
  console.log(`\n▶ ${file}`);
  const result = spawnSync(process.execPath, [path.join("scripts", file)], { cwd: projectRoot, stdio: "inherit" });
  if (result.status !== 0) failed.push(file);
}

console.log(`\n${tests.length - failed.length}/${tests.length} test files passed.`);
if (failed.length) {
  console.error(`Failed: ${failed.join(", ")}`);
  process.exit(1);
}
