# deus-machine

Run Deus IDE from the command line. One command to install the desktop app or start a headless server for remote access.

## Quick Start

```
npx deus-machine
```

On a desktop, this installs and launches the Deus app. On a server, it starts headless mode with interactive setup.

## Install

```bash
# Try it (no install)
npx deus-machine

# Install globally
npm install -g deus-machine
deus
```

## Commands

```
deus                Auto-detect: desktop app or headless server
deus start          Start headless server (backend + agent-server)
deus install        Download and install the desktop app
deus pair           Generate a pairing code for remote access
deus login          Configure AI agent authentication
deus status         Show server info and connected devices
```

## Headless Server

Run Deus on a remote machine and access it from anywhere via [app.rundeus.com](https://app.rundeus.com).

```bash
deus start
```

First run walks you through setup:
1. **AI Agent** — detects Claude Code CLI or prompts for an API key
2. **Remote Access** — connects to the relay and generates a pairing code with QR

After setup, it starts the backend and shows a scannable QR code to connect from your phone or another computer.

```
deus start --data-dir ~/my-deus    # custom data directory
```

## Desktop App

On macOS, Windows, or Linux with a display:

```bash
deus install                  # download and install
deus install --version v0.1.5 # specific version
```

After installing, `deus` launches the app directly.

## Remote Pairing

Generate a new pairing code for a running server:

```bash
deus pair
```

Shows a QR code and a text code. Open [app.rundeus.com](https://app.rundeus.com), scan or enter the code, and you're connected.

## Docker

```dockerfile
FROM node:20-slim
RUN npm install -g deus-machine
EXPOSE 3000
CMD ["deus", "start"]
```

```bash
docker run -e ANTHROPIC_API_KEY=sk-ant-... -p 3000:3000 my-deus
```

## How It Works

The CLI bundles the Deus backend and agent-server. In headless mode it starts both as child processes, connects to the cloud relay for remote access, and manages the lifecycle (graceful shutdown with turn draining).

On desktop machines, it downloads the Electron app from GitHub releases and installs it to the system applications folder.

## License

MIT
