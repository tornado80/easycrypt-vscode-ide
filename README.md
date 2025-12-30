# EasyCrypt VS Code Extension

EasyCrypt language support for Visual Studio Code: syntax highlighting, diagnostics via the `easycrypt` CLI, and interactive proof development with proof-state navigation.

## Features

- **Syntax highlighting** for EasyCrypt (`.ec`, `.eca`).
- **Diagnostics / squiggles** by running EasyCrypt and parsing its output.
  - Manual check via command.
  - Optional live checks on change/save.
- **Interactive proof navigation** backed by a long-running EasyCrypt process:
  - Step forward/backward through statements.
  - Jump to cursor.
  - Reset proof state.
- **Proof State view** (Explorer panel) that shows goals/messages/output and includes navigation buttons.
- **Status bar indicator** for quick “check file” access.
- **Verbose logging** to the “EasyCrypt” Output channel (optional).

## Requirements

- EasyCrypt installed locally.
- The `easycrypt` executable must be available on your `PATH`, or configured explicitly via `easycrypt.executablePath`.

## Getting Started

1. Install EasyCrypt.
2. Open an EasyCrypt file (`.ec`/`.eca`) in VS Code.
3. Run **“EasyCrypt: Check File”** from the Command Palette.
4. (Optional) Open the **Proof State** view in the Explorer to step through proofs.

## Commands

From the Command Palette:

- **EasyCrypt: Check File** (`easycrypt.checkFile`)
- **EasyCrypt: Start/Restart Process** (`easycrypt.startProcess`)
- **EasyCrypt: Stop Process** (`easycrypt.stopProcess`)
- **EasyCrypt: Clear All Diagnostics** (`easycrypt.clearAllDiagnostics`)
- **EasyCrypt: Clear File Diagnostics** (`easycrypt.clearFileDiagnostics`)
- **EasyCrypt: Show Diagnostic Count** (`easycrypt.showDiagnosticCount`)
- **EasyCrypt: Step Forward** (`easycrypt.stepForward`)
- **EasyCrypt: Step Backward** (`easycrypt.stepBackward`)
- **EasyCrypt: Go to Cursor** (`easycrypt.goToCursor`)
- **EasyCrypt: Reset Proof State** (`easycrypt.resetProof`)
- **EasyCrypt: Force Recovery (Fix Desync)** (`easycrypt.forceRecovery`)
- **EasyCrypt: Toggle Verbose Logging** (`easycrypt.toggleVerboseLogging`)

## Keybindings

The extension provides navigation keybindings when editing EasyCrypt files, controlled by `easycrypt.keybindings.profile`:

- `default`
  - Step Forward: `Alt+Down`
  - Step Backward: `Alt+Up`
  - Go to Cursor: `Alt+Right`
  - Reset Proof State: `Alt+Left`
- `proof-general`
  - Step Forward: `Ctrl+Alt+Down` (macOS: `Ctrl+Down`)
  - Step Backward: `Ctrl+Alt+Up` (macOS: `Ctrl+Up`)
  - Go to Cursor: `Ctrl+Alt+Right` (macOS: `Ctrl+Right`)
  - Reset Proof State: `Ctrl+Alt+Left` (macOS: `Ctrl+Left`)
- `none`
  - No keybindings are contributed by the extension.

Additionally:

- Check File: `Ctrl+Shift+C` (macOS: `Cmd+Shift+C`)

## Configuration

Settings (see VS Code Settings UI under “EasyCrypt”):

- `easycrypt.keybindings.profile`: `default` | `proof-general` | `none`
- `easycrypt.executablePath`: path to the EasyCrypt binary (default: `easycrypt`)
- `easycrypt.arguments`: additional CLI args passed to EasyCrypt on startup
- `easycrypt.proverArgs`: args for backend provers (passed through EasyCrypt)

Diagnostics:

- `easycrypt.diagnostics.enabled`: enable/disable diagnostics
- `easycrypt.diagnostics.liveChecks`: enable/disable live checks
- `easycrypt.diagnostics.delay`: debounce delay (ms) for live checks
- `easycrypt.diagnostics.onChange`: run checks when text changes
- `easycrypt.diagnostics.onSave`: run checks on save

Logging / debug:

- `easycrypt.verboseLogging`: enable verbose logging to the “EasyCrypt” Output channel
- `easycrypt.proofStateView.debug.showEmacsPromptMarker`: show the EasyCrypt `-emacs` prompt marker in the Proof State view

## Troubleshooting

- **“EasyCrypt executable not found”**
  - Set `easycrypt.executablePath` to the full path of your `easycrypt` binary.
  - Or ensure `easycrypt` is on your `PATH` and restart VS Code.
- **Desynchronized proof state**
  - Run **“EasyCrypt: Force Recovery (Fix Desync)”**.
  - If needed, run **“EasyCrypt: Reset Proof State”**.
- **Where are logs?**
  - Open **View → Output** and select **EasyCrypt**.
  - Enable verbose logs with **“EasyCrypt: Toggle Verbose Logging”**.

## Development

Prereqs: Node.js + npm.

- Install dependencies: `npm install`
- Compile: `npm run compile`
- Watch: `npm run watch`
- Lint: `npm run lint`

### Running the extension locally

- Open this repo in VS Code.
- Press `F5` to launch an Extension Development Host.
- Open a `.ec` file in the dev host to activate the extension.

### Tests

- Unit tests: `npm test`
- E2E tests: `npm run test:e2e`

## License

GPL-3.0. See [LICENSE](LICENSE).
