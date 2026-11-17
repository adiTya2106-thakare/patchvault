import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveInside } from '../../security/pathValidator';

export interface RetrievedFile {
  path: string;
  score: number;
  reason: string;
  content: string;
  sizeBytes: number;
}

export interface ExplicitMention {
  type: 'file' | 'symbol';
  target: string;
}

export interface AssembledContext {
  prompt: string;
  cleanedPrompt: string;
  explicitFiles: Array<{ path: string; content: string }>;
  explicitSymbols: Array<{ name: string; query: string }>;
  retrievedFiles: RetrievedFile[];
  totalChars: number;
  budgetChars: number;
  rationale: string[];
}

export interface ContextEngineOptions {
  budgetChars?: number;
  activeFilePath?: string;
  selectedText?: string;
  maxFilesToScan?: number;
}

const STOP_WORDS = new Set([
  'a', 'about', 'above', 'after', 'again', 'against', 'all', 'am', 'an', 'and', 'any', 'are', 'as', 'at',
  'be', 'because', 'been', 'before', 'being', 'below', 'between', 'both', 'but', 'by', 'can', 'did', 'do',
  'does', 'doing', 'down', 'during', 'each', 'few', 'for', 'from', 'further', 'had', 'has', 'have', 'having',
  'he', 'her', 'here', 'hers', 'herself', 'him', 'himself', 'his', 'how', 'i', 'if', 'in', 'into', 'is', 'it',
  'its', 'itself', 'just', 'me', 'more', 'most', 'my', 'myself', 'no', 'nor', 'not', 'now', 'of', 'off',
  'on', 'once', 'only', 'or', 'other', 'our', 'ours', 'ourselves', 'out', 'over', 'own', 'same', 'she',
  'should', 'so', 'some', 'such', 'than', 'that', 'the', 'their', 'theirs', 'them', 'themselves', 'then',
  'there', 'these', 'they', 'this', 'those', 'through', 'to', 'too', 'under', 'until', 'up', 'very', 'was',
  'we', 'were', 'what', 'when', 'where', 'which', 'while', 'who', 'whom', 'why', 'with', 'would', 'you',
  'your', 'yours', 'yourself', 'yourselves'
]);

const IGNORED_DIRS = new Set([
  'node_modules', '.git', '.vscode', '.patchvault', 'dist', 'out', '__pycache__', '.pytest_cache',
  '.venv', 'venv', 'env', '.tox', 'build', 'eggs', '.eggs'
]);

export function extractMentions(rawPrompt: string): {
  mentions: ExplicitMention[];
  cleanedPrompt: string;
} {
  const mentions: ExplicitMention[] = [];
  const fileRegex = /@file:?([a-zA-Z0-9_./\\-]+)/g;
  const symbolRegex = /@symbol:?([a-zA-Z0-9_]+)/g;

  let match: RegExpExecArray | null;
  while ((match = fileRegex.exec(rawPrompt)) !== null) {
    mentions.push({ type: 'file', target: match[1] });
  }
  while ((match = symbolRegex.exec(rawPrompt)) !== null) {
    mentions.push({ type: 'symbol', target: match[1] });
  }

  const cleanedPrompt = rawPrompt
    .replace(fileRegex, '')
    .replace(symbolRegex, '')
    .replace(/\s+/g, ' ')
    .trim();

  return { mentions, cleanedPrompt };
}

export class ContextEngine {
  private readonly defaultBudgetChars = 16384; // ~4000 tokens

  /** Tokenizes query string into informative search terms */
  tokenize(text: string): string[] {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9_./-]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length >= 2 && !STOP_WORDS.has(w));
  }

  /**
   * Scans workspace files recursively, avoiding ignored directories.
   */
  listCandidateFiles(root: string, maxFiles = 300): string[] {
    const results: string[] = [];

    const walk = (dir: string) => {
      if (results.length >= maxFiles) return;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }

      for (const ent of entries) {
        if (results.length >= maxFiles) return;
        const name = ent.name;
        if (name.startsWith('.') && name !== '.github') continue;
        if (IGNORED_DIRS.has(name)) continue;

        const full = path.join(dir, name);
        if (ent.isDirectory()) {
          walk(full);
        } else if (ent.isFile()) {
          const rel = path.relative(root, full).replace(/\\/g, '/');
          const ext = path.extname(name).toLowerCase();
          if (['.py', '.ts', '.js', '.json', '.rst', '.md', '.html', '.css', '.yaml', '.yml', '.toml'].includes(ext)) {
            results.push(rel);
          }
        }
      }
    };

    walk(root);
    return results;
  }

  /**
   * Computes relevance score for a file against terms.
   */
  scoreFile(root: string, relPath: string, terms: string[]): { score: number; matchedKeywords: string[] } {
    let score = 0;
    const matched: string[] = [];
    const lowerPath = relPath.toLowerCase();

    // 1. Path match bonus
    for (const term of terms) {
      if (lowerPath.includes(term)) {
        score += 3.0;
        matched.push(`path:${term}`);
      }
    }

    // 2. Content match
    try {
      const full = resolveInside(root, relPath);
      const stat = fs.statSync(full);
      if (stat.size > 200 * 1024) {
        // Skip files > 200KB for quick scoring
        return { score, matchedKeywords: matched };
      }
      const content = fs.readFileSync(full, 'utf8').toLowerCase();
      for (const term of terms) {
        if (content.includes(term)) {
          // Count occurrences up to a cap
          const occurrences = (content.split(term).length - 1);
          const termScore = Math.min(occurrences * 0.2, 2.0);
          score += termScore;
          if (!matched.includes(`term:${term}`)) {
            matched.push(`term:${term}`);
          }
        }
      }
    } catch {
      // Unreadable
    }

    return { score, matchedKeywords: matched };
  }

  /**
   * Assembles context: explicit @file/@symbol mentions + automatic retrieval within size budget.
   */
  async assembleContext(
    root: string,
    rawPrompt: string,
    opts: ContextEngineOptions = {}
  ): Promise<AssembledContext> {
    const budget = opts.budgetChars ?? this.defaultBudgetChars;
    const { mentions, cleanedPrompt } = extractMentions(rawPrompt);
    const explicitFiles: Array<{ path: string; content: string }> = [];
    const explicitSymbols: Array<{ name: string; query: string }> = [];
    const rationale: string[] = [];

    let currentChars = 0;

    // 1. Handle explicit file mentions
    for (const m of mentions) {
      if (m.type === 'file') {
        try {
          const abs = resolveInside(root, m.target);
          if (fs.existsSync(abs)) {
            const content = fs.readFileSync(abs, 'utf8');
            explicitFiles.push({ path: m.target, content });
            currentChars += content.length;
            rationale.push(`Explicit @file '${m.target}' loaded (${content.length} chars)`);
          }
        } catch {
          rationale.push(`Explicit @file '${m.target}' could not be resolved`);
        }
      } else if (m.type === 'symbol') {
        explicitSymbols.push({ name: m.target, query: m.target });
        rationale.push(`Explicit @symbol '${m.target}' queued for lookup`);
      }
    }

    // 2. Active file inclusion if provided
    if (opts.activeFilePath && !explicitFiles.some(f => f.path === opts.activeFilePath)) {
      try {
        const abs = resolveInside(root, opts.activeFilePath);
        if (fs.existsSync(abs)) {
          const content = fs.readFileSync(abs, 'utf8');
          const snippet = opts.selectedText ? opts.selectedText : content.slice(0, 4000);
          explicitFiles.push({ path: opts.activeFilePath, content: snippet });
          currentChars += snippet.length;
          rationale.push(`Active editor file '${opts.activeFilePath}' prioritized (${snippet.length} chars)`);
        }
      } catch { /* ignore */ }
    }

    // 3. Automatic retrieval for remaining budget
    const terms = this.tokenize(cleanedPrompt);
    const candidateFiles = this.listCandidateFiles(root, opts.maxFilesToScan ?? 300);
    const scoredCandidates: Array<{ path: string; score: number; matchedKeywords: string[] }> = [];

    for (const rel of candidateFiles) {
      // Don't duplicate files already explicitly loaded
      if (explicitFiles.some(f => f.path === rel)) continue;

      const { score, matchedKeywords } = this.scoreFile(root, rel, terms);
      if (score > 0) {
        scoredCandidates.push({ path: rel, score, matchedKeywords });
      }
    }

    // Sort descending by relevance score
    scoredCandidates.sort((a, b) => b.score - a.score);

    const retrievedFiles: RetrievedFile[] = [];

    for (const cand of scoredCandidates) {
      if (currentChars >= budget) break;

      try {
        const abs = resolveInside(root, cand.path);
        const fullContent = fs.readFileSync(abs, 'utf8');
        const remainingBudget = budget - currentChars;

        let content = fullContent;
        let truncated = false;
        if (fullContent.length > remainingBudget) {
          content = fullContent.slice(0, remainingBudget) + '\n... [truncated by context budget]';
          truncated = true;
        }

        const reason = `Score: ${cand.score.toFixed(2)} | Matched: [${cand.matchedKeywords.slice(0, 4).join(', ')}]${truncated ? ' (truncated to fit budget)' : ''}`;
        retrievedFiles.push({
          path: cand.path,
          score: cand.score,
          reason,
          content,
          sizeBytes: content.length,
        });

        currentChars += content.length;
        rationale.push(`Retrieved '${cand.path}': ${reason}`);
      } catch {
        // Skip unreadable
      }
    }

    return {
      prompt: rawPrompt,
      cleanedPrompt,
      explicitFiles,
      explicitSymbols,
      retrievedFiles,
      totalChars: currentChars,
      budgetChars: budget,
      rationale,
    };
  }

  /**
   * Formats assembled context as a system prompt block for TrueForge.
   */
  formatContextForPrompt(ctx: AssembledContext): string {
    const blocks: string[] = [];

    blocks.push(`=== CONTEXT ASSEMBLY REPORT ===`);
    blocks.push(`Context Budget: ${ctx.totalChars} / ${ctx.budgetChars} characters (~${Math.round(ctx.totalChars / 4)} tokens)`);
    if (ctx.rationale.length > 0) {
      blocks.push(`Selection Rationale:`);
      for (const r of ctx.rationale) {
        blocks.push(` - ${r}`);
      }
    }

    if (ctx.explicitFiles.length > 0) {
      blocks.push(`\n=== EXPLICIT / ACTIVE FILES ===`);
      for (const ef of ctx.explicitFiles) {
        blocks.push(`--- File: ${ef.path} ---\n${ef.content}\n`);
      }
    }

    if (ctx.retrievedFiles.length > 0) {
      blocks.push(`\n=== AUTOMATICALLY RETRIEVED FILES ===`);
      for (const rf of ctx.retrievedFiles) {
        blocks.push(`--- File: ${rf.path} (${rf.reason}) ---\n${rf.content}\n`);
      }
    }

    blocks.push(`=== END OF CONTEXT ===\n`);
    return blocks.join('\n');
  }
}
