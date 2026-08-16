// SPDX-License-Identifier: MPL-2.0

import path from "node:path";
import { invariant } from "./errors.mjs";
import { readJson } from "./io.mjs";

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
    roots: [...new Set([...distribution.roots, ...userRoots])],
    entryPoint: distribution.entryPoint,
    artifact: distribution.artifact,
    activation: user?.activation ?? distribution.activation,
    resolvedPackageRoots: profile.packageRoots.map((root) => path.resolve(directory, root)),
    providers: policy?.providers ?? {},
    handlerSelections: policy?.handlerSelections ?? {},
    adapterSelections: policy?.adapterSelections ?? {},
    replacements: user?.replacements ?? {},
  };
}
