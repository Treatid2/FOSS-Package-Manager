<!-- SPDX-License-Identifier: CC-BY-4.0 -->

# FGPM 0.11.0-rc.6 prerelease notes

This candidate supersedes `0.11.0-rc.5` to correct the shipped current-use
public runtime-session guide. RC5 source, distribution, qualification, retained
manager state, generation and diagnostic evidence remain immutable historical
artifacts.

## Current public session documentation

`guide/public-runtime-sessions.md` now uses the actual
`fgpm.control-request/1` and `fgpm.control-response/1` JSONL envelopes and names
the current `fgpm.public-runtime-session/1`,
`fgpm.public-runtime-session-call/1`, and
`fgpm.public-runtime-session-close/1` result schemas. The guide identifies the
packaged qualification fixture substitutions for its illustrative placeholders
and points to the retained raw request/response evidence.

The related human/agent authority document uses the same current `fgpm.*`
transport vocabulary. Historical release notes, finite migration documentation,
third-party identities and immutable evidence are not rewritten.
The permanent public identity boundary remains documented in
`guide/package-entrypoint-and-identity.md`.

## Version and qualification boundary

There is no runtime algorithm or public operation change. The new version,
source commit, manager build identity, public-contract root, distribution root,
archive digest and source-correspondence root are nevertheless distinct and must
be reported truthfully. The complete RC6 distribution is tested from a clean
extraction. Its source-free public qualification directly exercises concrete
open, call and close requests and preserves raw JSONL, stdout, stderr, process
exit and timestamps; the legacy `fpm.control-request/1` envelope remains
rejected before operation dispatch.

The RC5 full developer, focused, public and reference-distribution evidence is
not relabelled as a fresh RC6 run. Gate B remains evidence for its exact measured
artifacts. RC6 was independently assessed and accepted for publication. The
canonical Windows x64 manager archive is published unchanged from that accepted
candidate; its SHA-256 is
`b396a7675af15b2252737a41311742f178ceb4e9d83703b20960ed7fbba09701`.

The same prerelease publishes deterministic archives for 28 exact FGPM-owned
package trees with an identity/checksum index. The accepted
`fgpm.grid-dungeon-integration-runtime` tree remains withheld because its notice
contains an internal coordination identifier; changing that notice would change
the accepted package root. The three independently owned `fgdungeon.*` packages
and the FGRW project remain on their separate publication route.

The tagged public source is a reviewed export mapped to retained build source
`0ace04c117ffe21d310dddd5a8e96a06f860cfb3`; see
`docs/source-correspondence-0.11.0-rc.6.md`. Publication does not relabel the
RC5 Gate B generation, infer FGRW publication, or close the programme cycle.
