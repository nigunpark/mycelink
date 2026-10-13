import fs from "node:fs/promises";
import path from "node:path";
import * as git from "@changesets/git";
import { gitdir, outputFile, silenceLogsInBlock } from "@changesets/test-utils";
import type { ReleasePlan } from "@changesets/types";
import { writeChangeset } from "@changesets/write";
import { log } from "@clack/prompts";
import { exec } from "tinyexec";
import { stripVTControlCharacters as stripAnsi } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { status } from "../index.ts";

function replaceHumanIds(releaseObj: ReleasePlan | undefined) {
  if (!releaseObj) {
    return;
  }
  let counter = 0;
  const changesetNames = new Map<string, string>();

  return {
    ...releaseObj,
    changesets: releaseObj.changesets.map((changeset) => {
      if (changesetNames.get(changeset.id)) {
        throw new Error("Duplicate changeset id found: " + changeset.id);
      }
      const replacedId = `~changeset-${++counter}~`;
      changesetNames.set(changeset.id, replacedId);
      return {
        ...changeset,
        id: replacedId,
      };
    }),
    releases: releaseObj.releases.map((release) => ({
      ...release,
      changesets: release.changesets.map((id) => changesetNames.get(id) || id),
    })),
  };
}

describe("status", { tags: ["slow"] }, () => {
  silenceLogsInBlock();

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("should get the status for a simple changeset and return the release object", async () => {
    const cwd = await gitdir({
      "package.json": JSON.stringify({
        private: true,
        name: "root-pkg",
        workspaces: ["packages/*"],
      }),
      "package-lock.json": "",
      "packages/pkg-a/package.json": JSON.stringify({
        name: "pkg-a",
        version: "1.0.0",
      }),
      ".changeset/config.json": JSON.stringify({}),
    });

    await exec("git", ["checkout", "-b", "new-branch"], {
      nodeOptions: { cwd },
    });

    await outputFile(
      path.join(cwd, "packages/pkg-a/a.js"),
      'export default "updated a"',
    );
    await writeChangeset(
      {
        summary: "This is a summary",
        releases: [{ name: "pkg-a", type: "minor" }],
      },
      cwd,
    );
    await git.add(".", cwd);
    await git.commit("updated a", cwd);

    const releaseObj = await status({ cwd, since: "main" });
    expect(replaceHumanIds(releaseObj)).toMatchInlineSnapshot(`
      {
        "changesets": [
          {
            "id": "~changeset-1~",
            "releases": [
              {
                "name": "pkg-a",
                "type": "minor",
              },
            ],
            "summary": "This is a summary",
          },
        ],
        "preState": undefined,
        "releases": [
          {
            "changesets": [
              "~changeset-1~",
            ],
            "name": "pkg-a",
            "newVersion": "1.1.0",
            "oldVersion": "1.0.0",
            "type": "minor",
          },
        ],
      }
    `);
  });

  it("should get the status comparing to the base branch with undefined since", async () => {
    const cwd = await gitdir({
      "package.json": JSON.stringify({
        private: true,
        name: "root-pkg",
        workspaces: ["packages/*"],
      }),
      "package-lock.json": "",
      "packages/pkg-a/package.json": JSON.stringify({
        name: "pkg-a",
        version: "1.0.0",
      }),
      ".changeset/config.json": JSON.stringify({
        baseBranch: "main",
      }),
    });

    await exec("git", ["checkout", "-b", "new-branch"], {
      nodeOptions: { cwd },
    });

    await outputFile(
      path.join(cwd, "packages/pkg-a/a.js"),
      'export default "updated a"',
    );
    await writeChangeset(
      {
        summary: "This is a summary",
        releases: [{ name: "pkg-a", type: "minor" }],
      },
      cwd,
    );
    await git.add(".", cwd);
    await git.commit("updated a", cwd);

    const releaseObj = await status({ cwd });
    expect(replaceHumanIds(releaseObj)).toMatchInlineSnapshot(`
      {
        "changesets": [
          {
            "id": "~changeset-1~",
            "releases": [
              {
                "name": "pkg-a",
                "type": "minor",
              },
            ],
            "summary": "This is a summary",
          },
        ],
        "preState": undefined,
        "releases": [
          {
            "changesets": [
              "~changeset-1~",
            ],
            "name": "pkg-a",
            "newVersion": "1.1.0",
            "oldVersion": "1.0.0",
            "type": "minor",
          },
        ],
      }
    `);
  });

  it("should exit early with a non-zero error code when there are changed packages but no changesets", async () => {
    const cwd = await gitdir({
      "package.json": JSON.stringify({
        private: true,
        name: "root-pkg",
        workspaces: ["packages/*"],
      }),
      "package-lock.json": "",
      "packages/pkg-a/package.json": JSON.stringify({
        name: "pkg-a",
        version: "1.0.0",
      }),
      ".changeset/config.json": JSON.stringify({}),
    });

    await exec("git", ["checkout", "-b", "new-branch"], {
      nodeOptions: { cwd },
    });

    await outputFile(
      path.join(cwd, "packages/pkg-a/a.js"),
      'export default "updated a"',
    );

    await git.add(".", cwd);
    await git.commit("updated a", cwd);

    const promise = status({ cwd, since: "main" });
    await expect(promise).rejects.toThrow();
  });

  it("should not exit early with a non-zero error code when there are no changed packages", async () => {
    const cwd = await gitdir({
      "package.json": JSON.stringify({
        private: true,
        name: "root-pkg",
        workspaces: ["packages/*"],
      }),
      "package-lock.json": "",
      "packages/pkg-a/package.json": JSON.stringify({
        name: "pkg-a",
        version: "1.0.0",
      }),
      ".changeset/config.json": JSON.stringify({}),
    });

    vi.spyOn(process, "exit").mockImplementation((() => {}) as never);

    await exec("git", ["checkout", "-b", "new-branch"], {
      nodeOptions: { cwd },
    });

    const releaseObj = await status({ cwd, since: "main" });

    expect(process.exit).not.toHaveBeenCalled();
    expect(releaseObj).toEqual({
      changesets: [],
      releases: [],
      preState: undefined,
    });
  });

  it("should not exit early with a non-zero code when there are changed packages and also a changeset", async () => {
    const cwd = await gitdir({
      "package.json": JSON.stringify({
        private: true,
        name: "root-pkg",
        workspaces: ["packages/*"],
      }),
      "package-lock.json": "",
      "packages/pkg-a/package.json": JSON.stringify({
        name: "pkg-a",
        version: "1.0.0",
      }),
      ".changeset/config.json": JSON.stringify({}),
    });

    vi.spyOn(process, "exit").mockImplementation((() => {}) as never);

    await exec("git", ["checkout", "-b", "new-branch"], {
      nodeOptions: { cwd },
    });

    await outputFile(
      path.join(cwd, "packages/pkg-a/a.js"),
      'export default "updated a"',
    );
    await writeChangeset(
      {
        summary: "This is a summary",
        releases: [{ name: "pkg-a", type: "minor" }],
      },
      cwd,
    );

    await git.add(".", cwd);
    await git.commit("updated a", cwd);

    await status({ cwd, since: "main" });

    expect(process.exit).not.toHaveBeenCalled();
  });

  it.todo("should respect the verbose flag", () => false);

  it("should respect the output flag", async () => {
    const cwd = await gitdir({
      "package.json": JSON.stringify({
        private: true,
        name: "root-pkg",
        workspaces: ["packages/*"],
      }),
      "package-lock.json": "",
      "packages/pkg-a/package.json": JSON.stringify({
        name: "pkg-a",
        version: "1.0.0",
      }),
      ".changeset/config.json": JSON.stringify({}),
    });

    await exec("git", ["checkout", "-b", "new-branch"], {
      nodeOptions: { cwd },
    });

    await outputFile(
      path.join(cwd, "packages/pkg-a/a.js"),
      'export default "updated a"',
    );

    await writeChangeset(
      {
        summary: "This is a summary",
        releases: [{ name: "pkg-a", type: "minor" }],
      },
      cwd,
    );

    await git.add(".", cwd);
    await git.commit("updated a", cwd);

    const output = "nonsense.json";

    const probsUndefined = await status({ cwd, since: "main", output });

    const releaseObj = await fs.readFile(path.join(cwd, output), "utf8");

    expect(probsUndefined).toEqual(undefined);
    expect(replaceHumanIds(JSON.parse(releaseObj))).toMatchInlineSnapshot(`
      {
        "changesets": [
          {
            "id": "~changeset-1~",
            "releases": [
              {
                "name": "pkg-a",
                "type": "minor",
              },
            ],
            "summary": "This is a summary",
          },
        ],
        "releases": [
          {
            "changesets": [
              "~changeset-1~",
            ],
            "name": "pkg-a",
            "newVersion": "1.1.0",
            "oldVersion": "1.0.0",
            "type": "minor",
          },
        ],
      }
    `);
  });

  it("should not exit early with a non-zero error code when there are no changed packages matching the pattern", async () => {
    const cwd = await gitdir({
      "package.json": JSON.stringify({
        private: true,
        name: "root-pkg",
        workspaces: ["packages/*"],
      }),
      "package-lock.json": "",
      "packages/pkg-a/package.json": JSON.stringify({
        name: "pkg-a",
        version: "1.0.0",
      }),
      ".changeset/config.json": JSON.stringify({
        changedFilePatterns: ["src/**"],
      }),
    });

    vi.spyOn(process, "exit").mockImplementation((() => {}) as never);

    await exec("git", ["checkout", "-b", "new-branch"], {
      nodeOptions: { cwd },
    });

    await outputFile(
      path.join(cwd, "packages/pkg-a/unrelated.json"),
      JSON.stringify({}),
    );

    await git.add(".", cwd);
    await git.commit("add unrelated thing", cwd);

    const releaseObj = await status({ cwd, since: "main" });

    expect(process.exit).not.toHaveBeenCalled();
    expect(releaseObj).toEqual({
      changesets: [],
      releases: [],
      preState: undefined,
    });
  });

  it("should exit early with a non-zero error code when there are changed packages matching the pattern but no changesets", async () => {
    const cwd = await gitdir({
      "package.json": JSON.stringify({
        private: true,
        name: "root-pkg",
        workspaces: ["packages/*"],
      }),
      "package-lock.json": "",
      "packages/pkg-a/package.json": JSON.stringify({
        name: "pkg-a",
        version: "1.0.0",
      }),
      "packages/pkg-a/src/a.js": 'export default "a"',
      ".changeset/config.json": JSON.stringify({
        changedFilePatterns: ["src/**"],
      }),
    });

    await exec("git", ["checkout", "-b", "new-branch"], {
      nodeOptions: { cwd },
    });

    await outputFile(
      path.join(cwd, "packages/pkg-a/src/a.js"),
      'export default "updated a"',
    );

    await git.add(".", cwd);
    await git.commit("updated a", cwd);

    const promise = status({ cwd, since: "main" });
    await expect(promise).rejects.toThrow();
  });

  it("should not exit early with a non-zero error code when there are changed packages matching the pattern and appropriate changeset", async () => {
    const cwd = await gitdir({
      "package.json": JSON.stringify({
        private: true,
        name: "root-pkg",
        workspaces: ["packages/*"],
      }),
      "package-lock.json": "",
      "packages/pkg-a/package.json": JSON.stringify({
        name: "pkg-a",
        version: "1.0.0",
      }),
      "packages/pkg-a/src/a.js": 'export default "a"',
      ".changeset/config.json": JSON.stringify({
        changedFilePatterns: ["src/**"],
      }),
    });

    await exec("git", ["checkout", "-b", "new-branch"], {
      nodeOptions: { cwd },
    });

    await outputFile(
      path.join(cwd, "packages/pkg-a/a.js"),
      'export default "updated a"',
    );
    await writeChangeset(
      {
        summary: "This is a summary",
        releases: [{ name: "pkg-a", type: "minor" }],
      },
      cwd,
    );
    await git.add(".", cwd);
    await git.commit("updated a", cwd);

    const releaseObj = await status({ cwd, since: "main" });
    expect(replaceHumanIds(releaseObj)).toMatchInlineSnapshot(`
      {
        "changesets": [
          {
            "id": "~changeset-1~",
            "releases": [
              {
                "name": "pkg-a",
                "type": "minor",
              },
            ],
            "summary": "This is a summary",
          },
        ],
        "preState": undefined,
        "releases": [
          {
            "changesets": [
              "~changeset-1~",
            ],
            "name": "pkg-a",
            "newVersion": "1.1.0",
            "oldVersion": "1.0.0",
            "type": "minor",
          },
        ],
      }
    `);
  });

  it("should not exit early with a non-zero error code when only changed packages are ignored", async () => {
    const cwd = await gitdir({
      "package.json": JSON.stringify({
        private: true,
        name: "root-pkg",
        workspaces: ["packages/*"],
      }),
      "package-lock.json": "",
      "packages/pkg-a/package.json": JSON.stringify({
        name: "pkg-a",
        version: "1.0.0",
      }),
      "packages/pkg-a/src/a.js": 'export default "a"',
      "packages/pkg-b/package.json": JSON.stringify({
        name: "pkg-b",
        version: "1.0.0",
      }),
      "packages/pkg-b/src/b.js": 'export default "b"',
      ".changeset/config.json": JSON.stringify({
        ignore: ["pkg-b"],
      }),
    });

    vi.spyOn(process, "exit").mockImplementation((() => {}) as never);

    await exec("git", ["checkout", "-b", "new-branch"], {
      nodeOptions: { cwd },
    });

    await outputFile(
      path.join(cwd, "packages/pkg-b/b.js"),
      'export default "updated b"',
    );
    await git.add(".", cwd);
    await git.commit("updated b", cwd);

    const releaseObj = await status({ cwd, since: "main" });

    expect(process.exit).not.toHaveBeenCalled();
    expect(releaseObj).toEqual({
      changesets: [],
      releases: [],
      preState: undefined,
    });
  });

  it("should not exit early with a non-zero error code when only changed packages are private and versioning for private packages is turned off", async () => {
    const cwd = await gitdir({
      "package.json": JSON.stringify({
        private: true,
        name: "root-pkg",
        workspaces: ["packages/*"],
      }),
      "package-lock.json": "",
      "packages/pkg-a/package.json": JSON.stringify({
        name: "pkg-a",
        version: "1.0.0",
      }),
      "packages/pkg-a/src/a.js": 'export default "a"',
      "packages/pkg-b/package.json": JSON.stringify({
        name: "pkg-b",
        private: true,
        version: "1.0.0",
      }),
      "packages/pkg-b/src/b.js": 'export default "b"',
      ".changeset/config.json": JSON.stringify({
        privatePackages: {
          version: false,
        },
      }),
    });

    vi.spyOn(process, "exit").mockImplementation((() => {}) as never);

    await exec("git", ["checkout", "-b", "new-branch"], {
      nodeOptions: { cwd },
    });

    await outputFile(
      path.join(cwd, "packages/pkg-b/b.js"),
      'export default "updated b"',
    );
    await git.add(".", cwd);
    await git.commit("updated b", cwd);

    const releaseObj = await status({ cwd, since: "main" });

    expect(process.exit).not.toHaveBeenCalled();
    expect(releaseObj).toEqual({
      changesets: [],
      releases: [],
      preState: undefined,
    });
  });

  describe("--explain", () => {
    async function setup() {
      const cwd = await gitdir({
        "package.json": JSON.stringify({
          private: true,
          name: "root-pkg",
          workspaces: ["packages/*"],
        }),
        "package-lock.json": "",
        "packages/pkg-a/package.json": JSON.stringify({
          name: "pkg-a",
          version: "1.0.0",
        }),
        "packages/pkg-b/package.json": JSON.stringify({
          name: "pkg-b",
          version: "1.0.0",
          dependencies: { "pkg-a": "^1.0.0" },
        }),
        ".changeset/config.json": JSON.stringify({}),
      });
      const id = await writeChangeset(
        {
          summary: "summary",
          releases: [{ name: "pkg-a", type: "minor" }],
        },
        cwd,
      );
      await git.add(".", cwd);
      await git.commit("init", cwd);
      return { cwd, id };
    }

    it("prints reason lines under each package", async () => {
      const { cwd, id } = await setup();
      const info = vi.spyOn(log, "info").mockImplementation(() => {});
      await status({ cwd, explain: true, verbose: true } as any);
      const out = stripAnsi(String(info.mock.calls[0]?.[0]));
      expect(out).toContain(
        `    - .changeset/${id}.md\n    - reason: changeset .changeset/${id}.md (minor)`,
      );
    });

    it("writes reasons with --output", async () => {
      const { cwd } = await setup();
      await status({ cwd, explain: true, output: "plan.json" } as any);
      const plan = JSON.parse(
        await fs.readFile(path.join(cwd, "plan.json"), "utf8"),
      );
      expect(plan.releases[0].reasons).toBeDefined();
    });

    async function setupWith(
      config: object,
      extra: Record<string, string> = {},
      releases: { name: string; type: "major" | "minor" | "patch" }[] = [
        { name: "pkg-a", type: "major" },
      ],
    ) {
      const cwd = await gitdir({
        "package.json": JSON.stringify({
          private: true,
          name: "root-pkg",
          workspaces: ["packages/*"],
        }),
        "package-lock.json": "",
        "packages/pkg-a/package.json": JSON.stringify({
          name: "pkg-a",
          version: "1.0.0",
        }),
        "packages/pkg-b/package.json": JSON.stringify({
          name: "pkg-b",
          version: "1.0.0",
          dependencies: { "pkg-a": "^1.0.0" },
        }),
        ".changeset/config.json": JSON.stringify(config),
        ...extra,
      });
      await writeChangeset(
        {
          summary: "summary",
          releases,
        },
        cwd,
      );
      await git.add(".", cwd);
      await git.commit("init", cwd);
      return cwd;
    }

    async function printed(cwd: string, opts: object = {}) {
      const info = vi.spyOn(log, "info").mockImplementation(() => {});
      await status({ cwd, explain: true, ...opts } as any);
      return stripAnsi(String(info.mock.calls[0]?.[0])).split("\n");
    }

    it("prints dependent reason line", async () => {
      const cwd = await setupWith({});
      const lines = await printed(cwd);
      const i = lines.indexOf("  - pkg-b");
      expect(lines[i + 1]).toBe(
        "    - reason: dependent of pkg-a (dependencies ^1.0.0) -> patch",
      );
    });

    it("prints fixed reason line", async () => {
      const cwd = await setupWith(
        { fixed: [["pkg-a", "pkg-b"]] },
        {},
        [{ name: "pkg-a", type: "minor" }],
      );
      const lines = await printed(cwd);
      expect(lines).toContain(
        "    - reason: fixed group [pkg-a, pkg-b] -> minor",
      );
    });

    it("prints linked reason line", async () => {
      const cwd = await setupWith(
        { linked: [["pkg-a", "pkg-b"]] },
        {},
        [
          { name: "pkg-a", type: "minor" },
          { name: "pkg-b", type: "patch" },
        ],
      );
      const lines = await printed(cwd);
      expect(lines).toContain(
        "    - reason: linked group [pkg-a, pkg-b] -> minor",
      );
    });

    it("prints prerelease-exit reason line", async () => {
      const cwd = await setupWith(
        {},
        {
          "packages/pkg-c/package.json": JSON.stringify({
            name: "pkg-c",
            version: "1.0.0-beta.1",
          }),
          ".changeset/pre.json": JSON.stringify({
            mode: "exit",
            tag: "beta",
            initialVersions: { "pkg-a": "1.0.0", "pkg-b": "1.0.0" },
            changesets: [],
          }),
        },
      );
      const lines = await printed(cwd);
      expect(lines).toContain("    - reason: exiting prerelease mode -> patch");
    });

    it("combines --explain with --since", async () => {
      const cwd = await setupWith({});
      await exec("git", ["branch", "-M", "main"], { nodeOptions: { cwd } });
      await exec("git", ["checkout", "-b", "feature"], {
        nodeOptions: { cwd },
      });
      const id = await writeChangeset(
        { summary: "s2", releases: [{ name: "pkg-a", type: "major" }] },
        cwd,
      );
      await outputFile(path.join(cwd, "packages/pkg-a/a.js"), "export {}");
      await git.add(".", cwd);
      await git.commit("change", cwd);
      const lines = await printed(cwd, { since: "main" });
      expect(lines).toContain("  - pkg-a");
      expect(lines).toContain(
        `    - reason: changeset .changeset/${id}.md (major)`,
      );
      expect(lines).toContain(
        "    - reason: dependent of pkg-a (dependencies ^1.0.0) -> patch",
      );
    });

    it("writes exact reasons array with --output", async () => {
      const cwd = await setupWith({});
      await status({ cwd, explain: true, output: "plan.json" } as any);
      const plan = JSON.parse(
        await fs.readFile(path.join(cwd, "plan.json"), "utf8"),
      );
      const id = plan.changesets[0].id;
      const a = plan.releases.find((r: any) => r.name === "pkg-a");
      const b = plan.releases.find((r: any) => r.name === "pkg-b");
      expect(a.reasons).toEqual([
        { type: "changeset", changeset: id, bumpType: "major" },
      ]);
      expect(b.reasons).toEqual([
        {
          type: "dependent",
          dependency: "pkg-a",
          dependencyType: "dependencies",
          versionRange: "^1.0.0",
          bumpType: "patch",
        },
      ]);
    });

    it("does not print reasons without --explain", async () => {
      const { cwd } = await setup();
      const info = vi.spyOn(log, "info").mockImplementation(() => {});
      await status({ cwd });
      expect(String(info.mock.calls[0]?.[0])).not.toContain("reason:");
    });
  });
});
