// SPDX-License-Identifier: Apache-2.0

let input = "";
for await (const chunk of process.stdin) input += chunk;
const request = JSON.parse(input);
const objects = request.subject?.proposal?.parameters?.objects;
const passes = Array.isArray(objects) && objects.length > 0;
process.stdout.write(`${JSON.stringify({
  protocol: "fpm.handler-response/1",
  ok: true,
  findings: [{
    id: "finding:demo.scene/nonempty",
    subject: request.subject.id,
    rule: "rule:demo.scene/nonempty/1",
    ruleVersion: "1.0.0",
    phase: "proposal",
    verdict: passes ? "pass" : "fail",
    severity: passes ? "information" : "error",
    evidence: { objectCount: Array.isArray(objects) ? objects.length : null },
    scope: { artifactType: request.subject.type },
    conditions: { minimumObjects: 1 },
  }],
})}\n`);
