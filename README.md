# RRF G-code Language Server for vscode

A lightweight Language Server Protocol (LSP) extension for VS Code that provides rich language support for RepRapFirmware (RRF) G-code files.

## Features

Currently, in version 0.1.0, this extension provides intelligent **Hover Documentation**:
* Hover over any valid G-code or M-code (e.g., `G1`, `M563`) to see its full title and description.
* Hover over Tool commands (e.g., `T0`, `T-1`) to see tool selection logic.
* Includes direct links to the official Duet3D documentation for deep dives.
* Smart validation: ignores invalid tool numbers (e.g., `T50` or `T131123`).

## Extension Settings

This extension contributes the following settings:

* `rrfgcode.activateOnGenericGcode`: Enable or disable LSP features for generic `.gcode` files (enabled by default).

## Known Issues

* Autocompletion (IntelliSense) is not yet implemented (planned for future releases).
* Strict syntax validation and error highlighting are currently limited.

## License 

This project is dual-licensed to respect the original content creators while keeping the software logic open-source.

### Code License

Copyright © 2026 Remenod

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
[GNU General Public License](LICENSE) for more details.

### Data License

The G-Code documentation data included in this project (`server/data/*`) is derived from the [Duet3D Documentation](https://docs.duet3d.com/en/User_manual/Reference/Gcodes). 

* Original content © Duet3D. 
* Licensed under the [Creative Commons Attribution-ShareAlike 4.0 International (CC BY-SA 4.0)](server/data/LICENSE).
* The data has been parsed and transformed into JSON format by Remenod.