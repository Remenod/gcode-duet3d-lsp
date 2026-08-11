# RRF G-code Language Server for VS Code

[![Version](https://img.shields.io/visual-studio-marketplace/v/remenod.rrf-lsp-vscode)](https://marketplace.visualstudio.com/items?itemName=remenod.rrf-lsp-vscode)
[![Installs](https://img.shields.io/visual-studio-marketplace/i/remenod.rrf-lsp-vscode)](https://marketplace.visualstudio.com/items?itemName=remenod.rrf-lsp-vscode)
[![Rating](https://img.shields.io/visual-studio-marketplace/r/remenod.rrf-lsp-vscode)](https://marketplace.visualstudio.com/items?itemName=remenod.rrf-lsp-vscode&ssr=false#review-details)
[![License: LGPL v3](https://img.shields.io/badge/license-LGPL--3.0-blue.svg)](LICENSE)

A Language Server Protocol (LSP) extension for VS Code that provides rich language support for RepRapFirmware (RRF) G-code and meta-command files: hover documentation, autocompletion, diagnostics, and file-path awareness backed by the official Duet3D documentation.

## Installation

Install **RepRapFirmware G-Code LSP** from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=remenod.rrf-lsp-vscode), or from the command line:

```
code --install-extension remenod.rrf-lsp-vscode
```

The extension activates automatically for `.g`, `.gcode`, `.gc` and `.gco` files.

## Features

### Core Language Support

* **Intelligent Hover Documentation**: Hover over any valid G/M/T-code, literal, function, meta command, or operator to see its full title and description, including direct links to the official Duet3D documentation.
* **Autocompletion**: Smart suggestions for commands, parameters, object model, and syntax as you type.
* **Syntax Highlighting & Validation**: Real-time syntax checking to help catch errors early, alongside improved highlighting for better readability.
* **Go to Definition (F12)**: Quickly navigate to where variables, macros, object references, or file paths are defined.
* **Variable Renaming**: Safely rename variables across your G-code files, scoped correctly to the block they were declared in.
* **Find All References (Shift+F12)**: Locate all occurrences of a variable across the workspace.
* **Duet3D Object Model Support**: Deep integration with the RRF object model, allowing for accurate references and autocompletion of object model properties.
* **Operators Syntax Check**: Correctly recognizes invalid operator usage patterns.
* **Scope Check**: Shows diagnostics based on valid variable definition scope — a variable used after its enclosing block has ended is flagged, just as the firmware would reject it at runtime.
* **Block Structure Check**: Flags orphan `else`/`elif`, `break`/`continue` outside a loop, and `iterations` used outside a loop.
* **Syntax Highlighting**: Fully customizable highlighting support via VS Code theme settings.
* **Path Completion**: Path strings inside supported G-code path parameters and path-taking functions auto-complete to existing files in the current RRF workspace, similar to `#include "..."` in C/C++.

### Argument Validation & File Path Checking

* **Command-aware path validation**: The LSP validates only parameters that are known RRF file or directory paths. This avoids treating ordinary strings, UI messages, SSIDs, passwords, or labels as filesystem paths.
* **Diagnostics for missing paths**: Static file-path literals are checked against the SD-card root and reported as warnings when the referenced file, directory, or required parent directory does not exist.
* **Correct create/save behavior**: Commands that create, save, log, or rename to a target path validate the parent directory, not the target file itself.
* **Correct default folders**: Bare relative names resolve to the same folder RepRapFirmware defaults to for that command — `/gcodes` for job-file commands (`M20`, `M23`, `M28`, `M30`, `M32`, `M36`, `M36.1`, `M37`), `/sys` for macro and configuration commands (`M98`, `M36.2`, `M374`, `M375`, `M505`), and so on.
* **Legacy tail-path support**: Commands that take a file path directly after the command, without a parameter letter, are supported where RRF documents that syntax. Examples: `M23 file.g`, `M28 file.g`, `M30 file.g`, `M32 file.g`, `M36 file.g`, `M38 file.g`.
* **Function path arguments**: The path argument of `fileexists("...")` and `fileread("...", ...)` is validated, path-completed, and Go to Definition works on it — even when the call is not inside a G-code command line. `fileexists` resolves bare names under `/sys` and is never flagged when the target is missing, since testing for an absent file is the function's purpose; `fileread` resolves under the SD-card root and is flagged, since a missing file aborts the command.
* **Command length check**: Commands longer than the firmware's G-code input buffer are flagged as errors, with a quick fix to raise the limit or disable the check. See `rrfgcode.maxLineLength`.
* **Dynamic value bypass**: Expressions like `M98 P{var.path}` or `M98 P{"dir/" ^ var.name}` are not validated because the value is runtime-dependent. Only static string literals are checked.
* **Portable ignore patterns**: Configure which paths to exclude from "file not found" warnings via glob patterns in `rrfgcode.argCheck.paths.ignore`. Patterns are SD-root-relative, so the project stays portable when moved or shared via git.
* **Quick Fix for missing files**: Right-click a "file not found" diagnostic and choose:
  - **Ignore this file** — adds the exact path to the ignore list.
  - **Ignore directory** — ignores the entire subdirectory tree.
  Both edit `.vscode/settings.json` directly through VS Code's settings API — comments and formatting in an existing file are preserved, and the result can be checked into version control.
* **Extensible validator framework**: The validation system is designed for easy extension. Adding new per-parameter checks, such as numeric ranges or enum values, requires minimal code.

### File Path Go to Definition

`Go to Definition` works for:

* Registered path parameters, for example:

```gcode
M98 P"sys/config.g"
M375 P"heightmap.csv"
M471 S"sys/config.g" T"sys/config.g.bak"
M472 P"sys/old-file.g"
```

* Legacy tail-path commands, for example:

```gcode
M23 "test.gcode"
M28 "sys/generated.g"
M36 "test.gcode"
M38 test.gcode
```

* Path-taking functions, for example:

```gcode
if fileexists("probe.g")
echo fileread("data.csv", 0, 10, ',')
```

* Strict fallback path strings in non-path parameters, for example:

```gcode
M291 P"0:/sys/config.g" R"Open config"
echo "sys/config.g"
```

Fallback path detection is intentionally conservative. It only treats a string as a path if it looks like an RRF path and the referenced file or directory actually exists. This prevents ordinary strings such as `M291 P"Printer is ready"` from being treated as paths.

## Configuration

### Basic Settings

This extension contributes the following settings:

* `rrfgcode.activateOnGenericGcode` (bool, default `true`): Enable LSP features for generic non-RRF G-code files.
* `rrfgcode.maxLineLength` (integer, default `255`): Report an error when a command exceeds this many bytes. Only the command part counts — indentation, `N` line numbers, `*` checksums and `;` comments are excluded, because RepRapFirmware never stores them in its G-code input buffer. The default matches current firmware (256-byte buffer including the terminator); older RRF 3.0–3.3 builds only accept 100–160 bytes. Set to `0` to disable the check.

### Argument Validation Settings

* `rrfgcode.argCheck.enabled` (bool, default `true`): Master switch for argument validation. When false, no G/M/T command argument checks run.
* `rrfgcode.argCheck.paths.enabled` (bool, default `true`): Enables or disables file-path existence warnings specifically.
* `rrfgcode.argCheck.paths.ignore` (array, default `[]`): Glob patterns, using forward slashes and relative to the SD-card root, that should not trigger "file not found" warnings.

#### Ignore Pattern Examples

```json
{
  "rrfgcode.argCheck.paths.ignore": [
    "sys/legacy.g",
    "macros/**",
    "macros/*.g",
    "gcodes/{test,demo}/*.g"
  ]
}
```

The patterns are always relative to the SD-card root. They are not absolute filesystem paths. This keeps `.vscode/settings.json` portable when the project is moved to another machine or shared via version control.

## Usage Examples

### File Path Autocompletion

Inside a string literal after a supported G-code path parameter, or the first argument of `fileexists`/`fileread`:

```gcode
M98 P"sys/config.g"          ; type "sys/" to see files in that directory
M375 P"heightmap.csv"        ; heightmap file path
M472 P"sys/old-file.g"       ; delete file/directory path
if fileexists("probe.g")     ; resolves under /sys, like M98
```

### File Path Validation

```gcode
M98 P"sys/mymacro.g"    ; warns if the file does not exist
M20 P"0:/gcodes"         ; validates that the directory exists
M472 P"sys/foobar"      ; validates that the file or directory exists
```

### Command Length Check

```gcode
M291 P"a very long message that pushes this command past the firmware's buffer..." S2
```

A command whose non-comment part exceeds `rrfgcode.maxLineLength` bytes is reported as an error. Use the **Increase max line length** or **Disable line-length check** quick fix on the diagnostic to adjust the setting.

### Parent Directory Validation

For commands that create, save, log, or rename to a target path, the LSP checks the parent directory:

```gcode
M374 P"mesh/heightmap.csv"                  ; checks that "mesh/" exists
M470 P"sys/config.d"                        ; checks that "sys/" exists
M471 S"sys/config.g" T"backup/config.g"     ; checks source exists and parent "backup/" exists
M929 P"logs/eventlog.txt"                   ; checks that "logs/" exists
M956 F"accelerometer/log.csv"               ; checks parent directory for the log file
```

This avoids false warnings when the target file is supposed to be created by the command.

### Legacy Tail-Path Commands

RRF has several commands where the file path is not attached to a `P` parameter. Bare names default to `/gcodes`, matching the firmware:

```gcode
M23 "test.gcode"       ; select SD file, resolves to 0:/gcodes/test.gcode
M28 "generated.g"      ; begin writing to file, resolves to 0:/gcodes/generated.g
M30 "old.g"            ; delete file
M32 "test.gcode"       ; print file
M36 "test.gcode"       ; file information
M38 "test.gcode"       ; CRC/hash of file
```

### Dynamic Runtime Paths

Runtime expressions are intentionally skipped:

```gcode
M98 P{var.macroPath}
M98 P{"macros/" ^ var.name ^ ".g"}
M472 P{global.pathToDelete}
```

The LSP cannot know the final value statically, so it does not emit path diagnostics for these expressions.

### Ignoring Generated or Temporary Files

If generated G-code files do not exist until runtime:

```json
{
  "rrfgcode.argCheck.paths.ignore": [
    "gcodes/generated/**",
    "sys/override-config.g",
    "logs/**"
  ]
}
```

## Supported Commands with Path Validation

The following commands are currently validated for file-path or directory-path arguments.

### Parameter-Based Path Commands

| Command  | Parameter | Check mode                  | Bare-name default | Meaning                                                                            |
| -------- | --------: | ---------------------------- | ------------------ | ----------------------------------------------------------------------------------- |
| `G29`    |       `P` | `exists` / `parent-exists`  | `/sys`             | Mesh file. `S3` saves, so parent directory is checked; other modes load/read.      |
| `M20`    |       `P` | `directory-exists`          | `/gcodes`          | List SD directory.                                                                 |
| `M36.1`  |       `P` | `exists`                    | `/gcodes`          | Embedded thumbnail data from a job file.                                          |
| `M36.2`  |       `P` | `exists`                    | `/sys`             | Height-map fragment from file.                                                     |
| `M37`    |       `P` | `exists`                    | `/gcodes`          | Simulation mode job file.                                                          |
| `M98`    |       `P` | `exists`                    | `/sys`             | Call macro.                                                                        |
| `M374`   |       `P` | `parent-exists`             | `/sys`             | Save height map.                                                                   |
| `M375`   |       `P` | `exists`                    | `/sys`             | Load height map.                                                                   |
| `M470`   |       `P` | `parent-exists`             | SD root            | Create directory.                                                                  |
| `M471`   |       `S` | `exists`                    | SD root            | Rename/move source file or directory.                                             |
| `M471`   |       `T` | `parent-exists`             | SD root            | Rename/move target path.                                                           |
| `M472`   |       `P` | `exists`                    | SD root            | Delete file or directory.                                                          |
| `M505`   |       `P` | `directory-exists`          | `/sys`             | Set configuration file folder.                                                     |
| `M505.1` |       `P` | `directory-exists`          | `/www`             | Set HTTP server root folder.                                                       |
| `M929`   |       `P` | `parent-exists`             | SD root            | Event log file path.                                                               |
| `M956`   |       `F` | `parent-exists`             | `/sys/accelerometer` | Accelerometer output file.                                                       |
| `M997`   |       `P` | `exists`                    | `/firmware`        | Firmware update file.                                                              |

### Legacy Tail-Path Commands

| Command | Check mode      | Bare-name default | Meaning                      |
| ------- | --------------- | ------------------ | ----------------------------- |
| `M23`   | `exists`        | `/gcodes`          | Select SD file.               |
| `M28`   | `parent-exists` | `/gcodes`          | Begin writing to file.        |
| `M30`   | `exists`        | `/gcodes`          | Delete file.                  |
| `M32`   | `exists`        | `/gcodes`          | Select file and start print.  |
| `M36`   | `exists`        | `/gcodes`          | File information.             |
| `M38`   | `exists`        | `/gcodes`          | File CRC/hash.                |

### Function Path Arguments

| Function       | Missing target | Bare-name default | Meaning                                                    |
| -------------- | --------------- | ------------------ | ------------------------------------------------------------ |
| `fileexists()` | Not flagged     | `/sys`             | Tests whether a file exists; a missing file is expected.   |
| `fileread()`   | Flagged         | SD root            | Reads a file; a missing file aborts the containing command. |

## Notes on RRF Path Resolution

The LSP resolves common RRF path forms relative to the detected SD-card root:

```text
0:/sys/config.g  -> <sd-root>/sys/config.g
/sys/config.g    -> <sd-root>/sys/config.g
sys/config.g     -> <sd-root>/sys/config.g
```

For a bare name with no leading slash or volume, the command determines the base folder:

```text
M98 P"config.g"           -> <sd-root>/sys/config.g       (macro default: /sys)
M32 "test.gcode"          -> <sd-root>/gcodes/test.gcode  (job-file default: /gcodes)
M997 P"Duet3Firmware.bin" -> <sd-root>/firmware/Duet3Firmware.bin
M956 F"log.csv"           -> <sd-root>/sys/accelerometer/log.csv
fileexists("probe.g")     -> <sd-root>/sys/probe.g
```

Paths containing URLs, backslashes, null bytes, or paths escaping outside the detected SD-card root are rejected by the path resolver.

## Using with Other LSP Clients

The quick fixes for missing-path and command-length diagnostics are commands (`rrfgcode.addPathIgnore`, `rrfgcode.setMaxLineLength`). In VS Code they are intercepted by this extension's client and applied through the VS Code settings API. Any other LSP client that invokes them (Neovim, Helix, etc.) falls back to a server-side implementation that edits `.vscode/settings.json` directly — preserving comments and formatting — or creates it if it does not yet exist.

## Known Issues

* **No type checking**: RRF G-code is dynamically typed. The LSP does not perform full static type inference.
* **Runtime paths are not evaluated**: Expressions such as `P{var.path}` are skipped by design.
* **Fallback F12 is not a diagnostic source**: Strict fallback path detection is used only for `Go to Definition`; it does not emit "file not found" warnings for arbitrary strings.
* **Multi-root workspaces**: Settings are read once per server instance rather than per workspace folder, so a setting overridden in one folder of a multi-root workspace is not honored for files in that folder.
* **Performance**: Path validation adds filesystem I/O. Very large repositories with thousands of files may see minor latency during diagnostics.

See the [releases page](https://github.com/Remenod/rrf-lsp-vscode/releases) for the full history of changes between versions.

## License

This project is dual-licensed to respect the original content creators while keeping the software logic open-source.

### Code License

Copyright © 2026 Remenod

This program is free software: you can redistribute it and/or modify
it under the terms of the **GNU Lesser General Public License** as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
[GNU Lesser General Public License](https://www.gnu.org/licenses/lgpl-3.0.html) for more details.

### Data License

The G-Code documentation data included in this project (`server/data/*`) is derived from the [Duet3D Documentation](https://docs.duet3d.com/en/User_manual/Reference/Gcodes).

* Original content © Duet3D.
* Licensed under the [Creative Commons Attribution-ShareAlike 4.0 International (CC BY-SA 4.0)](server/data/LICENSE).
* The data has been parsed and transformed into JSON format by Remenod.
