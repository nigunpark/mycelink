/** `mycelink memory ...` — the Brain adapter's command surface. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ParsedArgs } from '../cli/args.js';
import { flagBool, flagString } from '../cli/args.js';
import type { CliIo } from '../cli/cli.js';
import { loadConfig } from '../workspace/workspace.js';
import {
  adoptCodewiki,
  brainRoot,
  consolidate,
  initBrain,
  listPages,
  markStale,
  selectMemories,
  supersede,
  writePage,
  type MemoryFrontmatter,
  type MemoryStatus,
  type MemoryType,
} from './brain.js';

function emit(io: CliIo, args: ParsedArgs, value: unknown, human: () => string): void {
  if (flagBool(args, 'json')) io.out(JSON.stringify(value, null, 2));
  else io.out(human());
}

export function memoryCommand(args: ParsedArgs, io: CliIo, controlRoot: string): number {
  const sub = args.positional[1];
  const config = loadConfig(controlRoot);
  const root = brainRoot(controlRoot, config.brain_dir);

  switch (sub) {
    case 'init': {
      initBrain(root);
      const adopted = adoptCodewiki(controlRoot, root);
      emit(io, args, { root, adopted }, () =>
        `Brain initialised at ${root}` +
        (adopted.adopted ? `; adopted existing ${adopted.path} as a code-memory sub-vault.` : '.'),
      );
      return 0;
    }

    case 'capture': {
      const type = flagString(args, 'type', 'procedure') as MemoryType;
      const id = flagString(args, 'id');
      const title = flagString(args, 'title', id);
      const status = flagString(args, 'status', 'instructed_not_verified') as MemoryStatus;
      const bodyFile = args.flags['body-file'];
      const body =
        typeof bodyFile === 'string'
          ? readFileSync(resolve(bodyFile), 'utf8')
          : flagString(args, 'body', '');
      const now = new Date().toISOString();

      const frontmatter: MemoryFrontmatter = {
        id,
        title,
        type,
        status,
        created_at: now,
        updated_at: now,
        source_refs: parseSourceRefs(args),
        ...(typeof args.flags['triggers'] === 'string'
          ? { triggers: String(args.flags['triggers']).split(',').map((t) => t.trim()) }
          : {}),
        ...(typeof args.flags['tags'] === 'string'
          ? { tags: String(args.flags['tags']).split(',').map((t) => t.trim()) }
          : {}),
        verified_commit: null,
        verification: {
          structural: 'not_run',
          references: 'not_run',
          build: 'not_run',
          tests: 'not_run',
          runtime: 'not_run',
        },
      };

      initBrain(root);
      const result = writePage(root, frontmatter, body);
      if (result.problems.length > 0) {
        io.err(result.problems.map((p) => `${p.code}: ${p.detail}`).join('\n'));
        return 1;
      }
      emit(io, args, { path: result.path, id }, () => `Captured ${id} -> ${result.path}`);
      return 0;
    }

    case 'select':
    case 'context-pack': {
      const query = flagString(args, 'query');
      const limit = Number(args.flags['limit'] ?? 10);
      const selections = selectMemories(root, {
        query,
        limit,
        ...(typeof args.flags['node'] === 'string' ? { nodeId: String(args.flags['node']) } : {}),
        ...(typeof args.flags['paths'] === 'string'
          ? { paths: String(args.flags['paths']).split(',') }
          : {}),
        includeExcluded: flagBool(args, 'include-archived'),
      });

      if (sub === 'context-pack') {
        const maxBytes = Number(args.flags['max-bytes'] ?? 2048);
        const kept: typeof selections = [];
        for (const selection of selections) {
          const probe = [...kept, selection];
          if (Buffer.byteLength(JSON.stringify(probe), 'utf8') > maxBytes) break;
          kept.push(selection);
        }
        emit(io, args, kept, () =>
          kept.map((s) => `${s.status.padEnd(24)} ${s.id} ${s.path}${s.warning ? ` [${s.warning}]` : ''}`).join('\n'),
        );
        return 0;
      }

      emit(io, args, selections, () =>
        selections
          .map((s) => `${String(s.score).padStart(5)} ${s.status.padEnd(24)} ${s.id} ${s.path}`)
          .join('\n') || '(no matching memory)',
      );
      return 0;
    }

    case 'stale': {
      const changed = typeof args.flags['changed'] === 'string' ? String(args.flags['changed']).split(',') : [];
      const affected = markStale(root, changed);
      emit(io, args, { affected }, () => `marked stale: ${affected.join(', ') || '(none)'}`);
      return 0;
    }

    case 'supersede': {
      const oldId = flagString(args, 'old');
      const newId = flagString(args, 'new');
      const ok = supersede(root, oldId, newId);
      emit(io, args, { ok }, () => (ok ? `${oldId} superseded by ${newId}` : `${oldId} not found`));
      return ok ? 0 : 1;
    }

    case 'consolidate': {
      const findings = consolidate(root);
      emit(io, args, { findings }, () =>
        findings.map((f) => `${f.code} ${f.ids.join(',')}: ${f.detail}`).join('\n') || '(nothing to consolidate)',
      );
      return 0;
    }

    case 'lint':
    case 'status': {
      const pages = listPages(root);
      const byStatus: Record<string, number> = {};
      for (const page of pages) {
        byStatus[page.frontmatter.status] = (byStatus[page.frontmatter.status] ?? 0) + 1;
      }
      const findings = consolidate(root);
      emit(io, args, { root, pages: pages.length, by_status: byStatus, findings: findings.length }, () =>
        [
          `brain: ${root}`,
          `pages: ${pages.length}`,
          ...Object.entries(byStatus).map(([k, v]) => `  ${k}: ${v}`),
          `consolidation findings: ${findings.length}`,
        ].join('\n'),
      );
      return 0;
    }

    default:
      io.err('Usage: mycelink memory init|capture|select|context-pack|stale|supersede|consolidate|status');
      return 2;
  }
}

function parseSourceRefs(args: ParsedArgs): MemoryFrontmatter['source_refs'] {
  const raw = args.flags['source'];
  if (typeof raw !== 'string') return [{ kind: 'user_instruction', ref: 'cli' }];
  // Format: kind:ref[#symbol][@sha256], comma-separated.
  return raw.split(',').map((entry) => {
    const [head, sha] = entry.split('@');
    const [kind, ...rest] = (head ?? '').split(':');
    const refPart = rest.join(':');
    const [ref, symbol] = refPart.split('#');
    return {
      kind: kind ?? 'source',
      ref: ref ?? refPart,
      ...(symbol ? { symbol } : {}),
      ...(sha ? { sha256: sha } : {}),
    };
  });
}
