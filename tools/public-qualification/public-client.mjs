// SPDX-License-Identifier: Apache-2.0
// External consumer: Node built-ins and the distribution's public executable only.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { writeFile, readFile, readdir, lstat } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
export const json = async (file) => JSON.parse(await readFile(file, "utf8"));
export function requireFact(condition, message) { if (!condition) throw new Error(message); }
export async function inventory(root) {
  const records = [];
  async function visit(directory) {
    for (const name of (await readdir(directory)).sort()) {
      const full = path.join(directory, name);
      const facts = await lstat(full);
      requireFact(!facts.isSymbolicLink(), `Non-regular inventory entry: ${full}`);
      if (facts.isDirectory()) await visit(full);
      else {
        requireFact(facts.isFile(), `Non-file inventory entry: ${full}`);
        const bytes = await readFile(full);
        records.push({ path: path.relative(root, full).replaceAll(path.sep, "/"), bytes: bytes.length, sha256: sha256(bytes) });
      }
    }
  }
  await visit(root);
  return records;
}
export class PublicClient {
  constructor(distribution, managerRoot, cwd) {
    this.requests = []; this.stdout = ""; this.stderr = ""; this.pending = new Map(); this.counter = 0;
    this.child = spawn(path.join(distribution, "bin", "node.exe"),
      [path.join(distribution, "bin", "fgpm.mjs"), "control", "--manager-root", managerRoot],
      { cwd, env: { ...process.env, PATH: "", Path: "" }, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    this.failure = null;
    this.child.stdout.setEncoding("utf8"); this.child.stderr.setEncoding("utf8");
    const fail = (error) => {
      this.failure ??= error;
      for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
      this.pending.clear();
    };
    this.child.on("error", fail);
    this.exit = new Promise((resolve) => this.child.on("close", (code, signal) => {
      fail(new Error(`Public manager exited: ${code}, ${signal}`)); resolve({ code, signal });
    }));
    this.child.stdin.on("error", fail);
    for (const field of ["stdout", "stderr"]) this.child[field].on("data", (chunk) => {
      this[field] += chunk.toString("utf8");
      if (Buffer.byteLength(this[field]) > 16 * 1024 * 1024) {
        fail(new Error(`Public ${field} exceeded 16 MiB evidence budget`)); this.child.kill();
      }
    });
    createInterface({ input: this.child.stdout, crlfDelay: Infinity }).on("line", (line) => {
      try {
        const record = JSON.parse(line);
        if (record.schema !== "fgpm.control-response/1") return;
        const pending = this.pending.get(record.requestId);
        if (!pending) return;
        clearTimeout(pending.timer); this.pending.delete(record.requestId); pending.resolve(record);
      } catch (error) { fail(new Error(`Non-JSON public manager output: ${error.message}`)); this.child.kill(); }
    });
    this.deadline = setTimeout(() => { fail(new Error("Public manager run exceeded 120 seconds")); this.child.kill(); }, 120000);
  }
  async request(operation, parameters = {}, requestId = `qualification:${++this.counter}`) {
    if (this.failure) throw this.failure;
    requireFact(!this.pending.has(requestId), "Duplicate concurrent request identity");
    const request = { schema: "fgpm.control-request/1", requestId, operation, parameters };
    const response = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId); reject(new Error(`Public request deadline: ${operation}`)); this.child.kill();
      }, 30000);
      this.pending.set(requestId, { resolve, reject, timer });
    });
    this.requests.push(request); this.child.stdin.write(`${JSON.stringify(request)}\n`);
    return response;
  }
  async ok(operation, parameters = {}) {
    const response = await this.request(operation, parameters);
    requireFact(response.ok, `${operation}: ${JSON.stringify(response.diagnostic)}`);
    return response.result;
  }
  async finish(evidence) {
    this.child.stdin.end();
    const stop = setTimeout(() => this.child.kill(), 5000);
    const exit = await this.exit;
    clearTimeout(stop); clearTimeout(this.deadline);
    await writeFile(path.join(evidence, "requests.jsonl"), this.requests.map((value) => JSON.stringify(value)).join("\n") + "\n");
    await writeFile(path.join(evidence, "manager.stdout.jsonl"), this.stdout);
    await writeFile(path.join(evidence, "manager.stderr.txt"), this.stderr);
    await writeFile(path.join(evidence, "process-exit.json"), JSON.stringify(exit, null, 2) + "\n");
    return exit;
  }
}

export function humanReport(report) {
  // The complete structured facts are retained in human presentation, not a lossy summary.
  return `FGPM public qualification: ${report.status}\n${JSON.stringify(report, null, 2)}\n`;
}
