import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectRepositorySnapshot } from '../src/audit.mjs';

test('controller snapshot reads source, withholds sensitive files, and redacts secret-like values',()=>{
  const root=mkdtempSync(join(tmpdir(),'takaven-snapshot-'));
  try {
    mkdirSync(join(root,'src'));
    writeFileSync(join(root,'src','app.mjs'),'const token = "sk-12345678901234567890";\n');
    writeFileSync(join(root,'.env'),'API_KEY=should-not-be-read\n');
    const snapshot=collectRepositorySnapshot(root);
    assert.match(snapshot,/--- src\/app\.mjs ---/);
    assert.match(snapshot,/<REDACTED>/);
    assert.match(snapshot,/--- \.env ---[\s\S]*content withheld by controller/);
    assert.doesNotMatch(snapshot,/should-not-be-read/);
  } finally {
    rmSync(root,{recursive:true,force:true});
  }
});
