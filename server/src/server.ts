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

const metaDataPath = path.join(__dirname, '../data/gcode-meta-commands.json');
let metaData: Record<string, GCodeDoc> = {};

try {
  metaData = JSON.parse(fs.readFileSync(metaDataPath, 'utf8'));
} catch (error) {
  connection.console.error(`An Error occurred during loading RRF Meta Commands Dictionary: ${error}`);
}

const operatorsDataPath = path.join(__dirname, '../data/gcode-operators.json');
let operatorsData: Record<string, GCodeDoc> = {};

try {
  operatorsData = JSON.parse(fs.readFileSync(operatorsDataPath, 'utf8'));
} catch (error) {
  connection.console.error(`An Error occurred during loading RRF Operators Dictionary: ${error}`);
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

  const wordMatch = /\b(?:[GM]\d+(?:\.\d+)?|T(?:-?\d+)?|[a-zA-Z]+)\b|==|!=|<=|>=|&&|\|\||[!+\-#*/=<>&|^]/gi;
  let match;

  while ((match = wordMatch.exec(line)) !== null) {
    const start = match.index;
    const end = start + match[0].length;

    if (line[end] === '.' && (match[0] === 'var' || match[0] === 'global' || match[0] === 'param'))
      continue;

    if (position.character >= start && position.character <= end) {
      const rawMatch = match[0];

      let doc = null;
      let baseUrl = "";
      let command = "";

      if (/^(?:[GM]\d+(?:\.\d+)?|T-?\d*)$/i.test(rawMatch)) {
        const commandUpper = rawMatch.toUpperCase();

        if (commandUpper.startsWith('T') && commandUpper.length > 1) {
          const toolNumber = parseInt(commandUpper.substring(1));
          if (!isNaN(toolNumber) && (toolNumber < -1 || toolNumber > 49))
            return null;
        }

        const docKey = commandUpper.startsWith('T') ? 'T' : commandUpper;
        doc = gcodeData[docKey];

        if (doc) {
          baseUrl = "https://docs.duet3d.com/User_manual/Reference/Gcodes";
          command = commandUpper;
        }
      }
      else if (/^[a-zA-Z]+$/.test(rawMatch)) {
        doc = metaData[rawMatch];

        if (doc) {
          baseUrl = "https://docs.duet3d.com/User_manual/Reference/Gcode_meta_commands";
          command = rawMatch;
        }
      }
      else {
        doc = operatorsData[rawMatch];

        if (doc) {
          baseUrl = "https://docs.duet3d.com/User_manual/Reference/Gcode_meta_commands";
          command = rawMatch;
        }
      }

      if (doc) {
        const markdownContent = [
          `### ${command}: ${doc.title}`,
          `##### [View in Duet3D Documentation](${baseUrl}${doc.anchor})`,
          `---`,
          `${doc.description}`
        ].join('\n\n');

        return {
          contents: {
            kind: MarkupKind.Markdown,
            value: markdownContent
          },
          range: {
            start: { line: position.line, character: start },
            end: { line: position.line, character: end }
          }
        };
      }
    }
  }

  return null;
});

documents.listen(connection);
connection.listen();