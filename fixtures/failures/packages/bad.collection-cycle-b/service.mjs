// SPDX-License-Identifier: Apache-2.0

export function createService() {
  return { async activate() { return { protocol: "fgpm.runtime-service-response/1", capabilities: {} }; } };
}
