<!-- SPDX-License-Identifier: MPL-2.0 -->

# Phase 9 generation/runtime closure correction map

**Correction branch:** `phase-9/generation-runtime-closure-correction`  
**Exact baseline:** `27a2097579afed7b8d78d0071753036da9092dc9`  
**Hub handoff:** `FGPM-C2C-000010` / `FGPM-CYCLE-000010`  
**Protocol messages:** `FGPM-MSG-000008` through `FGPM-MSG-000012`  
**Formal package cycle:** `FGPM-CYCLE-000004`  
**Historical local implementation cycle:** `FGPM-CYCLE-000007`

This correction preserves the accepted Phase 9 package store, workspace/CAS, impact,
generation-reference, transition, exit, and synthetic-scale mechanisms. It closes the authority
gap between those mechanisms and the established complete resolver/build/runtime pipeline.

## Authority before correction

```text
workspace revision
  -> CurationManager.planCandidate
       simplified dependency/capability resolver
       recorded adapter/replacement/collection choices (not applied)
       synthetic runtimeFacts
  -> buildCandidate
       structural derived-package envelope only
  -> validateCandidate
       package-root existence only
  -> commitGeneration
       candidate runtime facts copied into generation

independent profile path
  -> buildProfile
       complete resolver, handlers, bindings, governed adapters,
       validator policy, artifact transaction, activation planning
  -> phase8RuntimeFactory(build result)

generation + independently supplied/registered runtime factory
  -> GenerationRuntimeCoordinator.transition
```

The generation did not prove equality with the complete build. Distribution export retained
package/generation metadata but not the executable artifact store. Activation could associate a
generation with a build derived from another profile. Automatic rollback reactivated the prior
generation while retaining its old session identity.

## Corrected authority and commit path

```text
workspace immutable revision + explicit complete-build intent + effective choices
  -> fast Phase 9 impact plan (non-authoritative optimisation)
  -> generated profile rooted only in selected immutable package trees
  -> established buildProfile pipeline
       resolvePackages
       handler analysis
       public hook/default/replacement binding
       governed adapter selection
       proposal validation and policy decision
       accepted action/artifact DAG
       transactional materialisation in a fresh content store
       selected activation artifact
  -> resolveRuntimePlan
  -> immutable complete-build closure
       profile + lock + provenance + output artifact
       exact artifact objects/trees and action records
       exact runtime plan and public-contract roots
  -> candidate-build record
       impact-selection root + authoritative-selection root
       equality required
  -> candidate-validation record
       exact complete-build roots and accepted findings
  -> generation commit
       refuses missing/mismatched complete-build authority
       records the exact activation artifact, runtime plan,
       resolution/lock, policy/validation, action/artifact, build-closure,
       contract, source-package, and derived-package roots
  -> workspace-head compare-and-swap
```

The fast planner remains useful for causal impact and scale observations. It is never sufficient
for generation commit when its selected facts disagree with the complete resolver result.

## Effective staged choices

The generated complete-build profile is derived from the immutable candidate, never ambient CLI
state:

| Workspace choice | Complete-pipeline authority |
| --- | --- |
| provider | profile policy `providers` |
| adapter | profile policy `adapterSelections` |
| replacement | profile user `replacements` |
| exact collection include/exclude | profile policy `collectionPolicy`; an include allow-list excludes every other known member and explicit excludes remain excluded |

Unsupported or inconsistent choices fail planning/build with structured diagnostics; none may be
committed as inert curator intent.

## Specialist generated-package transaction

```text
selected generator package + exact handler/action identity
  + verified source package roots
  + verified prior-build artifact roots
  + parameters and declared environment
  -> existing ArtifactStore / executeArtifactGraph transaction
  -> specialist-produced domain tree bytes
  -> manager adds strict package envelope and provenance
  -> immutable package content root + derived-package record
```

The manager owns generic identity, verification, and package assembly. The selected package owns
the generated domain bytes. One derivation layer remains enforced.

## Generation-only activation

```text
generation root
  -> verify immutable generation and every complete-build root
  -> open its retained/imported build closure
  -> hydrate the already committed runtime plan against exact package roots
  -> verify hydrated plan root and activation-artifact root
  -> start runtime
```

The activation API accepts no semantic profile, provider, artifact, or runtime-plan override.
Snapshot destinations and other host observations remain non-semantic options.

## Executable distribution replay

Export contains the generation, all source and derived package trees, the exact complete-build
closure, artifact objects/trees, action records, lock/resolution, validation/policy evidence,
activation artifact, runtime plan, and required contract files. Import verifies the complete member
set and every byte before publishing package, build-closure, generation, or distribution records.
A fresh manager activates the imported generation through the same generation-only path.

## Transition and rollback identities

The active reference remains the final commit point. A failed target attempt becomes an immutable
attempt record. Restoring the prior generation publishes a new rollback runtime-session record and
moves the active reference to the same generation root plus that new session root. The record links
the prior session, failed target attempt, checkpoint, and rollback session. Explicit rollback uses
the same truthful new-session rule.

## Durable records and ownership

`src/core/phase9-contracts.mjs` remains the manager's strict machine validator. The public
`contracts/phase-9` bundle is split by concern rather than enlarged into one permissive union:

- package and derived-package records;
- workspace and candidate/build/validation records;
- generation, complete-build, and distribution records;
- transition checkpoint, attempt, runtime session, and active reference records.

All use exact `/1` identities, closed unknown fields, deterministic identity descriptions, explicit
experimental status, and `fpm.manager-core/3` stewardship.

## Principal retained verification

One correction fixture will create G0 and G1 through the complete pipeline, execute a real
specialist generator for G1, export/import G1 into an empty store, activate it from the generation
root alone, tick and render, attempt a failing G2 transition, and prove rollback to G1 under a new
session. Integrated 10/100/1,000 cases separately record impact planning, authoritative
resolution/build validation, materialisation, and generation commit.

## Non-goals

No remote repository, signatures/trust, destructive collection, recursive generation, per-service
hot swap, zero-downtime/multiplayer transition, renderer/engine integration, typed-artifact-provider
experiment, version-one promise, push, publication, pull request, release, merge, or tag mutation is
part of this correction.
