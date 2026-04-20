# RRF G-code Language Server for VS Code

A lightweight Language Server Protocol (LSP) extension for VS Code that provides rich language support for RepRapFirmware (RRF) G-code files.

## Features

Currently, in version 0.3.0, this extension significantly expands its capabilities, offering a comprehensive suite of tools for RRF developers:

* **Intelligent Hover Documentation**: Hover over any valid G/M/T-code, literal, function, meta command, or operator to see its full title and description, including direct links to the official Duet3D documentation.
* **Autocompletion**: Smart suggestions for commands, parameters, object model, and syntax as you type.
* **Syntax Highlighting & Validation**: Real-time syntax checking to help catch errors early, alongside improved highlighting for better readability. Includes smart validation (e.g., ignoring invalid tool numbers like `T50` or `T-2`).
* **Go to Definition**: Quickly navigate to where variables, macros, or specific references are defined.
* **Variable Renaming**: Safely rename variables across your G-code files.
* **Duet3D Object Model Support**: Deep integration with the RRF object model, allowing for accurate references and autocompletion of object model properties.

## Extension Settings

This extension contributes the following settings:

* `rrfgcode.activateOnGenericGcode`: Enable or disable LSP features for generic non-RRF gcode files (enabled by default).

## Known Issues

* **Stability**: Version 0.3.0 introduces a massive increase in functionality. While tested, some of the newer features (like complex syntax validation and deep object model autocompletion) are still stabilizing and might behave unexpectedly in edge cases.
* Performance optimizations for very large G-code files are ongoing.

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