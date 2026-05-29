import { execFile } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, cpSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { getSettings } from "./db.ts";
import { listHosts } from "./repo.ts";

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const GITOPS_DIR = process.env.GITOPS_DIR ?? join(__dirname, "..", "data", "gitops");
// same location the nginx generator writes to (kept in sync to avoid a circular import)
const CONF_DIR = process.env.NGINX_CONF_DIR ?? join(__dirname, "..", "..", "nginx", "conf.d");

async function git(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", GITOPS_DIR, ...args]);
  return stdout;
}

async function ensureRepo(): Promise<void> {
  if (!existsSync(GITOPS_DIR)) mkdirSync(GITOPS_DIR, { recursive: true });
  if (!existsSync(join(GITOPS_DIR, ".git"))) {
    await git(["init", "-q"]);
    await git(["config", "user.email", "nginux@local"]);
    await git(["config", "user.name", "NginUX"]);
  }
}

/** Write a declarative snapshot to the repo and commit it. Best-effort. */
export async function syncGitOps(message: string): Promise<void> {
  if (!getSettings().gitOpsEnabled) return;
  try {
    await ensureRepo();
    writeFileSync(join(GITOPS_DIR, "hosts.json"), JSON.stringify(listHosts(), null, 2));
    if (existsSync(CONF_DIR)) {
      cpSync(CONF_DIR, join(GITOPS_DIR, "conf.d"), { recursive: true });
    }
    await git(["add", "-A"]);
    // commit only if there's something to commit
    const status = await git(["status", "--porcelain"]);
    if (status.trim()) await git(["commit", "-q", "-m", message]);
  } catch {
    /* GitOps is best-effort; never block an apply */
  }
}

export async function gitLog(): Promise<Array<{ hash: string; date: string; message: string }>> {
  if (!existsSync(join(GITOPS_DIR, ".git"))) return [];
  try {
    const out = await git(["log", "-20", "--pretty=format:%h\t%cI\t%s"]);
    return out.split("\n").filter(Boolean).map((line) => {
      const [hash, date, ...msg] = line.split("\t");
      return { hash, date, message: msg.join("\t") };
    });
  } catch {
    return [];
  }
}

export { GITOPS_DIR };
