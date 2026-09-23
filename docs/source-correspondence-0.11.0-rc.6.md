<!-- SPDX-License-Identifier: CC-BY-4.0 -->

# 0.11.0-rc.6 public source correspondence

The canonical `0.11.0-rc.6` Windows x64 distribution was built and qualified
from retained build source commit
`0ace04c117ffe21d310dddd5a8e96a06f860cfb3`.

The public release tag is a reviewed export of that source. It preserves the
manager, public package sources, contracts, fixtures and documentation that
correspond to the accepted distribution. The export deliberately omits the
private Codex candidate-build wrapper and sanitizes environment-specific
evidence paths. The accepted `fgpm.grid-dungeon-integration-runtime` tree is
also withheld because its notice contains an internal coordination identifier;
altering it would change the accepted package root. These publication-only
differences do not alter the accepted manager archive.

The shipped distribution's `manifests/SOURCE-CORRESPONDENCE.md` records its
retained build source identity. The public tag, release asset digest and this
mapping together distinguish build provenance from the later public export
commit without fabricating an earlier public history.

Package release archives are deterministic containers of the exact accepted
package trees. Their archive digests identify the containers; their FGPM
content roots identify the contained package objects.
