// SPDX-License-Identifier: MPL-2.0

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import path from "node:path";

export class ControlError extends Error {
  constructor(diagnostic) {
    super(diagnostic.message);
    this.name = "ControlError";
    this.code = diagnostic.code;
    this.details = diagnostic.details ?? {};
  }
}

export class ControlClient {
  constructor(managerRoot, options = {}) {
    this.managerRoot = path.resolve(managerRoot);
    this.managerStore = path.resolve(options.managerStore);
    this.snapshotPath = options.snapshotPath ? path.resolve(options.snapshotPath) : null;
    this.onProgress = options.onProgress ?? (() => {});
    this.sequence = 0;
    this.pending = new Map();
    this.stderr = "";
    this.exitError = null;
    const cli = path.join(this.managerRoot, "src", "cli.mjs");
    const args = [cli, "control", "--manager-root", this.managerStore];
    if (this.snapshotPath) args.push("--snapshot", this.snapshotPath);
    this.child = spawn(process.execPath, args, { cwd: this.managerRoot, stdio: ["pipe", "pipe", "pipe"] });
    this.lines = createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    this.lines.on("line", (line) => this.receive(line));
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk) => { this.stderr += chunk; });
    this.closed = new Promise((resolve) => {
      this.child.once("error", (error) => {
        this.exitError = error;
        for (const pending of this.pending.values()) pending.reject(error);
        this.pending.clear();
        resolve({ error });
      });
      this.child.once("exit", (code, signal) => {
        const error = code === 0 ? null : new Error(
          `Manager control process exited with ${code ?? signal}. ${this.stderr.trim()}`);
        this.exitError = error;
        for (const pending of this.pending.values()) pending.reject(error ?? new Error("Control process closed."));
        this.pending.clear();
        resolve({ code, signal, error });
      });
    });
  }

  receive(line) {
    let message;
    try { message = JSON.parse(line); } catch {
      for (const pending of this.pending.values()) pending.reject(new Error(`Non-JSON manager output: ${line}`));
      this.pending.clear();
      return;
    }
    if (message.schema === "fgpm.control-event/1") {
      this.onProgress(message);
      return;
    }
    const pending = this.pending.get(message.requestId);
    if (!pending) return;
    this.pending.delete(message.requestId);
    if (message.ok) pending.resolve(message.result);
    else pending.reject(new ControlError(message.diagnostic));
  }

  request(operation, parameters = {}, requestId = null) {
    if (this.exitError || this.child.exitCode !== null) {
      return Promise.reject(this.exitError ?? new Error("Manager control process is closed."));
    }
    const id = requestId ?? `fgpm-workbench:${process.pid}:${this.sequence += 1}`;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(`${JSON.stringify({
        schema: "fgpm.control-request/1", requestId: id, operation, parameters,
      })}\n`, (error) => {
        if (error) {
          this.pending.delete(id);
          reject(error);
        }
      });
    });
  }

  async stop() {
    if (this.child.exitCode !== null) return this.closed;
    await this.request("control.stop");
    this.child.stdin.end();
    return this.closed;
  }
}
