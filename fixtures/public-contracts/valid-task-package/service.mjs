// SPDX-License-Identifier: Apache-2.0

export async function activate() {
  throw new Error("Static package validation must not execute service code.");
}
