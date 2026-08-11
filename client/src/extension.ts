import * as path from "path";
import { workspace, ExtensionContext, ConfigurationTarget } from "vscode";

import {
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
  TransportKind,
} from "vscode-languageclient/node";

let client: LanguageClient;

// Quick-fix command IDs. The server declares these in its executeCommandProvider,
// so vscode-languageclient auto-registers a VS Code command for each and routes
// invocations through the middleware below. We handle them entirely on the
// client — updating settings through the VS Code configuration API, which merges
// safely into an existing (possibly JSONC-commented) settings.json — and do NOT
// forward to the server.
const CMD_ADD_PATH_IGNORE = "rrfgcode.addPathIgnore";
const CMD_SET_MAX_LINE_LENGTH = "rrfgcode.setMaxLineLength";

/** Prefer the workspace scope when a folder is open, else fall back to global. */
function configTarget(): ConfigurationTarget {
  return workspace.workspaceFolders && workspace.workspaceFolders.length > 0
    ? ConfigurationTarget.Workspace
    : ConfigurationTarget.Global;
}

/** Add a path glob to `rrfgcode.argCheck.paths.ignore` (deduplicated). */
async function addPathIgnore(pattern: unknown): Promise<void> {
  if (typeof pattern !== "string" || pattern.length === 0) return;
  const cfg = workspace.getConfiguration("rrfgcode.argCheck.paths");
  const inspected = cfg.inspect<string[]>("ignore");

  // Append to the list in the scope that currently owns it.  Writing the
  // merged/effective list into the workspace would copy a user-level list
  // into .vscode/settings.json and permanently shadow later user-level edits.
  let target = configTarget();
  if (
    target === ConfigurationTarget.Workspace &&
    inspected?.workspaceValue === undefined &&
    inspected?.globalValue !== undefined
  ) {
    target = ConfigurationTarget.Global;
  }

  const current = (target === ConfigurationTarget.Workspace
    ? inspected?.workspaceValue
    : inspected?.globalValue) ?? [];
  if (current.includes(pattern)) return;
  await cfg.update("ignore", [...current, pattern], target);
}

/** Set `rrfgcode.maxLineLength` (0 disables the line-length check). */
async function setMaxLineLength(value: unknown): Promise<void> {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return;
  const cfg = workspace.getConfiguration("rrfgcode");
  await cfg.update("maxLineLength", Math.floor(value), configTarget());
}

export function activate(context: ExtensionContext) {
  const serverModule = context.asAbsolutePath(
    path.join("server", "out", "server.js")
  );

  const config = workspace.getConfiguration('rrfgcode');
  const activateOnGeneric = config.get<boolean>('activateOnGenericGcode', true);

  const serverOptions: ServerOptions = {
    run: { module: serverModule, transport: TransportKind.ipc },
    debug: {
      module: serverModule,
      transport: TransportKind.ipc,
    },
  };

  const documentSelector = [
    { scheme: 'file', language: 'rrf-gcode' }
  ];

  if (activateOnGeneric) {
    documentSelector.push({ scheme: 'file', language: 'gcode' });
  }

  const clientOptions: LanguageClientOptions = {
    documentSelector: documentSelector,
    synchronize: {
      fileEvents: workspace.createFileSystemWatcher('**/.clientrc')
    },
    middleware: {
      // Intercept our quick-fix commands and apply them client-side via the
      // VS Code settings API instead of forwarding to the server (which cannot
      // safely edit an existing settings.json).
      executeCommand: async (command, args, next) => {
        if (command === CMD_ADD_PATH_IGNORE) {
          await addPathIgnore(args?.[0]);
          return;
        }
        if (command === CMD_SET_MAX_LINE_LENGTH) {
          await setMaxLineLength(args?.[0]);
          return;
        }
        return next(command, args);
      }
    }
  };

  client = new LanguageClient(
    'rrf-lsp-vscode',
    'G-code Duet3D RRF Language Server',
    serverOptions,
    clientOptions
  );

  client.start();
}

export function deactivate(): Thenable<void> | undefined {
  if (!client) {
    return undefined;
  }
  return client.stop();
}
