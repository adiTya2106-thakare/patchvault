import * as fs from 'node:fs';
import * as path from 'node:path';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { resolveInside } from '../../security/pathValidator';

const pexec = promisify(exec);

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, unknown>;
      required: string[];
    };
  };
}

export interface ProposedEdit {
  path: string;
  newContent: string;
  explanation?: string;
  status: 'pending' | 'approved' | 'rejected';
}

export class EditorTools {
  constructor(private readonly workspaceRoot: string) {}

  getToolDefinitions(): ToolDefinition[] {
    return [
      {
        type: 'function',
        function: {
          name: 'read_file',
          description: 'Read the contents of a file within the workspace. Optionally specify line ranges (1-indexed).',
          parameters: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'Relative path of the file from workspace root.' },
              start_line: { type: 'number', description: 'Optional starting line number (1-indexed).' },
              end_line: { type: 'number', description: 'Optional ending line number (inclusive).' }
            },
            required: ['path']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'search_workspace',
          description: 'Search workspace files for matching keywords or regex pattern.',
          parameters: {
            type: 'object',
            properties: {
              query: { type: 'string', description: 'Keyword or regex to search for.' },
              is_regex: { type: 'boolean', description: 'Whether the query is a regular expression.' },
              file_pattern: { type: 'string', description: 'Optional file extension or substring filter (e.g. .py or cli).' }
            },
            required: ['query']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'propose_file_edit',
          description: 'Propose a full replacement or new content for a file. Changes are presented to the developer for hunk-by-hunk review before writing to disk.',
          parameters: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'Relative path of the target file.' },
              content: { type: 'string', description: 'The new full content for the file.' },
              explanation: { type: 'string', description: 'Brief explanation of what was changed and why.' }
            },
            required: ['path', 'content']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'run_terminal_command',
          description: 'Run a terminal command in the workspace root (e.g. pytest tests/test_cli.py -q) and return output.',
          parameters: {
            type: 'object',
            properties: {
              command: { type: 'string', description: 'The command to execute in the workspace root.' }
            },
            required: ['command']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'list_files',
          description: 'List files in the workspace or a specified subfolder.',
          parameters: {
            type: 'object',
            properties: {
              folder: { type: 'string', description: 'Optional subfolder to list files in.' }
            },
            required: []
          }
        }
      }
    ];
  }

  async executeTool(name: string, args: Record<string, unknown>): Promise<{ success: boolean; result?: string; error?: string }> {
    try {
      switch (name) {
        case 'read_file': {
          const relPath = String(args.path);
          const abs = resolveInside(this.workspaceRoot, relPath);
          if (!fs.existsSync(abs)) {
            return { success: false, error: `File not found: ${relPath}` };
          }
          const content = fs.readFileSync(abs, 'utf8');
          const lines = content.split('\n');
          const start = typeof args.start_line === 'number' ? Math.max(1, args.start_line) : 1;
          const end = typeof args.end_line === 'number' ? Math.min(lines.length, args.end_line) : lines.length;

          const slice = lines.slice(start - 1, end).map((l, i) => `${start + i}: ${l}`).join('\n');
          return { success: true, result: slice };
        }

        case 'search_workspace': {
          const query = String(args.query || '');
          const isRegex = Boolean(args.is_regex);
          const filter = args.file_pattern ? String(args.file_pattern).toLowerCase() : '';
          const results: string[] = [];

          const searchDir = (dir: string) => {
            if (results.length > 50) return;
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            for (const ent of entries) {
              if (results.length > 50) return;
              if (ent.name.startsWith('.') || ent.name === 'node_modules' || ent.name === '__pycache__') continue;
              const full = path.join(dir, ent.name);
              if (ent.isDirectory()) {
                searchDir(full);
              } else if (ent.isFile()) {
                const rel = path.relative(this.workspaceRoot, full).replace(/\\/g, '/');
                if (filter && !rel.toLowerCase().includes(filter)) continue;

                try {
                  const txt = fs.readFileSync(full, 'utf8');
                  const lines = txt.split('\n');
                  for (let i = 0; i < lines.length; i++) {
                    const line = lines[i];
                    let matched = false;
                    if (isRegex) {
                      matched = new RegExp(query, 'i').test(line);
                    } else {
                      matched = line.toLowerCase().includes(query.toLowerCase());
                    }
                    if (matched) {
                      results.push(`${rel}:${i + 1}: ${line.trim().slice(0, 120)}`);
                      if (results.length > 50) break;
                    }
                  }
                } catch { /* skip binary/unreadable */ }
              }
            }
          };

          searchDir(this.workspaceRoot);
          return { success: true, result: results.length > 0 ? results.join('\n') : `No matches found for query: "${query}"` };
        }

        case 'propose_file_edit': {
          const relPath = String(args.path);
          const content = String(args.content);
          // Validates path safety
          resolveInside(this.workspaceRoot, relPath);
          return {
            success: true,
            result: `Proposed edit for ${relPath} (${content.length} chars) submitted for hunk-level review.`
          };
        }

        case 'run_terminal_command': {
          const cmd = String(args.command);
          try {
            const { stdout, stderr } = await pexec(cmd, { cwd: this.workspaceRoot, timeout: 30000 });
            return { success: true, result: stdout || stderr || 'Command finished with no output.' };
          } catch (err: unknown) {
            const e = err as { stdout?: string; stderr?: string; message: string };
            return {
              success: false,
              result: (e.stdout ? e.stdout + '\n' : '') + (e.stderr || e.message),
              error: `Command failed: ${e.message}`
            };
          }
        }

        case 'list_files': {
          const sub = args.folder ? String(args.folder) : '';
          const targetDir = sub ? resolveInside(this.workspaceRoot, sub) : this.workspaceRoot;
          if (!fs.existsSync(targetDir)) {
            return { success: false, error: `Directory not found: ${sub}` };
          }
          const list = fs.readdirSync(targetDir);
          return { success: true, result: list.join('\n') };
        }

        default:
          return { success: false, error: `Unknown tool: ${name}` };
      }
    } catch (e) {
      return { success: false, error: (e as Error).message };
    }
  }
}
