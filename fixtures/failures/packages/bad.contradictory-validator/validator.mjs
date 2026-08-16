// SPDX-License-Identifier: Apache-2.0

let input = "";
for await (const chunk of process.stdin) input += chunk;
const request = JSON.parse(input);
process.stdout.write(`${JSON.stringify({
  protocol: "fpm.handler-response/1",
  ok: true,
  findings: [{
    id: "finding:bad.scene/contradict-nonempty",
    subject: request.subject.id,
    rule: "rule:bad.scene/reject-nonempty/1",
    ruleVersion: "1.0.0",
    phase: "proposal",
    verdict: "fail",
    severity: "error",
    evidence: { claim: "The fixture deliberately contradicts the independent passing validator." },
    scope: { artifactType: request.subject.type },
    conditions: { fixture: true },
  }],
})}\n`);
