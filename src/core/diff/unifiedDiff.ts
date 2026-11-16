/** Small dependency-free line diff (LCS) producing a unified-style diff. */
export interface DiffResult { added: number; removed: number; text: string }

export function isBinary(b: Buffer): boolean { return b.subarray(0, 8000).includes(0); }

export function unifiedDiff(name: string, a: string, b: string): DiffResult {
  const A = a === '' ? [] : a.split('\n');
  const B = b === '' ? [] : b.split('\n');
  const n = A.length, m = B.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = A[i] === B[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const lines: string[] = [];
  let i = 0, j = 0, added = 0, removed = 0;
  while (i < n || j < m) {
    if (i < n && j < m && A[i] === B[j]) { lines.push(' ' + A[i]); i++; j++; }
    else if (j < m && (i >= n || lcs[i][j + 1] >= lcs[i + 1][j])) { lines.push('+' + B[j]); j++; added++; }
    else { lines.push('-' + A[i]); i++; removed++; }
  }
  return { added, removed, text: `--- a/${name}\n+++ b/${name}\n${lines.join('\n')}` };
}
