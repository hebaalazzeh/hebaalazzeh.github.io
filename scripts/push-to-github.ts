#!/usr/bin/env tsx
/**
 * Pushes all source files from the local workspace to the main branch
 * of the GitHub repo, then creates a .github/workflows/deploy.yml
 * so the site builds automatically on every push.
 */

import { ReplitConnectors } from "@replit/connectors-sdk";
import { readFileSync, readdirSync, statSync } from "fs";
import { execSync } from "child_process";
import path from "path";

const OWNER = "hebaalazzeh";
const REPO = "hebaalazzeh.github.io";

const connectors = new ReplitConnectors();

async function ghFetch(
  endpoint: string,
  options: RequestInit = {}
): Promise<Response> {
  return connectors.proxy("github", endpoint, options);
}

async function ghJSON<T = unknown>(
  endpoint: string,
  options: RequestInit = {}
): Promise<T> {
  const res = await ghFetch(endpoint, options);
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`GitHub API error ${res.status} for ${endpoint}: ${text}`);
  }
  return JSON.parse(text) as T;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Create a single blob and return its SHA, with retry on rate limit */
async function createBlob(content: Buffer, retries = 5): Promise<string> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const data = await ghJSON<{ sha: string }>(
        `/repos/${OWNER}/${REPO}/git/blobs`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            content: content.toString("base64"),
            encoding: "base64",
          }),
        }
      );
      return data.sha;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("429") && attempt < retries) {
        const wait = 2000 * (attempt + 1);
        console.log(`    rate limit, waiting ${wait}ms...`);
        await sleep(wait);
      } else {
        throw err;
      }
    }
  }
  throw new Error("Max retries exceeded");
}

async function main() {
  // 1. Get the current main branch SHA
  const refData = await ghJSON<{ object: { sha: string } }>(
    `/repos/${OWNER}/${REPO}/git/ref/heads/main`
  );
  const parentCommitSha = refData.object.sha;
  console.log(`Current main SHA: ${parentCommitSha}`);

  // 2. Get the parent commit's tree SHA
  const commitData = await ghJSON<{ tree: { sha: string } }>(
    `/repos/${OWNER}/${REPO}/git/commits/${parentCommitSha}`
  );
  const _baseTreeSha = commitData.tree.sha;
  console.log(`Base tree SHA: ${_baseTreeSha}`);

  // 3. Collect all tracked files + the new workflow file
  const trackedRaw = execSync("git ls-files", {
    encoding: "utf-8",
    cwd: process.cwd(),
  });
  const trackedFiles = trackedRaw.trim().split("\n").filter(Boolean);

  // Add the workflow file if not already tracked
  const workflowPath = ".github/workflows/deploy.yml";
  if (!trackedFiles.includes(workflowPath)) {
    trackedFiles.push(workflowPath);
  }

  console.log(`Files to push: ${trackedFiles.length}`);

  // 4. Create blobs for all files (batched in groups of 5 to avoid rate limits)
  const treeEntries: Array<{
    path: string;
    mode: string;
    type: string;
    sha: string;
  }> = [];

  const BATCH = 3;
  for (let i = 0; i < trackedFiles.length; i += BATCH) {
    const batch = trackedFiles.slice(i, i + BATCH);
    if (i > 0) await sleep(400); // throttle between batches
    const results = await Promise.all(
      batch.map(async (filePath) => {
        const abs = path.resolve(process.cwd(), filePath);
        try {
          const content = readFileSync(abs);
          const sha = await createBlob(content);
          console.log(`  blob ${filePath}: ${sha}`);
          return { path: filePath, mode: "100644", type: "blob", sha };
        } catch (err) {
          console.error(`  ERROR reading ${filePath}:`, err);
          throw err;
        }
      })
    );
    treeEntries.push(...results);
  }

  // 5. Create a new tree (not base_tree — full replacement of main)
  console.log("Creating new tree...");
  const newTree = await ghJSON<{ sha: string }>(
    `/repos/${OWNER}/${REPO}/git/trees`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tree: treeEntries }),
    }
  );
  console.log(`New tree SHA: ${newTree.sha}`);

  // 6. Create a commit pointing to the new tree
  const newCommit = await ghJSON<{ sha: string }>(
    `/repos/${OWNER}/${REPO}/git/commits`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "Add source code and GitHub Actions workflow for automated deployment",
        tree: newTree.sha,
        parents: [parentCommitSha],
      }),
    }
  );
  console.log(`New commit SHA: ${newCommit.sha}`);

  // 7. Update the main branch ref
  const updateRef = await ghJSON(
    `/repos/${OWNER}/${REPO}/git/refs/heads/main`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sha: newCommit.sha, force: false }),
    }
  );
  console.log("Main branch updated!", JSON.stringify(updateRef, null, 2));
  console.log("Done! GitHub Actions will now build and deploy automatically.");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
