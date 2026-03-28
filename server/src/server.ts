import {
  createConnection,
  TextDocuments,
  ProposedFeatures,
  InitializeParams,
  TextDocumentSyncKind,
  HoverParams,
  Hover,
  MarkupKind
} from 'vscode-languageserver/node';

import { TextDocument } from 'vscode-languageserver-textdocument';
import * as fs from 'fs';
import * as path from 'path';

const connection = createConnection(ProposedFeatures.all);

const documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument);

interface GCodeDoc {
  title: string;
  description: string;
  anchor: string;
}

const gcodeDataPath = path.join(__dirname, '../data/gcode-commands.json');
let gcodeData: Record<string, GCodeDoc> = {};

try {
  gcodeData = JSON.parse(fs.readFileSync(gcodeDataPath, 'utf8'));
} catch (error) {
  connection.console.error(`An Error occurred during loading RRF G-Code Dictionary: ${error}`);
}

connection.onInitialize((params: InitializeParams) => {
  return {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      hoverProvider: true
    }
  };
});

connection.onHover((params: HoverParams): Hover | null => {
  const document = documents.get(params.textDocument.uri);
  if (!document) return null;

  const position = params.position;
  const text = document.getText();
  const lines = text.split(/\r?\n/);
  const line = lines[position.line];

  const wordMatch = /\b[GMT]\d+(\.\d+)?\b/gi;
  let match;

  while ((match = wordMatch.exec(line)) !== null) {
    const start = match.index;
    const end = start + match[0].length;

    if (position.character >= start && position.character <= end) {
      const command = match[0].toUpperCase();
      const doc = gcodeData[command];

      if (doc) {
        const baseUrl = "https://docs.duet3d.com/User_manual/Reference/Gcodes";

        const markdownContent = [
          `### ${command}: ${doc.title}`,
          `---`,
          `${doc.description}`,
          `\n[See on docs.duet3d](${baseUrl}${doc.anchor})`
        ].join('\n');

        return {
          contents: {
            kind: MarkupKind.Markdown,
            value: markdownContent
          }
        };
      }
    }
  }

  return null;
});

documents.listen(connection);
connection.listen();