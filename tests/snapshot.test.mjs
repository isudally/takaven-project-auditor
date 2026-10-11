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

test('snapshot prioritizes executable flow and local imports before documentation',()=>{
  const root=mkdtempSync(join(tmpdir(),'takaven-priority-'));
  try {
    mkdirSync(join(root,'src','navigation'),{recursive:true});
    mkdirSync(join(root,'src','services'),{recursive:true});
    mkdirSync(join(root,'docs'),{recursive:true});
    writeFileSync(join(root,'package.json'),'{}\n');
    writeFileSync(join(root,'index.mjs'),'import "./src/navigation/AppNavigator.mjs";\n');
    writeFileSync(join(root,'src','navigation','AppNavigator.mjs'),'import "../services/GiftService.mjs";\nexport const route = "gift";\n');
    writeFileSync(join(root,'src','services','GiftService.mjs'),'export function createGift() { return true; }\n');
    for (let index=0; index<10; index += 1) writeFileSync(join(root,'docs',`${String(index).padStart(3,'0')}.md`),'documentation\n'.repeat(5000));
    const snapshot=collectRepositorySnapshot(root);
    const indexPosition=snapshot.indexOf('--- index.mjs ---');
    const navigationPosition=snapshot.indexOf('--- src/navigation/AppNavigator.mjs ---');
    const servicePosition=snapshot.indexOf('--- src/services/GiftService.mjs ---');
    const docsPosition=snapshot.indexOf('--- docs/000.md ---');
    assert.ok(indexPosition >= 0 && navigationPosition > indexPosition);
    assert.ok(servicePosition > navigationPosition && servicePosition < docsPosition);
    assert.match(snapshot,/Coverage summary from the trusted controller/);
    assert.match(snapshot,/This is bounded evidence/);
    assert.match(snapshot,/content omitted: (?:per-file|total) size limit/);
  } finally {
    rmSync(root,{recursive:true,force:true});
  }
});
