// SPDX-License-Identifier: MPL-2.0

import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { invariant } from "./errors.mjs";
import { readJson, resolveInside } from "./io.mjs";
import { parseVersion } from "./semver.mjs";

export const PUBLIC_CONTRACT = Object.freeze({
  schema: "fgpm.public-contract-registry/1",
  status: "experimental",
  packageFormat: "fgpm.package/2",
  profileSchema: "fgpm.profile/3",
  serviceProtocol: "fgpm.runtime-service/2",
  serviceResponseProtocol: "fgpm.runtime-service-response/2",
  taskMemberSchema: "fgpm.runtime-task-member/2",
  taskProtocol: "fgpm.runtime-task/2",
  taskCapabilityVersion: "2.0.0",
  taskVocabulary: "fgpm.runtime-task-vocabulary/2",
  transformVocabulary: "fgpm.transform-task-vocabulary/1",
  transformSnapshot: "fgpm.transform-snapshot/1",
  transformOperation: "fgpm.transform-operation/1",
  transformChannel: "runtime.transforms.commands",
  artifactReference: "fgpm.typed-artifact-reference/1",
  hostGrantRequest: "fgpm.host-grant-request/1",
  hostGrantRecord: "fgpm.host-grant-record/1",
});

const PACKAGE_ID = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;
const NAMESPACE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const PACKAGE_SELECTOR = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/)?[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u;
const SERVICE_ID = /^service:[a-z0-9][a-z0-9.-]*\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]+$/;
const MEMBER_ID = /^task:[a-z0-9][a-z0-9.-]*\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]+$/;
const GRANT_ID = /^fgpm\.host\.[a-z0-9][a-z0-9.-]*\/1$/;
const VOCABULARY_ID = /^fgpm\.[a-z0-9][a-z0-9.-]*-vocabulary\/[0-9]+$/;

export function validatePackageEntrypoints(entryNames, directory) {
  const names = [...entryNames];
  const current = names.filter((name) => name.toLowerCase() === "fgpm-package.json");
  const legacy = names.filter((name) => name.toLowerCase() === "fpm-package.json");
  invariant(current.length <= 1 && (current.length === 0 || current[0] === "fgpm-package.json"),
    "FGPM_PACKAGE_ENTRYPOINT_AMBIGUOUS", "A package directory contains an ambiguous case variant of its entrypoint.", {
      directory, entries: current.sort(), expected: "fgpm-package.json",
    });
  invariant(legacy.length === 0 || current.length === 0, "FGPM_PACKAGE_ENTRYPOINT_COMPETING",
    "A package directory contains competing current and pre-public descriptors.", {
      directory, current, legacy,
    });
  invariant(legacy.length === 0, "FGPM_PRE_PUBLIC_ENTRYPOINT_UNSUPPORTED",
    "The normal reader does not accept the pre-public package entrypoint; use the finite migration command.", {
      directory, entry: legacy[0], migration: "fgpm migrate pre-public-package",
    });
  return current[0] ?? null;
}

async function validatePackageEntrypointDirectory(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  return validatePackageEntrypoints(entries.filter((entry) => entry.isFile()).map((entry) => entry.name), directory);
}
const HOST_GRANT_IDS = new Set([
  "fgpm.host.renderer-output/1",
  "fgpm.host.runtime-interaction/1",
  "fgpm.host.persistence-input/1",
  "fgpm.host.persistence-records/1",
  "fgpm.host.persistence-conformance/1",
  "fgpm.host.scheduler-records/1",
  "fgpm.host.scheduler-conformance/1",
]);

const PACKAGE_KEYS = new Set(["format", "namespace", "name", "version", "license", "dependencies", "runtimeServices"]);
const DEPENDENCY_KEYS = new Set(["package", "range"]);
const SERVICE_KEYS = new Set([
  "id", "protocol", "provides", "requires", "artifactAccess", "artifactStoreAccess", "hostGrants",
  "execution", "module", "activationContract",
]);
const PROVIDED_KEYS = new Set([
  "capability", "version", "cardinality", "member", "binding", "memberDependencies", "metadata",
]);
const REQUIREMENT_KEYS = new Set(["capability", "range", "cardinality", "binding", "optional"]);
const EXECUTION_KEYS = new Set(["form", "securityBoundary", "requestedPowers"]);
const TASK_METADATA_KEYS = new Set([
  "schema", "vocabulary", "participation", "failurePolicy", "affinity", "snapshots", "outputs",
]);
const SNAPSHOT_KEYS = new Set(["capability", "schema", "vocabulary"]);
const OUTPUT_KEYS = new Set(["channel", "vocabulary", "stage", "law"]);
const ACTIVATION_KEYS = new Set(["schema", "service", "capabilities"]);
const TASK_VALUE_KEYS = new Set(["protocol", "provider", "workerModule"]);

const PROFILE_KEYS = new Set(["schema", "name", "packageRoots", "distribution", "target", "policy", "user"]);
const DISTRIBUTION_KEYS = new Set(["roots", "entryPoint", "artifact", "activation"]);
const ARTIFACT_KEYS = new Set(["type", "builder"]);
const POLICY_KEYS = new Set([
  "providers", "handlerSelections", "adapterSelections", "collectionPolicy", "validation", "environmentKey",
]);
const COLLECTION_POLICY_KEYS = new Set(["id", "exclude"]);
const VALIDATION_KEYS = new Set(["id", "requiredValidators", "waivers"]);
const ENVIRONMENT_KEY_KEYS = new Set(["widen"]);
const USER_KEYS = new Set(["roots", "replacements", "activation"]);

function fail(condition, code, message, details) {
  invariant(condition, code, message, {
    steward: details.steward ?? "fgpm.manager-core/2",
    rule: details.rule,
    instancePath: details.instancePath,
    ...details,
  });
}

function object(value, instancePath, schema, steward = "fgpm.manager-core/2") {
  fail(value && typeof value === "object" && !Array.isArray(value), "FGPM_PUBLIC_SCHEMA_INVALID",
    "A public contract value must be an object.", {
      schema, steward, rule: "type:object", instancePath, actualType: Array.isArray(value) ? "array" : typeof value,
    });
}

function strictKeys(value, allowed, instancePath, schema, steward = "fgpm.manager-core/2") {
  object(value, instancePath, schema, steward);
  for (const field of Object.keys(value)) {
    fail(allowed.has(field), "FGPM_PUBLIC_FIELD_UNKNOWN", "A strict public object contains an unsupported field.", {
      schema, steward, rule: "additionalProperties:false", instancePath: `${instancePath}/${field}`,
      field, allowed: [...allowed].sort(),
    });
  }
}

function required(value, fields, instancePath, schema, steward = "fgpm.manager-core/2") {
  for (const field of fields) {
    fail(Object.hasOwn(value, field), "FGPM_PUBLIC_FIELD_REQUIRED", "A strict public object omits a required field.", {
      schema, steward, rule: "required", instancePath: `${instancePath}/${field}`, field,
    });
  }
}

function string(value, instancePath, schema, options = {}) {
  fail(typeof value === "string" && (options.nonEmpty !== true || value.length > 0)
    && (!options.pattern || options.pattern.test(value)), "FGPM_PUBLIC_VALUE_INVALID",
  "A public string value does not satisfy its contract.", {
    schema, steward: options.steward, rule: options.rule ?? "type:string", instancePath, value,
  });
}

function strings(value, instancePath, schema, options = {}) {
  fail(Array.isArray(value), "FGPM_PUBLIC_VALUE_INVALID", "A public field must be an array.", {
    schema, steward: options.steward, rule: "type:array", instancePath,
  });
  value.forEach((entry, index) => string(entry, `${instancePath}/${index}`, schema, {
    nonEmpty: true, pattern: options.pattern, steward: options.steward,
  }));
  if (options.unique !== false) {
    fail(new Set(value).size === value.length, "FGPM_PUBLIC_VALUE_INVALID", "A public array must contain unique values.", {
      schema, steward: options.steward, rule: "uniqueItems", instancePath, value,
    });
  }
}

function enumeration(value, values, instancePath, schema, steward) {
  fail(values.includes(value), "FGPM_PUBLIC_VALUE_INVALID", "A public value is outside its declared vocabulary.", {
    schema, steward, rule: "enum", instancePath, value, allowed: values,
  });
}

function validateTaskMetadata(metadata, instancePath) {
  const schema = PUBLIC_CONTRACT.taskMemberSchema;
  const steward = PUBLIC_CONTRACT.taskVocabulary;
  strictKeys(metadata, TASK_METADATA_KEYS, instancePath, schema, steward);
  required(metadata, [...TASK_METADATA_KEYS], instancePath, schema, steward);
  fail(metadata.schema === schema, "FGPM_PUBLIC_VALUE_INVALID", "A runtime-task member uses an unsupported schema.", {
    schema, steward, rule: "const", instancePath: `${instancePath}/schema`, value: metadata.schema,
  });
  fail(metadata.vocabulary === steward, "FGPM_PUBLIC_VALUE_INVALID", "A runtime-task member names the wrong vocabulary steward.", {
    schema, steward, rule: "const", instancePath: `${instancePath}/vocabulary`, value: metadata.vocabulary,
  });
  enumeration(metadata.participation, ["required", "optional"], `${instancePath}/participation`, schema, steward);
  enumeration(metadata.failurePolicy, ["abort-tick", "drop-task"], `${instancePath}/failurePolicy`, schema, steward);
  enumeration(metadata.affinity, ["main-thread", "any-worker"], `${instancePath}/affinity`, schema, steward);
  fail(Array.isArray(metadata.snapshots), "FGPM_PUBLIC_VALUE_INVALID", "Task snapshots must be an array.", {
    schema, steward, rule: "type:array", instancePath: `${instancePath}/snapshots`,
  });
  for (const [index, snapshot] of metadata.snapshots.entries()) {
    const itemPath = `${instancePath}/snapshots/${index}`;
    strictKeys(snapshot, SNAPSHOT_KEYS, itemPath, schema, steward);
    required(snapshot, [...SNAPSHOT_KEYS], itemPath, schema, steward);
    string(snapshot.capability, `${itemPath}/capability`, schema, { nonEmpty: true, steward });
    string(snapshot.schema, `${itemPath}/schema`, schema, { nonEmpty: true, steward });
    string(snapshot.vocabulary, `${itemPath}/vocabulary`, schema, { pattern: VOCABULARY_ID, steward });
  }
  fail(Array.isArray(metadata.outputs) && metadata.outputs.length > 0, "FGPM_PUBLIC_VALUE_INVALID",
    "A runtime task must declare at least one output channel.", {
      schema, steward, rule: "minItems:1", instancePath: `${instancePath}/outputs`,
    });
  for (const [index, output] of metadata.outputs.entries()) {
    const itemPath = `${instancePath}/outputs/${index}`;
    strictKeys(output, OUTPUT_KEYS, itemPath, schema, steward);
    required(output, [...OUTPUT_KEYS], itemPath, schema, steward);
    string(output.channel, `${itemPath}/channel`, schema, { nonEmpty: true, steward });
    string(output.vocabulary, `${itemPath}/vocabulary`, schema, { pattern: VOCABULARY_ID, steward });
    string(output.stage, `${itemPath}/stage`, schema, { nonEmpty: true, steward });
    string(output.law, `${itemPath}/law`, schema, { nonEmpty: true, steward });
    if (output.channel === PUBLIC_CONTRACT.transformChannel) {
      fail(output.vocabulary === PUBLIC_CONTRACT.transformVocabulary, "FGPM_PUBLIC_VALUE_INVALID",
        "The transform command channel must name its declared vocabulary steward.", {
          schema, steward: PUBLIC_CONTRACT.transformVocabulary, rule: "channel-vocabulary",
          instancePath: `${itemPath}/vocabulary`, value: output.vocabulary,
        });
    }
  }
}

export function validatePublicPackageDocument(manifest, manifestPath = "<package>/fgpm-package.json") {
  const schema = PUBLIC_CONTRACT.packageFormat;
  strictKeys(manifest, PACKAGE_KEYS, "", schema);
  required(manifest, [...PACKAGE_KEYS], "", schema);
  fail(manifest.format === schema, "FGPM_MANIFEST_SCHEMA_UNSUPPORTED", "Unsupported public package format.", {
    schema, rule: "const", instancePath: "/format", value: manifest.format, path: manifestPath,
  });
  string(manifest.namespace, "/namespace", schema, { pattern: NAMESPACE_ID });
  string(manifest.name, "/name", schema, { pattern: PACKAGE_ID });
  parseVersion(manifest.version, "public package version");
  string(manifest.license, "/license", schema, { nonEmpty: true });
  fail(Array.isArray(manifest.dependencies), "FGPM_PUBLIC_VALUE_INVALID", "Package dependencies must be an array.", {
    schema, rule: "type:array", instancePath: "/dependencies",
  });
  for (const [index, dependency] of manifest.dependencies.entries()) {
    const itemPath = `/dependencies/${index}`;
    strictKeys(dependency, DEPENDENCY_KEYS, itemPath, schema);
    required(dependency, [...DEPENDENCY_KEYS], itemPath, schema);
    string(dependency.package, `${itemPath}/package`, schema, { pattern: PACKAGE_SELECTOR });
    string(dependency.range, `${itemPath}/range`, schema, { nonEmpty: true });
  }
  fail(Array.isArray(manifest.runtimeServices), "FGPM_PUBLIC_VALUE_INVALID", "Package runtimeServices must be an array.", {
    schema, rule: "type:array", instancePath: "/runtimeServices",
  });
  const services = [];
  const tasks = [];
  for (const [serviceIndex, service] of manifest.runtimeServices.entries()) {
    const servicePath = `/runtimeServices/${serviceIndex}`;
    strictKeys(service, SERVICE_KEYS, servicePath, schema);
    required(service, ["id", "protocol", "provides", "requires", "artifactAccess", "artifactStoreAccess",
      "hostGrants", "execution", "module", "activationContract"], servicePath, schema);
    string(service.id, `${servicePath}/id`, schema, { pattern: SERVICE_ID });
    fail(service.protocol === PUBLIC_CONTRACT.serviceProtocol, "FGPM_PUBLIC_VALUE_INVALID",
      "A corrected runtime service must use the v2 service protocol.", {
        schema, rule: "const", instancePath: `${servicePath}/protocol`, value: service.protocol,
      });
    enumeration(service.artifactAccess, ["none", "read"], `${servicePath}/artifactAccess`, schema);
    enumeration(service.artifactStoreAccess, ["none", "read", "read-write"],
      `${servicePath}/artifactStoreAccess`, schema);
    strings(service.hostGrants, `${servicePath}/hostGrants`, schema, { pattern: GRANT_ID });
    for (const [grantIndex, grant] of service.hostGrants.entries()) {
      fail(HOST_GRANT_IDS.has(grant), "FGPM_HOST_GRANT_UNKNOWN",
        "A corrected runtime service requests a host grant outside the public vocabulary.", {
          schema, steward: "fgpm.host-grants-vocabulary/1", rule: "closed-vocabulary",
          instancePath: `${servicePath}/hostGrants/${grantIndex}`, grant,
          allowed: [...HOST_GRANT_IDS].sort(),
        });
    }
    string(service.module, `${servicePath}/module`, schema, { nonEmpty: true });
    string(service.activationContract, `${servicePath}/activationContract`, schema, { nonEmpty: true });
    strictKeys(service.execution, EXECUTION_KEYS, `${servicePath}/execution`, schema);
    required(service.execution, [...EXECUTION_KEYS], `${servicePath}/execution`, schema);
    fail(service.execution.form === "native-in-process" && service.execution.securityBoundary === "none",
      "FGPM_PUBLIC_VALUE_INVALID", "The corrected prototype currently supports trusted native in-process services only.", {
        schema, rule: "native-trust-pair", instancePath: `${servicePath}/execution`,
      });
    strings(service.execution.requestedPowers, `${servicePath}/execution/requestedPowers`, schema);
    fail(Array.isArray(service.provides) && service.provides.length > 0, "FGPM_PUBLIC_VALUE_INVALID",
      "A runtime service must provide at least one capability.", {
        schema, rule: "minItems:1", instancePath: `${servicePath}/provides`,
      });
    for (const [providedIndex, provided] of service.provides.entries()) {
      const providedPath = `${servicePath}/provides/${providedIndex}`;
      strictKeys(provided, PROVIDED_KEYS, providedPath, schema);
      required(provided, ["capability", "version", "cardinality"], providedPath, schema);
      string(provided.capability, `${providedPath}/capability`, schema, { nonEmpty: true });
      parseVersion(provided.version, "runtime capability version");
      enumeration(provided.cardinality, ["exclusive", "collection"], `${providedPath}/cardinality`, schema);
      if (provided.cardinality === "collection") {
        required(provided, ["member", "binding", "memberDependencies", "metadata"], providedPath, schema);
        string(provided.member, `${providedPath}/member`, schema, { nonEmpty: true });
        string(provided.binding, `${providedPath}/binding`, schema, { nonEmpty: true });
        strings(provided.memberDependencies, `${providedPath}/memberDependencies`, schema);
        object(provided.metadata, `${providedPath}/metadata`, schema);
      }
      if (provided.capability === "runtime.task") {
        fail(provided.cardinality === "collection" && MEMBER_ID.test(provided.member ?? "")
          && provided.version === PUBLIC_CONTRACT.taskCapabilityVersion, "FGPM_PUBLIC_VALUE_INVALID",
        "A corrected runtime-task provider has an invalid collection identity or capability version.", {
          schema, rule: "runtime-task-provider", instancePath: providedPath, provided,
        });
        validateTaskMetadata(provided.metadata, `${providedPath}/metadata`);
        tasks.push({ service: service.id, member: provided.member, metadata: provided.metadata, path: providedPath });
      }
    }
    fail(Array.isArray(service.requires), "FGPM_PUBLIC_VALUE_INVALID", "Service requires must be an array.", {
      schema, rule: "type:array", instancePath: `${servicePath}/requires`,
    });
    for (const [requirementIndex, requirement] of service.requires.entries()) {
      const requirementPath = `${servicePath}/requires/${requirementIndex}`;
      strictKeys(requirement, REQUIREMENT_KEYS, requirementPath, schema);
      required(requirement, ["capability", "range", "cardinality"], requirementPath, schema);
      string(requirement.capability, `${requirementPath}/capability`, schema, { nonEmpty: true });
      string(requirement.range, `${requirementPath}/range`, schema, { nonEmpty: true });
      enumeration(requirement.cardinality, ["exclusive", "collection"], `${requirementPath}/cardinality`, schema);
      if (requirement.optional !== undefined) {
        fail(typeof requirement.optional === "boolean", "FGPM_PUBLIC_VALUE_INVALID",
          "A service optional flag must be boolean.", {
            schema, rule: "type:boolean", instancePath: `${requirementPath}/optional`, value: requirement.optional,
          });
      }
      if (requirement.binding !== undefined) string(requirement.binding, `${requirementPath}/binding`, schema, { nonEmpty: true });
    }
    services.push({ ...service, path: servicePath });
  }
  return { schema, steward: "fgpm.manager-core/2", package: manifest.name,
    coordinate: `${manifest.namespace}/${manifest.name}`, services, tasks, warnings: [] };
}

export function validateServiceActivationDocument(document, service, instancePath = "<activation-contract>") {
  const schema = "fgpm.runtime-service-activation/2";
  strictKeys(document, ACTIVATION_KEYS, "", schema);
  required(document, [...ACTIVATION_KEYS], "", schema);
  fail(document.schema === schema && document.service === service.id, "FGPM_RUNTIME_SERVICE_CONTRACT_INVALID",
    "A service activation contract does not match its declaring service.", {
      schema, rule: "provider-identity", instancePath: "/service", path: instancePath,
      declaredService: service.id, contractService: document.service,
    });
  object(document.capabilities, "/capabilities", schema);
  for (const provided of service.provides) {
    fail(Object.hasOwn(document.capabilities, provided.capability), "FGPM_RUNTIME_SERVICE_CONTRACT_INVALID",
      "A service activation contract omits a declared capability.", {
        schema, rule: "declared-capability", instancePath: `/capabilities/${provided.capability}`,
        path: instancePath, service: service.id,
      });
    if (provided.capability === "runtime.task") {
      const value = document.capabilities[provided.capability];
      strictKeys(value, TASK_VALUE_KEYS, `/capabilities/${provided.capability}`, schema, PUBLIC_CONTRACT.taskVocabulary);
      required(value, [...TASK_VALUE_KEYS], `/capabilities/${provided.capability}`, schema, PUBLIC_CONTRACT.taskVocabulary);
      fail(value.protocol === PUBLIC_CONTRACT.taskProtocol && value.provider === service.id,
        "FGPM_RUNTIME_SERVICE_CONTRACT_INVALID", "A runtime-task activation value has a mismatched protocol or provider.", {
          schema, steward: PUBLIC_CONTRACT.taskVocabulary, rule: "task-provider",
          instancePath: `/capabilities/${provided.capability}/provider`, path: instancePath,
          expectedProvider: service.id, actualProvider: value.provider, protocol: value.protocol,
        });
      string(value.workerModule, `/capabilities/${provided.capability}/workerModule`, schema, {
        nonEmpty: true, steward: PUBLIC_CONTRACT.taskVocabulary,
      });
    }
  }
  return document;
}

function provisionalWarnings(manifest) {
  const warnings = [];
  for (const [serviceIndex, service] of (manifest.runtimeServices ?? []).entries()) {
    for (const [providedIndex, provided] of (service.provides ?? []).entries()) {
      if (provided.capability !== "runtime.task") continue;
      const base = `/runtimeServices/${serviceIndex}/provides/${providedIndex}`;
      for (const field of ["exclusive"]) {
        if (Object.hasOwn(provided, field)) warnings.push({ code: "FGPM_PROVISIONAL_FIELD_DEPRECATED", severity: "warning",
          instancePath: `${base}/${field}`, field, rule: "duplicated-cardinality", steward: PUBLIC_CONTRACT.taskVocabulary });
      }
      for (const field of ["phase", "reentrancy", "required", "failure"]) {
        if (Object.hasOwn(provided.metadata ?? {}, field)) warnings.push({
          code: "FGPM_PROVISIONAL_FIELD_DEPRECATED", severity: "warning", instancePath: `${base}/metadata/${field}`,
          field, rule: field === "required" || field === "failure" ? "duplicated-failure-semantics" : "accepted-but-inert",
          steward: PUBLIC_CONTRACT.taskVocabulary,
        });
      }
    }
  }
  return warnings;
}

async function assertFile(filePath, code, details) {
  let information;
  try {
    information = await stat(filePath);
  } catch (error) {
    invariant(false, code, "A public package contract references a file which does not exist.", {
      ...details, path: filePath, cause: error.message,
    });
  }
  invariant(information.isFile(), code, "A public package contract path must resolve to a regular file.", {
    ...details, path: filePath,
  });
}

export async function validatePackageIsolated(packagePath) {
  const absolute = path.resolve(packagePath);
  let manifestPath = absolute;
  let information = null;
  try {
    information = await stat(absolute);
  } catch {
    // readJson below owns the public unreadable-file diagnostic.
  }
  if (information?.isDirectory()) {
    await validatePackageEntrypointDirectory(absolute);
    manifestPath = path.join(absolute, "fgpm-package.json");
  } else if (["fgpm-package.json", "fpm-package.json"].includes(path.basename(absolute).toLowerCase())) {
    await validatePackageEntrypointDirectory(path.dirname(absolute));
  }
  const manifest = await readJson(manifestPath, "FGPM_PACKAGE_MANIFEST_MALFORMED");
  if (manifest.format === "fgpm.package/1") {
    fail(NAMESPACE_ID.test(manifest.namespace ?? "") && PACKAGE_ID.test(manifest.name ?? ""),
      "FGPM_PACKAGE_ID_INVALID", "Package namespace or immutable local name is invalid.", {
        schema: manifest.format, rule: "namespace-and-name", instancePath: "", path: manifestPath,
        namespace: manifest.namespace, name: manifest.name,
      });
    return {
      schema: "fgpm.package-validation-report/1",
      status: "provisional-v1",
      package: manifest.name ?? null,
      coordinate: manifest.namespace && manifest.name ? `${manifest.namespace}/${manifest.name}` : null,
      manifestPath,
      services: (manifest.runtimeServices ?? []).length,
      tasks: (manifest.runtimeServices ?? []).flatMap((service) => service.provides ?? [])
        .filter((provided) => provided.capability === "runtime.task").length,
      warnings: provisionalWarnings(manifest),
    };
  }
  const result = validatePublicPackageDocument(manifest, manifestPath);
  const directory = path.dirname(manifestPath);
  for (const service of result.services) {
    await assertFile(resolveInside(directory, service.module, "runtime service module"),
      "FGPM_RUNTIME_SERVICE_MODULE_MISSING", { service: service.id, instancePath: `${service.path}/module` });
    const activationPath = resolveInside(directory, service.activationContract, "service activation contract");
    await assertFile(activationPath, "FGPM_RUNTIME_SERVICE_CONTRACT_MISSING", {
      service: service.id, instancePath: `${service.path}/activationContract`,
    });
    const activation = validateServiceActivationDocument(
      await readJson(activationPath, "FGPM_RUNTIME_SERVICE_CONTRACT_MALFORMED"), service, activationPath,
    );
    for (const provided of service.provides.filter((entry) => entry.capability === "runtime.task")) {
      const worker = activation.capabilities[provided.capability].workerModule;
      await assertFile(resolveInside(directory, worker, "runtime task worker module"),
        "FGPM_RUNTIME_TASK_MODULE_MISSING", { service: service.id, task: provided.member, workerModule: worker });
    }
  }
  return {
    schema: "fgpm.package-validation-report/1",
    status: "valid",
    contract: PUBLIC_CONTRACT.packageFormat,
    steward: result.steward,
    package: result.package,
    manifestPath,
    services: result.services.length,
    tasks: result.tasks.length,
    warnings: [],
  };
}

export function validatePublicProfileDocument(profile, profilePath = "<profile>") {
  const schema = PUBLIC_CONTRACT.profileSchema;
  strictKeys(profile, PROFILE_KEYS, "", schema);
  required(profile, [...PROFILE_KEYS], "", schema);
  fail(profile.schema === schema, "FGPM_PROFILE_SCHEMA_UNSUPPORTED", "Unsupported public profile schema.", {
    schema, rule: "const", instancePath: "/schema", value: profile.schema, path: profilePath,
  });
  string(profile.name, "/name", schema, { pattern: /^[a-z0-9][a-z0-9-]*$/ });
  strings(profile.packageRoots, "/packageRoots", schema);
  fail(profile.packageRoots.length > 0, "FGPM_PUBLIC_VALUE_INVALID", "A public profile requires a package root.", {
    schema, rule: "minItems:1", instancePath: "/packageRoots",
  });
  strictKeys(profile.distribution, DISTRIBUTION_KEYS, "/distribution", schema);
  required(profile.distribution, [...DISTRIBUTION_KEYS], "/distribution", schema);
  strings(profile.distribution.roots, "/distribution/roots", schema);
  string(profile.distribution.entryPoint, "/distribution/entryPoint", schema, { nonEmpty: true });
  string(profile.distribution.activation, "/distribution/activation", schema, { nonEmpty: true });
  strictKeys(profile.distribution.artifact, ARTIFACT_KEYS, "/distribution/artifact", schema);
  required(profile.distribution.artifact, ["type", "builder"], "/distribution/artifact", schema);
  string(profile.distribution.artifact.type, "/distribution/artifact/type", schema, { nonEmpty: true });
  string(profile.distribution.artifact.builder, "/distribution/artifact/builder", schema, { nonEmpty: true });
  object(profile.target, "/target", schema);
  strictKeys(profile.policy, POLICY_KEYS, "/policy", schema);
  required(profile.policy, [...POLICY_KEYS], "/policy", schema);
  for (const field of ["providers", "handlerSelections", "adapterSelections"]) object(profile.policy[field], `/policy/${field}`, schema);
  object(profile.policy.collectionPolicy, "/policy/collectionPolicy", schema);
  for (const [capability, policy] of Object.entries(profile.policy.collectionPolicy)) {
    const policyPath = `/policy/collectionPolicy/${capability}`;
    strictKeys(policy, COLLECTION_POLICY_KEYS, policyPath, schema);
    required(policy, [...COLLECTION_POLICY_KEYS], policyPath, schema);
    string(policy.id, `${policyPath}/id`, schema, { nonEmpty: true });
    strings(policy.exclude, `${policyPath}/exclude`, schema);
  }
  strictKeys(profile.policy.validation, VALIDATION_KEYS, "/policy/validation", schema);
  required(profile.policy.validation, [...VALIDATION_KEYS], "/policy/validation", schema);
  string(profile.policy.validation.id, "/policy/validation/id", schema, { nonEmpty: true });
  strings(profile.policy.validation.requiredValidators, "/policy/validation/requiredValidators", schema);
  fail(Array.isArray(profile.policy.validation.waivers), "FGPM_PUBLIC_VALUE_INVALID", "Validation waivers must be an array.", {
    schema, rule: "type:array", instancePath: "/policy/validation/waivers",
  });
  strictKeys(profile.policy.environmentKey, ENVIRONMENT_KEY_KEYS, "/policy/environmentKey", schema);
  required(profile.policy.environmentKey, ["widen"], "/policy/environmentKey", schema);
  strings(profile.policy.environmentKey.widen, "/policy/environmentKey/widen", schema);
  strictKeys(profile.user, USER_KEYS, "/user", schema);
  required(profile.user, ["roots", "replacements"], "/user", schema);
  strings(profile.user.roots, "/user/roots", schema);
  object(profile.user.replacements, "/user/replacements", schema);
  if (profile.user.activation !== undefined) string(profile.user.activation, "/user/activation", schema, { nonEmpty: true });
  return { schema, steward: "fgpm.manager-core/2", profile: profile.name, warnings: [] };
}

export async function validateProfileDocument(profilePath) {
  const absolute = path.resolve(profilePath);
  const profile = await readJson(absolute, "FGPM_PROFILE_MALFORMED");
  if (profile.schema === PUBLIC_CONTRACT.profileSchema) return validatePublicProfileDocument(profile, absolute);
  invariant(["fgpm.profile/1", "fgpm.profile/2"].includes(profile.schema), "FGPM_PROFILE_SCHEMA_UNSUPPORTED",
    "Unsupported or missing profile schema.", { path: absolute, schema: profile.schema });
  const warnings = [];
  if (profile.policy?.permissions !== undefined) warnings.push({
    code: "FGPM_PROVISIONAL_FIELD_DEPRECATED", severity: "warning", instancePath: "/policy/permissions",
    field: "permissions", rule: "accepted-but-inert", steward: "fgpm.manager-core/2",
  });
  return { schema: profile.schema, steward: "fgpm.manager-core/1", profile: profile.name ?? null,
    status: "provisional-v1", warnings };
}
