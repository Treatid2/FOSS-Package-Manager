// SPDX-License-Identifier: MPL-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const root=new URL('../',import.meta.url);
const read=name=>readFile(new URL(name,root),'utf8');
const json=async name=>JSON.parse(await read(name));
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');

test('descriptor and runtime preserve predecessor evidence and publish the exact successor contract',async()=>{
 const m=await json('maintenance.json'),d=await json('fgpm-package.json'),r=await json('runtime.json');
 assert.equal(m.historicalPredecessor.files['fpm-package.json'],'125c665302c7d4fbcbe5fbb54c046351f34c21a4a8f6a6faf545a23e7202e28b');
 assert.equal(m.predecessor.root,'sha256:df991de127867422ae60bc041b02efb503a93748cfc696af5d324c4b7d5e8090');
 for(const [name,hash]of Object.entries(m.successor.files))assert.equal(sha(await readFile(new URL(name,root))),hash,name);
 assert.deepEqual(Object.keys(d).sort(),['format','namespace','name','version','license','dependencies','contributions'].sort());
 assert.equal(d.format,'fgpm.package/1');
 assert.equal(d.namespace,m.package.namespace);assert.equal(d.name,m.package.id);
 for(const key of ['version','license'])assert.equal(d[key],m.package[key]);
 assert.deepEqual(d.dependencies,m.dependencies);assert.deepEqual(d.contributions,[m.contribution]);
 assert.deepEqual(r,m.runtime);assert.equal(r.activation.ticks,18);
});
test('field-by-field equivalence and version decision are complete and unchanged',async()=>{
 const e=await json('descriptor-equivalence.json'),d=await json('fgpm-package.json'),m=await json('maintenance.json');
 assert.equal(e.migrationApplied,true);assert.equal(e.decision,'MIGRATE_TO_FGPM_PACKAGE_ENTRYPOINT_AND_NAMESPACE');
 assert.equal(e.predecessorRoot,m.historicalPredecessor.root);assert.equal(e.publicSafePredecessor.root,m.predecessor.root);assert.equal(e.publicSchemaStatus,m.schemaStatus);
 assert.deepEqual(e.fields.map(f=>f.path),['/format','/namespace','/name','/version','/license','/dependencies/0','/dependencies/1','/contributions/0/id','/contributions/0/manifestType','/contributions/0/manifest']);
 for(const f of e.fields){const value=f.path.split('/').slice(1).reduce((o,k)=>o[k],d);assert.deepEqual(f.after,value);}
});
test('human metadata licensing and inert usage agree with declared contracts',async()=>{
 const m=await json('maintenance.json'),docs=await read(m.documentation),notice=await read(m.noticeFile),license=await read(m.licenseFile);
 for(const value of [m.package.id,m.package.version,m.package.license,m.historicalPredecessor.root,m.predecessor.root,m.runtime.schema,m.runtime.activation.id,m.runtime.activation.protocol,...m.runtime.activation.accepts,m.testCommand,...m.dependencies.flatMap(d=>[d.package,d.range]),...m.runtime.activation.requires.flatMap(r=>[r.capability,r.range,...(r.binding?[r.binding]:[])])])assert.ok(docs.includes(value),value);
 assert.ok(docs.includes('provisional-v1'));assert.ok(docs.includes('no executable'));
 assert.ok(notice.includes(m.historicalPredecessor.sourceCommit));assert.ok(notice.includes('MPL-2.0'));
 assert.ok(license.includes('Mozilla Public License'));assert.ok(license.includes('Version 2.0'));
 assert.equal(m.testsInert,true);assert.equal(m.acceptedV05SelectionChanged,false);
});
