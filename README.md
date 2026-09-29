# Live Server Preview (in VS Code)

## Motivation

[Live Server](https://marketplace.visualstudio.com/items?itemName=ritwickdey.LiveServer) serves static HTML with live reload, but it always shows the page in an external browser. When you work on HTML reports or pages inside VS Code, especially over Remote-SSH, switching to a browser window breaks the flow. This extension keeps Live Server as the server and shows the page in a VS Code tab instead. No browser is ever opened.

## Installation

Requires VS Code 1.75 or newer. Live Server (`ritwickdey.LiveServer`) is a declared dependency, so VS Code installs it if it is missing.

```bash
code --install-extension live-server-preview-0.2.5.vsix
```

or run **Extensions: Install from VSIX...** in the Command Palette and pick the `.vsix` in this folder. With Remote-SSH, install it on the remote side, where Live Server runs. Then run **Developer: Reload Window**.

To rebuild the `.vsix` after editing the code (the extension is plain JavaScript with no dependencies):

```bash
npx @vscode/vsce package --no-dependencies
```

## Features

### Clicking an HTML file opens the preview

The preview is registered as the default editor for `*.html` and `*.htm`, so a single click in the Explorer (or opening the file any other way, such as Cmd+P) shows the rendered page. Each file gets its own tab: the extension pins the tab, so clicking a second HTML file adds a tab instead of replacing the first, as VS Code's single-click preview tabs normally would.

To make text the default again, run **Reopen Editor With...** on an HTML tab and choose **Configure default editor for '*.html'...**, or set `"workbench.editorAssociations": {"*.html": "default"}`.

### Open Source

The **Open Source** button, in both the preview toolbar and the editor title bar, reopens the file as text in the same editor group.

### Right-click: Preview in VS Code (Live Server)

The first item in the right-click menu of HTML files in the Explorer, the editor and the editor tab. It is also a preview icon in the title bar of HTML text editors. The first preview opens beside the editor, and later previews open as new tabs in that same group. If the file is already previewed, its tab is brought to the front. Live Server's own "Open with Live Server" item is left unchanged.

### Starts Live Server without a browser

1. The extension first checks whether Live Server is already serving the file. It probes the configured `liveServer.settings.port` and the next 9 ports, plus every port the extension host process listens on (Live Server runs in the same process and can fall back to a random port). A port counts only if it returns the file with Live Server's injected `<!-- Code injected by live-server -->` script.
2. If Live Server is not running, it sets `liveServer.settings.NoBrowser` to `true`, runs Live Server's `extension.liveServer.goOnline` on the file, waits for the server (up to `liveServerPreview.startTimeoutSeconds`, default 15), and then restores your previous `NoBrowser` value. Using Live Server directly still opens the browser as before.
3. The preview loads `<path relative to liveServer.settings.root>` in an iframe, through the local copy proxy described below, which forwards to Live Server at `http://<host>:<port>`. `vscode.env.asExternalUri` forwards the port when VS Code is connected to a remote (SSH, WSL, dev containers).

### Copy text from the page

Select text in the preview and press Cmd+C / Ctrl+C. Because the page runs in a cross-origin iframe inside the webview, VS Code's own copy command cannot see its selection. The extension therefore serves the preview through a small local proxy in front of Live Server that adds a short script to HTML pages. The script sends the selected text to the extension, which writes it to the clipboard. Other files and Live Server's WebSocket (live reload) pass through the proxy unchanged.

### VS Code shortcuts work while the page has focus

A cross-origin iframe keeps key presses to itself, so after clicking in the page VS Code shortcuts such as Ctrl+\` (terminal) and Ctrl+Tab (next editor) would do nothing. The script added by the proxy forwards key presses that use Ctrl, Cmd or Alt, function keys, and modifier press/release to the webview, which re-dispatches them where VS Code's webview host listens for keybindings. Select-all, copy, paste, cut, undo and redo stay in the page, and other keys (typing, arrows, Space) are not forwarded, so the page's own keyboard handling still works.

### Live reload

Edits render when you save: Live Server watches the served folder and reloads the preview on every save (not on unsaved keystrokes). These reloads run `location.reload()` inside the page, so the scroll position is kept.

The **Reload** button in the preview toolbar works the same way. It updates the file's modification time (the contents are not touched), which makes Live Server send its reload, so the page keeps its scroll position. The page flashes briefly on every reload (from the button or a save) so you can see it happened. If the page has not reloaded after 2.5 s (for example, if the file is in `liveServer.settings.ignoreFiles`), it falls back to loading the page from scratch, which scrolls to the top. Unsaved changes are saved before a preview starts.

## Limitations

- The file must be inside an open workspace folder and under `liveServer.settings.root`. Otherwise the tab shows the error, and **Open Source** still works.
- Live Server serves one workspace folder at a time. In a multi-root workspace, preview files from the folder Live Server is serving.
- VS Code gives extensions no way to hide another extension's menu items or to react to modifier-clicks in the Explorer, so those were not implemented.
