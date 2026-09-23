# Operation maturity and initial agent authority

The public JSONL protocol remains the sole semantic authority. Transport availability does not itself grant a client permission to invoke every operation.

Each operation description publishes:

- category and maturity;
- ordinary guided-human availability;
- headless availability;
- initial curator-agent availability;
- whether it moves authority;
- confirmation strength;
- the boundary before which a failure must occur without committing state.

The initial curator profile is manager-derived and project-filtered without contacting a curator service. Its invariant is:

```text
agentAllowed semantic operations
    subset of
guided-project-supported human operations
```

It is also an executable server boundary. The profile is fixed by the local action endpoint before
request JSON is read for semantic dispatch. A denied operation returns
`FPM_WORKBENCH_OPERATION_NOT_ALLOWED`, records the effective profile and caller attribution, and
creates no manager request or authoritative state.

Inspection may be agent-allowed only when an equivalent ordinary human view exists in the executable
guided registry. Expert/debug operations and persistent runtime-lifecycle operations withheld from
agents use distinct explicit profiles and are excluded from initial-curator authority. The expert
JSON console is not counted as guided support.

The correction explicitly classifies `workspace.create`, `workspace.fork`, `workspace.export`, `distribution.export`, `distribution.verify`, and runtime tick/checkpoint/resume/shutdown. Documentation and tests must reflect the actual guided controls rather than the theoretical reach of the shared transport.
