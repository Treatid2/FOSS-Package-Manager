// SPDX-License-Identifier: MPL-2.0

import path from "node:path";
import { invariant } from "./errors.mjs";
import { readJson } from "./io.mjs";

export async function loadProfile(profilePath) {
  const absolutePath = path.resolve(profilePath);
  const profile = await readJson(absolutePath, "FPM_PROFILE_MALFORMED");
  invariant(profile?.schema === "fpm.profile/1", "FPM_PROFILE_SCHEMA_UNSUPPORTED",
    "Unsupported or missing profile schema.", { path: absolutePath, schema: profile?.schema });
  invariant(typeof profile.name === "string" && /^[a-z0-9][a-z0-9-]*$/.test(profile.name),
    "FPM_PROFILE_INVALID", "Profile name is invalid.", { path: absolutePath, name: profile.name });
  invariant(Array.isArray(profile.packageRoots) && profile.packageRoots.length > 0,
    "FPM_PROFILE_INVALID", "A profile must declare at least one package root.", { path: absolutePath });
  invariant(Array.isArray(profile.roots) && profile.roots.length > 0,
    "FPM_PROFILE_INVALID", "A profile must declare at least one root package.", { path: absolutePath });
  invariant(typeof profile.artifact?.type === "string" && typeof profile.entryPoint === "string",
    "FPM_PROFILE_INVALID", "A profile must declare an artifact type and entry point.", { path: absolutePath });

  const directory = path.dirname(absolutePath);
  return {
    ...profile,
    path: absolutePath,
    directory,
    resolvedPackageRoots: profile.packageRoots.map((root) => path.resolve(directory, root)),
    providers: profile.providers ?? {},
    handlerSelections: profile.handlerSelections ?? {},
    replacements: profile.replacements ?? {},
  };
}
