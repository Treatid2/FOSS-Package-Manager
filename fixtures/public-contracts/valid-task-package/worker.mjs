// SPDX-License-Identifier: Apache-2.0

export function invoke() {
  throw new Error("Static package validation must not execute worker code.");
}
