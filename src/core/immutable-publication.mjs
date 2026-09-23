// SPDX-License-Identifier: MPL-2.0

import { lstat, rename, rm } from "node:fs/promises";
import { FgpmError } from "./errors.mjs";
import { hashDirectory } from "./io.mjs";

const COLLISION_ERRORS = new Set(["EEXIST", "ENOTEMPTY", "EPERM"]);

function failure(code, message, details) {
  const error = new FgpmError(code, message, details);
  error.preserveStaging = details.preserveStaging === true;
  return error;
}

async function targetState(target, inspect) {
  try {
    const entry = await inspect(target);
    return { exists: true, directory: entry.isDirectory(), symbolicLink: entry.isSymbolicLink() };
  } catch (error) {
    if (error?.code === "ENOENT") return { exists: false };
    throw error;
  }
}

export async function verifyPublishedDirectory(target, expectedRoot, options = {}) {
  const directoryHash = options.hashDirectory ?? hashDirectory;
  const codes = {
    unresolved: options.codes?.unresolved ?? "FGPM_IMMUTABLE_PUBLICATION_UNRESOLVED",
    conflict: options.codes?.conflict ?? "FGPM_IMMUTABLE_PUBLICATION_CONFLICT",
    unstable: options.codes?.unstable ?? "FGPM_IMMUTABLE_PUBLICATION_UNSTABLE",
  };
  const subject = options.subject ?? "immutable directory";
  let first;
  let second;
  try {
    first = `sha256:${await directoryHash(target, { strict: true })}`;
    second = `sha256:${await directoryHash(target, { strict: true })}`;
  } catch (verificationError) {
    throw failure(codes.unresolved, `The ${subject} target could not be verified.`, {
      expected: expectedRoot, staging: options.staging ?? null, target,
      publication: options.publication ?? "inspection", publicationError: options.publicationError ?? null,
      verificationError: verificationError.code ?? verificationError.message,
      preserveStaging: options.preserveStaging === true,
      recoveryAction: "Restore read access or quiesce the target, inspect it, then repeat the same operation.",
    });
  }
  if (first !== second) {
    throw failure(codes.unstable, `The ${subject} target changed while it was being verified.`, {
      expected: expectedRoot, observations: [first, second], staging: options.staging ?? null, target,
      publication: options.publication ?? "inspection", publicationError: options.publicationError ?? null,
      preserveStaging: options.preserveStaging === true,
      recoveryAction: "Quiesce competing writers, preserve the observed target, then repeat the same operation.",
    });
  }
  if (first !== expectedRoot) {
    throw failure(codes.conflict, `The ${subject} target contains different or incomplete bytes.`, {
      expected: expectedRoot, actual: first, staging: options.staging ?? null, target,
      publication: options.publication ?? "inspection", publicationError: options.publicationError ?? null,
      preserveStaging: options.preserveStaging === true,
      recoveryAction: "Preserve the existing target for assessment; move it aside only after identifying its owner, then repeat.",
    });
  }
  return { stable: true, observations: [first, second] };
}

/** Publish one content-addressed directory and prove the target is stable and exact. */
export async function publishVerifiedDirectory(staging, target, expectedRoot, options = {}) {
  const renameDirectory = options.rename ?? rename;
  const removeDirectory = options.remove ?? rm;
  const inspect = options.lstat ?? lstat;
  const codes = {
    unresolved: options.codes?.unresolved ?? "FGPM_IMMUTABLE_PUBLICATION_UNRESOLVED",
    conflict: options.codes?.conflict ?? "FGPM_IMMUTABLE_PUBLICATION_CONFLICT",
    unstable: options.codes?.unstable ?? "FGPM_IMMUTABLE_PUBLICATION_UNSTABLE",
  };
  const subject = options.subject ?? "immutable directory";
  let publication = "published";
  let publicationError = null;

  try {
    await renameDirectory(staging, target);
    await options.afterDurableChange?.({ staging, target, expectedRoot, publication });
  } catch (error) {
    if (!COLLISION_ERRORS.has(error?.code)) throw error;
    publicationError = error.code;
    let observed;
    try {
      observed = await targetState(target, inspect);
    } catch (inspectionError) {
      throw failure(codes.unresolved, `The ${subject} target could not be inspected after publication failed.`, {
        expected: expectedRoot, staging, target, publicationError,
        verificationError: inspectionError.code ?? inspectionError.message,
        preserveStaging: true,
        recoveryAction: "Restore access or quiesce the target, then repeat the same operation.",
      });
    }
    if (!observed.exists) {
      throw failure(codes.unresolved, `The ${subject} was not published and no reusable target exists.`, {
        expected: expectedRoot, staging, target, publicationError, preserveStaging: true,
        recoveryAction: "Restore target-parent write access, then repeat the same operation.",
      });
    }
    if (!observed.directory || observed.symbolicLink) {
      throw failure(codes.conflict, `The ${subject} target is not a reusable real directory.`, {
        expected: expectedRoot, actual: null, staging, target, publicationError, preserveStaging: true,
        recoveryAction: "Move the conflicting target aside after assessment, then repeat the same operation.",
      });
    }
    publication = "reused";
  }

  const verification = await verifyPublishedDirectory(target, expectedRoot, {
    ...options, codes, subject, staging, publication, publicationError,
    preserveStaging: publication === "reused",
  });
  if (publication === "reused") await removeDirectory(staging, { recursive: true, force: true });
  return {
    status: publication, root: expectedRoot, target,
    verification,
    ...(publicationError ? { publicationError } : {}),
  };
}
