// SPDX-License-Identifier: Apache-2.0

export async function runTask() {
  throw Object.assign(new Error("The deliberate required task failed before the commit barrier."), {
    code: "FGPM_FIXTURE_TASK_FAILED",
    details: { fixture: "required-task-failure" },
  });
}
