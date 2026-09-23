// SPDX-License-Identifier: MPL-2.0

import path from "node:path";
import { invariant } from "./errors.mjs";
import { readJson } from "./io.mjs";
import { PUBLIC_CONTRACT, validatePublicProfileDocument } from "./public-contracts.mjs";

const PROFILE_2_KEYS = new Set(["schema", "name", "packageRoots", "distribution", "target", "policy", "user"]);
const DISTRIBUTION_KEYS = new Set(["roots", "entryPoint", "artifact", "activation"]);
const POLICY_KEYS = new Set([
  "providers", "handlerSelections", "adapterSelections", "collectionPolicy", "validation", "environmentKey", "permissions",
]);
const USER_KEYS = new Set(["roots", "replacements", "activation"]);

function validateKeys(value, allowed, layer, profilePath) {
  for (const key of Object.keys(value ?? {})) {
    invariant(allowed.has(key), "FGPM_PROFILE_AUTHORITY_UNRESOLVED",
      "A profile statement has no declared authority or merge rule in its layer.", {
        path: profilePath,
        layer,
        field: key,
        allowed: [...allowed].sort(),
      });
  }
}

function authorityRecord(field, value, sourceLayer, statementKind, mergeRule) {
  return {
    field,
    value,
    sourceLayer,
    statementKind,
    mergeRule,
    ruleOwner: "spec:fgpm.profile/2",
  };
}

export async function loadProfile(profilePath, options = {}) {
  const absolutePath = path.resolve(profilePath);
  const profile = await readJson(absolutePath, "FGPM_PROFILE_MALFORMED");
  invariant(["fgpm.profile/1", "fgpm.profile/2", PUBLIC_CONTRACT.profileSchema].includes(profile?.schema),
    "FGPM_PROFILE_SCHEMA_UNSUPPORTED",
    "Unsupported or missing profile schema.", { path: absolutePath, schema: profile?.schema });
  const corrected = profile.schema === PUBLIC_CONTRACT.profileSchema;
  if (corrected) validatePublicProfileDocument(profile, absolutePath);
  invariant(typeof profile.name === "string" && /^[a-z0-9][a-z0-9-]*$/.test(profile.name),
    "FGPM_PROFILE_INVALID", "Profile name is invalid.", { path: absolutePath, name: profile.name });
  invariant(Array.isArray(profile.packageRoots) && profile.packageRoots.length > 0,
    "FGPM_PROFILE_INVALID", "A profile must declare at least one package root.", { path: absolutePath });
  const layered = ["fgpm.profile/2", PUBLIC_CONTRACT.profileSchema].includes(profile.schema);
  if (layered) validateKeys(profile, PROFILE_2_KEYS, "document", absolutePath);
  const distribution = layered ? profile.distribution : {
    roots: profile.roots,
    entryPoint: profile.entryPoint,
    artifact: profile.artifact,
    activation: profile.activation,
  };
  const target = layered ? profile.target : {};
  const policy = layered ? profile.policy : {
    providers: profile.providers,
    handlerSelections: profile.handlerSelections,
    adapterSelections: profile.adapterSelections,
  };
  const user = layered ? profile.user : { replacements: profile.replacements };

  if (layered) {
    validateKeys(distribution, DISTRIBUTION_KEYS, "distribution", absolutePath);
    validateKeys(policy, POLICY_KEYS, "policy", absolutePath);
    validateKeys(user, USER_KEYS, "user", absolutePath);
  }

  invariant(distribution && Array.isArray(distribution.roots) && distribution.roots.length > 0,
    "FGPM_PROFILE_INVALID", "A profile distribution must declare at least one root package.", { path: absolutePath });
  invariant(typeof distribution.artifact?.type === "string" && typeof distribution.entryPoint === "string",
    "FGPM_PROFILE_INVALID", "A profile distribution must declare an artifact type and entry point.", {
      path: absolutePath,
    });
  invariant(target === undefined || (target && typeof target === "object" && !Array.isArray(target)),
    "FGPM_PROFILE_INVALID", "A profile target layer must be an object.", { path: absolutePath });
  invariant(policy === undefined || (policy && typeof policy === "object" && !Array.isArray(policy)),
    "FGPM_PROFILE_INVALID", "A profile policy layer must be an object.", { path: absolutePath });
  invariant(user === undefined || (user && typeof user === "object" && !Array.isArray(user)),
    "FGPM_PROFILE_INVALID", "A profile user layer must be an object.", { path: absolutePath });

  const userRoots = user?.roots ?? [];
  invariant(Array.isArray(userRoots), "FGPM_PROFILE_INVALID", "A profile user roots field must be an array.", {
    path: absolutePath,
  });
  invariant(policy?.environmentKey === undefined || (Array.isArray(policy.environmentKey?.widen)
    && policy.environmentKey.widen.every((entry) => typeof entry === "string")), "FGPM_PROFILE_INVALID",
  "Policy environment-key widening must be a string array.", { path: absolutePath });
  invariant(policy?.validation === undefined || (typeof policy.validation?.id === "string"
    && Array.isArray(policy.validation.requiredValidators ?? [])
    && Array.isArray(policy.validation.waivers ?? [])), "FGPM_PROFILE_INVALID",
  "Profile validation policy is malformed.", { path: absolutePath });
  invariant(policy?.collectionPolicy === undefined || (policy.collectionPolicy
    && typeof policy.collectionPolicy === "object" && !Array.isArray(policy.collectionPolicy)
    && Object.values(policy.collectionPolicy).every((entry) => typeof entry?.id === "string" && entry.id.length > 0
      && Array.isArray(entry.exclude) && entry.exclude.every((member) => typeof member === "string" && member.length > 0)
      && new Set(entry.exclude).size === entry.exclude.length)),
  "FGPM_PROFILE_INVALID", "Profile collection policy is malformed.", { path: absolutePath });

  const effectiveRoots = [...new Set([...distribution.roots, ...userRoots])];
  const effectiveActivation = user?.activation ?? distribution.activation;
  const authority = [
    authorityRecord("roots", distribution.roots, "distribution", "additive-request", "typed-set-union"),
    authorityRecord("roots", userRoots, "user", "additive-request", "typed-set-union"),
    authorityRecord("entryPoint", distribution.entryPoint, "distribution", "fixed-identity", "immutable"),
    authorityRecord("artifact", distribution.artifact, "distribution", "fixed-requirement", "immutable"),
    authorityRecord("activation", effectiveActivation, user?.activation === undefined ? "distribution" : "user",
      user?.activation === undefined ? "default" : "explicit-selection", "user-selectable"),
    authorityRecord("providers", policy?.providers ?? {}, "policy", "explicit-selection", "keyed-exact-choice"),
    authorityRecord("handlerSelections", policy?.handlerSelections ?? {}, "policy", "explicit-selection", "keyed-exact-choice"),
    authorityRecord("adapterSelections", policy?.adapterSelections ?? {}, "policy", "explicit-selection", "keyed-exact-choice"),
    authorityRecord("collectionPolicy", policy?.collectionPolicy ?? {}, "policy", "explicit-exclusion",
      "keyed-member-subtraction"),
    authorityRecord("validation", policy?.validation ?? null, "policy", "constraint", "monotonic-with-explicit-waivers"),
    authorityRecord("environmentKey", policy?.environmentKey ?? { widen: [] }, "policy", "constraint", "monotonic-widening"),
    authorityRecord("replacements", user?.replacements ?? {}, "user", "explicit-selection", "keyed-exact-choice"),
    ...Object.entries(target ?? {}).map(([key, value]) => authorityRecord(
      `target.${key}`, value, "target", "observed-target-fact", "immutable",
    )),
  ];

  const directory = path.dirname(absolutePath);
  return {
    ...profile,
    path: absolutePath,
    directory,
    layers: {
      distribution,
      target: target ?? {},
      policy: policy ?? {},
      user: user ?? {},
    },
    authority,
    roots: effectiveRoots,
    entryPoint: distribution.entryPoint,
    artifact: distribution.artifact,
    activation: effectiveActivation,
    resolvedPackageRoots: [...new Set([
      ...profile.packageRoots.map((root) => path.resolve(directory, root)),
      ...(options.packageRoots ?? []).map((root) => path.resolve(root)),
    ])],
    providers: policy?.providers ?? {},
    handlerSelections: policy?.handlerSelections ?? {},
    adapterSelections: policy?.adapterSelections ?? {},
    collectionPolicy: policy?.collectionPolicy ?? {},
    validationPolicy: policy?.validation ?? {
      id: "policy:fgpm.validation/no-unwaived-failures/1",
      requiredValidators: [],
      waivers: [],
    },
    environmentKeyWidening: policy?.environmentKey?.widen ?? [],
    permissions: corrected ? {} : (policy?.permissions ?? {}),
    replacements: user?.replacements ?? {},
  };
}
