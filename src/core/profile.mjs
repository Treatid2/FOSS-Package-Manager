// SPDX-License-Identifier: MPL-2.0

import path from "node:path";
import { invariant } from "./errors.mjs";
import { readJson } from "./io.mjs";

const PROFILE_2_KEYS = new Set(["schema", "name", "packageRoots", "distribution", "target", "policy", "user"]);
const DISTRIBUTION_KEYS = new Set(["roots", "entryPoint", "artifact", "activation"]);
const POLICY_KEYS = new Set([
  "providers", "handlerSelections", "adapterSelections", "validation", "environmentKey", "permissions",
]);
const USER_KEYS = new Set(["roots", "replacements", "activation"]);

function validateKeys(value, allowed, layer, profilePath) {
  for (const key of Object.keys(value ?? {})) {
    invariant(allowed.has(key), "FPM_PROFILE_AUTHORITY_UNRESOLVED",
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
    ruleOwner: "spec:fpm.profile/2",
  };
}

export async function loadProfile(profilePath) {
  const absolutePath = path.resolve(profilePath);
  const profile = await readJson(absolutePath, "FPM_PROFILE_MALFORMED");
  invariant(["fpm.profile/1", "fpm.profile/2"].includes(profile?.schema), "FPM_PROFILE_SCHEMA_UNSUPPORTED",
    "Unsupported or missing profile schema.", { path: absolutePath, schema: profile?.schema });
  invariant(typeof profile.name === "string" && /^[a-z0-9][a-z0-9-]*$/.test(profile.name),
    "FPM_PROFILE_INVALID", "Profile name is invalid.", { path: absolutePath, name: profile.name });
  invariant(Array.isArray(profile.packageRoots) && profile.packageRoots.length > 0,
    "FPM_PROFILE_INVALID", "A profile must declare at least one package root.", { path: absolutePath });
  const layered = profile.schema === "fpm.profile/2";
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
    "FPM_PROFILE_INVALID", "A profile distribution must declare at least one root package.", { path: absolutePath });
  invariant(typeof distribution.artifact?.type === "string" && typeof distribution.entryPoint === "string",
    "FPM_PROFILE_INVALID", "A profile distribution must declare an artifact type and entry point.", {
      path: absolutePath,
    });
  invariant(target === undefined || (target && typeof target === "object" && !Array.isArray(target)),
    "FPM_PROFILE_INVALID", "A profile target layer must be an object.", { path: absolutePath });
  invariant(policy === undefined || (policy && typeof policy === "object" && !Array.isArray(policy)),
    "FPM_PROFILE_INVALID", "A profile policy layer must be an object.", { path: absolutePath });
  invariant(user === undefined || (user && typeof user === "object" && !Array.isArray(user)),
    "FPM_PROFILE_INVALID", "A profile user layer must be an object.", { path: absolutePath });

  const userRoots = user?.roots ?? [];
  invariant(Array.isArray(userRoots), "FPM_PROFILE_INVALID", "A profile user roots field must be an array.", {
    path: absolutePath,
  });
  invariant(policy?.environmentKey === undefined || (Array.isArray(policy.environmentKey?.widen)
    && policy.environmentKey.widen.every((entry) => typeof entry === "string")), "FPM_PROFILE_INVALID",
  "Policy environment-key widening must be a string array.", { path: absolutePath });
  invariant(policy?.validation === undefined || (typeof policy.validation?.id === "string"
    && Array.isArray(policy.validation.requiredValidators ?? [])
    && Array.isArray(policy.validation.waivers ?? [])), "FPM_PROFILE_INVALID",
  "Profile validation policy is malformed.", { path: absolutePath });

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
    resolvedPackageRoots: profile.packageRoots.map((root) => path.resolve(directory, root)),
    providers: policy?.providers ?? {},
    handlerSelections: policy?.handlerSelections ?? {},
    adapterSelections: policy?.adapterSelections ?? {},
    validationPolicy: policy?.validation ?? {
      id: "policy:fpm.validation/no-unwaived-failures/1",
      requiredValidators: [],
      waivers: [],
    },
    environmentKeyWidening: policy?.environmentKey?.widen ?? [],
    permissions: policy?.permissions ?? {},
    replacements: user?.replacements ?? {},
  };
}
