import * as path from "path";
import { workspace, ExtensionContext, DocumentSelector } from "vscode";

import {
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
  TransportKind,
} from "vscode-languageclient/node";

let client: LanguageClient;

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
