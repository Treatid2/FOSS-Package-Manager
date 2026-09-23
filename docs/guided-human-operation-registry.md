# Guided human operation registry

The ordinary Workbench needs a machine-readable operation-to-visible-element registry. The initial curator profile must be a subset of this registry; the expert JSON console never counts toward parity.

## Pre-change gap

The initial curator profile contains 20 guided operations. Most have ordinary controls or summary views, but `workspace.history` and `manager.reachability` are available only inside raw overview data. Retained generations and the effective route-bound profile also need explicit visible, labelled summaries.

## Registry contract

The executable registry lives in `tools/curator-workbench/guided-operation-registry.mjs`. Each entry has:

- public operation identity;
- visible DOM element identity;
- kind: `control` or `view`;
- concise human label.

The browser renders the relevant IDs in ordinary sections. A manager test compares the enforced `initial-curator` operation set with the registry and verifies every registered element exists in `index.html` or is rendered by `app.js` as an explicit identified card.

The new ordinary authority and inspection section will expose:

- effective page profile and the initial curator profile;
- complete visible capability mapping;
- workspace revision history;
- manager reachability and retained-generation summaries.

All views use headings and textual status, remain keyboard-reachable through normal document navigation, and do not require opening the expert console.
