import { DiffHunk } from '../capsule/types';

export interface DiffResult {
  added: number;
  removed: number;
  text: string;
  hunks: DiffHunk[];
}

export function isBinary(b: Buffer): boolean {
  return b.subarray(0, 8000).includes(0);
}

function splitLines(t: string): string[] {
  if (t === '') { return []; }
  // Normalize CRLF to LF for diffing
  const norm = t.replace(/\r\n/g, '\n');
  const x = norm.split('\n');
  if (x[x.length - 1] === '') { x.pop(); }
  return x;
}

interface RawDiffOp {
  op: ' ' | '+' | '-';
  text: string;
  origLine?: number;
  modLine?: number;
}

export function unifiedDiff(name: string, a: string, b: string): DiffResult {
  const A = splitLines(a);
  const B = splitLines(b);
  const n = A.length, m = B.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = A[i] === B[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const raw: RawDiffOp[] = [];
  let i = 0, j = 0, added = 0, removed = 0;
  while (i < n || j < m) {
    if (i < n && j < m && A[i] === B[j]) {
      raw.push({ op: ' ', text: A[i], origLine: i + 1, modLine: j + 1 });
      i++; j++;
    } else if (j < m && (i >= n || lcs[i][j + 1] >= lcs[i + 1][j])) {
      raw.push({ op: '+', text: B[j], modLine: j + 1 });
      j++; added++;
    } else {
      raw.push({ op: '-', text: A[i], origLine: i + 1 });
      i++; removed++;
    }
  }

  // Find all changed indices in raw
  const changeIndices: number[] = [];
  for (let idx = 0; idx < raw.length; idx++) {
    if (raw[idx].op !== ' ') {
      changeIndices.push(idx);
    }
  }

  const hunks: DiffHunk[] = [];
  if (changeIndices.length > 0) {
    // Cluster change indices within 6 lines of each other (3 context each side)
    const clusters: Array<{ start: number; end: number }> = [];
    let curCluster = { start: changeIndices[0], end: changeIndices[0] };

    for (let k = 1; k < changeIndices.length; k++) {
      const idx = changeIndices[k];
      if (idx - curCluster.end <= 6) {
        curCluster.end = idx;
      } else {
        clusters.push(curCluster);
        curCluster = { start: idx, end: idx };
      }
    }
    clusters.push(curCluster);

    // Expand clusters with up to 3 context lines
    for (let hIdx = 0; hIdx < clusters.length; hIdx++) {
      const cl = clusters[hIdx];
      const startIdx = Math.max(0, cl.start - 3);
      const endIdx = Math.min(raw.length - 1, cl.end + 3);

      let oldStart = 0;
      let oldCount = 0;
      let newStart = 0;
      let newCount = 0;
      const hunkLines: string[] = [];

      for (let rIdx = startIdx; rIdx <= endIdx; rIdx++) {
        const item = raw[rIdx];
        if (item.op === ' ') {
          if (oldStart === 0 && item.origLine) { oldStart = item.origLine; }
          if (newStart === 0 && item.modLine) { newStart = item.modLine; }
          oldCount++;
          newCount++;
          hunkLines.push(' ' + item.text);
        } else if (item.op === '-') {
          if (oldStart === 0 && item.origLine) { oldStart = item.origLine; }
          oldCount++;
          hunkLines.push('-' + item.text);
        } else if (item.op === '+') {
          if (newStart === 0 && item.modLine) { newStart = item.modLine; }
          newCount++;
          hunkLines.push('+' + item.text);
        }
      }

      if (oldStart === 0) { oldStart = 1; }
      if (newStart === 0) { newStart = 1; }

      const header = `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`;
      hunks.push({
        id: `hunk-${hIdx + 1}`,
        oldStart,
        oldCount,
        newStart,
        newCount,
        lines: [header, ...hunkLines],
        review: 'pending',
      });
    }
  }

  const diffTextLines = [`--- a/${name}`, `+++ b/${name}`];
  if (hunks.length > 0) {
    for (const h of hunks) {
      diffTextLines.push(...h.lines);
    }
  } else {
    for (const r of raw) {
      diffTextLines.push(r.op + r.text);
    }
  }

  return { added, removed, text: diffTextLines.join('\n'), hunks };
}

/**
 * Reconstructs file content when specific hunks are rejected.
 * Rejected hunks revert their deletions and omit their additions.
 * Approved / pending hunks retain their modifications.
 */
export function reconstructFromHunks(orig: string, curr: string, hunks: DiffHunk[]): string {
  const rejectedHunkIds = new Set(hunks.filter(h => h.review === 'rejected').map(h => h.id));
  if (rejectedHunkIds.size === 0) {
    return curr;
  }
  if (rejectedHunkIds.size === hunks.length) {
    return orig;
  }

  // Parse lines from raw diff
  const A = splitLines(orig);
  const B = splitLines(curr);
  const n = A.length, m = B.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = A[i] === B[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const raw: RawDiffOp[] = [];
  let i = 0, j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && A[i] === B[j]) {
      raw.push({ op: ' ', text: A[i], origLine: i + 1, modLine: j + 1 });
      i++; j++;
    } else if (j < m && (i >= n || lcs[i][j + 1] >= lcs[i + 1][j])) {
      raw.push({ op: '+', text: B[j], modLine: j + 1 });
      j++;
    } else {
      raw.push({ op: '-', text: A[i], origLine: i + 1 });
      i++;
    }
  }

  // Map each raw diff line index to its hunk ID
  const changeIndices: number[] = [];
  for (let idx = 0; idx < raw.length; idx++) {
    if (raw[idx].op !== ' ') { changeIndices.push(idx); }
  }

  const lineToHunkId = new Map<number, string>();
  if (changeIndices.length > 0) {
    const clusters: Array<{ start: number; end: number }> = [];
    let curCluster = { start: changeIndices[0], end: changeIndices[0] };
    for (let k = 1; k < changeIndices.length; k++) {
      const idx = changeIndices[k];
      if (idx - curCluster.end <= 6) {
        curCluster.end = idx;
      } else {
        clusters.push(curCluster);
        curCluster = { start: idx, end: idx };
      }
    }
    clusters.push(curCluster);

    for (let hIdx = 0; hIdx < clusters.length; hIdx++) {
      const cl = clusters[hIdx];
      const hunkId = hunks[hIdx]?.id ?? `hunk-${hIdx + 1}`;
      const startIdx = Math.max(0, cl.start - 3);
      const endIdx = Math.min(raw.length - 1, cl.end + 3);
      for (let rIdx = startIdx; rIdx <= endIdx; rIdx++) {
        if (raw[rIdx].op !== ' ') {
          lineToHunkId.set(rIdx, hunkId);
        }
      }
    }
  }

  // Reconstruct resulting lines
  const outLines: string[] = [];
  for (let idx = 0; idx < raw.length; idx++) {
    const item = raw[idx];
    if (item.op === ' ') {
      outLines.push(item.text);
    } else {
      const hunkId = lineToHunkId.get(idx);
      const isRejected = hunkId ? rejectedHunkIds.has(hunkId) : false;
      if (item.op === '-') {
        // Rejection means restore original line
        if (isRejected) {
          outLines.push(item.text);
        }
      } else if (item.op === '+') {
        // Rejection means do not include added line
        if (!isRejected) {
          outLines.push(item.text);
        }
      }
    }
  }

  const usesCrlf = orig.includes('\r\n') || curr.includes('\r\n');
  const sep = usesCrlf ? '\r\n' : '\n';
  const hasTrailingNewline = orig.endsWith('\n') || curr.endsWith('\n');
  const result = outLines.join(sep);
  return hasTrailingNewline && result.length > 0 ? result + sep : result;
}
