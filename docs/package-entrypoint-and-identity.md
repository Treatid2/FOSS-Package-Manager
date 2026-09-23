<!-- SPDX-License-Identifier: CC-BY-4.0 -->

# FGPM package entrypoint and identity

This chapter defines the public package boundary introduced by FGPM `0.11.0-rc.1`.
It replaces the development-only `fpm` labels used by the `0.10.0-rc.3`
checkpoint. The old checkpoint remains immutable historical evidence; it is not a
second normal-reader format.

## One permanent entrypoint

A package root contains exactly one file named `fgpm-package.json`. The spelling
and case are exact. It is a UTF-8 JSON object with no duplicate member names. Its
top-level `format` string selects package interpretation:

```json
{
  "format": "fgpm.package/1",
  "namespace": "6d7092e8-6f8a-4e25-bb6e-a0bf6588e5b4",
  "name": "example.package",
  "version": "1.0.0",
  "license": "MPL-2.0"
}
```

`format` is not the manager version, package version, handler protocol, or
runtime protocol. Unknown formats fail with a structured diagnostic. A package
declaration never instructs the manager to download or execute a format reader.

The normal reader rejects:

- the pre-public `fpm-package.json` entrypoint;
- case variants of the permanent name;
- current and pre-public descriptors in the same package root;
- duplicate JSON members, malformed UTF-8, and malformed JSON;
- duplicate or case-ambiguous archive entries; and
- a single-package archive that wraps or renames the root entrypoint.

A multi-package container is not itself one package. Each contained package has
its own root and entrypoint, and a container index is advisory unless a separate
format explicitly makes it authoritative.

## Publisher namespace and package lineage

Package lineage is the pair `(namespace, name)`:

- `namespace` is a publisher-generated, lower-case RFC 9562 UUID;
- `name` is the publisher's immutable local package name; and
- the canonical human/machine selector is `namespace/name`.

FGPM's publisher namespace is
`6d7092e8-6f8a-4e25-bb6e-a0bf6588e5b4`. Publishers generate and retain their
own namespace locally; there is no central allocation service and packages do
not receive individual UUIDs. The `fgpm-` archive-name prefix is advisory only.

The namespace/name pair identifies a lineage. `version` identifies a declared
release within that lineage. An exact content root identifies the immutable
object. Manager receipts record all four facts. A local-name shorthand is
accepted only when discovery finds one publisher namespace; ambiguity requires
the exact `namespace/name` coordinate.

Names, capabilities, and content roots answer different questions. Catalogues
may index them, but a catalogue does not allocate identity or override package
bytes. Discovery remains capability-first after package identity has been
established.

## Sidecars, catalogues, and access

Checksums, signatures, SBOMs, provenance, and catalogue records may accompany a
package. They are optional sidecars, not competing entrypoints. When supplied,
a sidecar must match the exact package root it describes; mismatch is an error
for the operation that elected to trust it. Absence does not change package
interpretation.

The same entrypoint and fields are intended for direct filesystem use, archives,
HTTP publication, source repositories, and catalogue indexing. A human can open
the JSON; a tool can parse it without executing package code or fetching a
reader.

## Finite migration boundary

`fgpm migrate pre-public-package` is the separately identified migration path.
It accepts only `fpm.package/1` and `fpm.package/2`, previews by default, and in
apply mode writes a new tree to an explicit output. It never edits its source,
private manager indices, or a package in place; it loads no package code and
uses no network access. Output promotion is atomic and is followed by two exact
content-root observations before success is recorded. Apply writes a durable
operation record beside the output at
`<absolute-output>.fgpm-migration-operation.json`; this records the request,
source root, plan, expected commit root, result, failure and next continuation.

```powershell
fgpm migrate pre-public-package C:\old-package `
  --namespace 6d7092e8-6f8a-4e25-bb6e-a0bf6588e5b4

fgpm migrate pre-public-package C:\old-package `
  --namespace 6d7092e8-6f8a-4e25-bb6e-a0bf6588e5b4 `
  --apply --out C:\migrated-package

fgpm migrate pre-public-package status --out C:\migrated-package
```

Repeating the exact apply request after restart verifies and reuses a matching
target, including when the durable rename or committed state preceded an
unavailable response. A different, incomplete, inaccessible, or concurrently
changing target is never treated as success; the operation record retains an
explicit diagnostic and continuation, and both target and known staging bytes
are preserved for assessment. The normative transition resource is
`public/migrations/pre-public-package-v1.json` and the durable record schema is
`public/schemas/pre-public-migration-operation-v1.schema.json`.

Applying the utility to already-current input in a fresh output location is
idempotent. Existing private manager state is transitioned by exporting or
copying the owned package source, applying this utility per publisher namespace,
and importing the successor packages through the new manager API. The package
migration tool does not perform a curator's project-state transition. Direct
edits to installed-index or immutable-object records are forbidden.

## Standards

JSON interpretation follows RFC 8259 with the stricter duplicate-member rule
above. Namespace syntax follows RFC 9562 UUID textual form. Semantic versions
remain package declarations; the exact root remains the final immutable object
identity.
