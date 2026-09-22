import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const file="lib/meetily-import.ts",module={exports:{}};
const code=ts.transpileModule(fs.readFileSync(file,"utf8"),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
vm.runInThisContext(`(function(module,exports){${code}\n})`,{filename:file})(module,module.exports);
const {parseMeetilyImport}=module.exports;

const notes=`# Meeting Summary: Acme technical review

**Meeting ID:** meetily-123
**Date:** September 21, 2026, 2:00 PM
**Copied on:** September 22, 2026

---

## Summary

Acme confirmed the phased rollout and asked for the security evidence.

## Key Decisions

- Use a phased rollout
- Run the security review before contracting

## Action Items

| **Owner** | Task | Due | Reference Transcript Segment | Segment Time stamp |
| --- | --- | --- | --- | --- |
| Trevor | Send security evidence | September 24, 2026 | 12 | 18:42 |

## Risks and Objections

- Security approval is outstanding

## Attendees

- casey@acme.test
`;
const transcript=`# Transcript of the Meeting: meetily-123 - Acme technical review\n\n## Date: 9/21/2026\n\n[00:04] Welcome.`;
const parsed=parseMeetilyImport(notes,transcript,new Date("2026-09-22T12:00:00.000Z"));
assert.equal(parsed.title,"Acme technical review");
assert.equal(parsed.externalId,"meetily-123");
assert.match(parsed.summary,/phased rollout/);
assert.deepEqual(parsed.decisions,["Use a phased rollout","Run the security review before contracting"]);
assert.deepEqual(parsed.risksAndObjections,["Security approval is outstanding"]);
assert.match(parsed.nextSteps[0],/Send security evidence/);
assert.equal(parsed.nextStepOwner,"Trevor");
assert.equal(parsed.nextStepDueDate,"2026-09-24");
assert.deepEqual(parsed.attendeeHints,["casey@acme.test"]);
assert.equal(parsed.transcript,transcript);

const transcriptOnly=parseMeetilyImport(transcript,"",new Date("2026-09-22T12:00:00.000Z"));
assert.equal(transcriptOnly.externalId,"meetily-123");
assert.equal(transcriptOnly.title,"Acme technical review");
assert.equal(transcriptOnly.transcript,transcript);
console.log("PASS: Meetily summary and transcript imports preserve meeting metadata and structured review fields.");
