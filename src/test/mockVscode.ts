// Mock implementation of VS Code APIs for unit and integration testing outside the extension host
import * as path from 'node:path';

export const mockVscode = {
  Uri: {
    file: (p: string) => ({ fsPath: p, scheme: 'file', toString: () => `file://${p}` }),
    joinPath: (base: { fsPath: string }, ...segments: string[]) => ({
      fsPath: path.join(base.fsPath, ...segments),
      scheme: 'file',
      toString: () => `file://${path.join(base.fsPath, ...segments)}`,
    }),
  },
  workspace: {
    workspaceFolders: [] as Array<{ uri: { fsPath: string } }>,
    getConfiguration: (_section?: string) => ({
      get: <T>(_key: string, defaultValue?: T) => defaultValue,
    }),
  },
  window: {
    showWarningMessage: async (_msg: string, ..._args: unknown[]) => 'Restore',
    showInformationMessage: async (_msg: string, ..._args: unknown[]) => undefined,
    showInputBox: async (_options?: unknown) => undefined,
    registerWebviewViewProvider: (_id: string, _provider: unknown) => ({ dispose: () => {} }),
  },
  commands: {
    registerCommand: (_id: string, _handler: Function) => ({ dispose: () => {} }),
    executeCommand: async (_id: string, ..._args: unknown[]) => undefined,
  },
};

// Install hook in Module._load
const Module = require('node:module');
const origLoad = Module._load;
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'vscode') {
    return mockVscode;
  }
  return origLoad.apply(this, [request, parent, isMain]);
};
