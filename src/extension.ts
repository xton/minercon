// src/extension.ts
import * as vscode from 'vscode';
import { createConsola, type ConsolaInstance } from 'consola';
import { errorMessage } from './logger';
import * as path from 'path';

export function activate(context: vscode.ExtensionContext) {
  const logger = createConsola({});
  let currentConnection: { host: string; port: number; password: string } | null = null;

  migratePasswordToSecureStorage(context).catch(err => {
    logger.warn(`Password migration warning: ${err}`);
  });

  // Register the terminal profile provider
  context.subscriptions.push(
    vscode.window.registerTerminalProfileProvider('minercon.terminal', {
      provideTerminalProfile: async (token: vscode.CancellationToken) => {
        const { profile, connectionInfo } = await createRconTerminalProfile(context);
        currentConnection = connectionInfo;
        profile.options.iconPath = {
          light: vscode.Uri.file(path.join(context.extensionPath, 'images', 'light.png')),
          dark: vscode.Uri.file(path.join(context.extensionPath, 'images', 'dark.png'))
        };
        return profile;
      }
    })
  );

  const connectCommand = vscode.commands.registerCommand('minercon.connect', async () => {
    const connectionInfo = await connectToRcon(logger, context);
    if (connectionInfo) { currentConnection = connectionInfo; }
  });

  const connectNewCommand = vscode.commands.registerCommand('minercon.connectNew', async () => {
    const connectionInfo = await connectToRcon(logger, context, false);
    if (connectionInfo) { currentConnection = connectionInfo; }
  });

  const saveDefaultsCommand = vscode.commands.registerCommand('minercon.saveDefaults', async () => {
    if (!currentConnection) {
      vscode.window.showWarningMessage('No active connection to save');
      return;
    }
    const config = vscode.workspace.getConfiguration('minercon');
    try {
      await config.update('defaultHost', currentConnection.host, vscode.ConfigurationTarget.Global);
      await config.update('defaultPort', currentConnection.port, vscode.ConfigurationTarget.Global);
      await context.secrets.store('minercon.defaultPassword', currentConnection.password);
      vscode.window.showInformationMessage(
        `Saved connection settings for ${currentConnection.host}:${currentConnection.port} as defaults`
      );
    } catch (err) {
      vscode.window.showErrorMessage(`Failed to save defaults: ${err}`);
    }
  });

  context.subscriptions.push(
    connectCommand, connectNewCommand, saveDefaultsCommand
  );
}

async function migratePasswordToSecureStorage(context: vscode.ExtensionContext) {
  const config = vscode.workspace.getConfiguration('minercon');
  const oldPassword = config.get<string>('defaultPassword');
  if (oldPassword && oldPassword !== '') {
    await context.secrets.store('minercon.defaultPassword', oldPassword);
    await config.update('defaultPassword', undefined, vscode.ConfigurationTarget.Global);
    vscode.window.showWarningMessage('🔒 Your RCON password has been migrated to secure storage', 'OK');
  }
}

async function createRconTerminalProfile(
  context: vscode.ExtensionContext,
  useDefaults: boolean = true
): Promise<{
  profile: vscode.TerminalProfile,
  connectionInfo: { host: string; port: number; password: string }
}> {
  const config = vscode.workspace.getConfiguration('minercon');
  const defaultHost = config.get<string>('defaultHost');
  const defaultPort = config.get<number>('defaultPort');
  const defaultPassword = await context.secrets.get('minercon.defaultPassword');
  const historySize = config.get<number>('historySize', 100);

  let host: string | undefined;
  let port: number;
  let password: string;

  if (useDefaults && defaultHost && defaultPort && defaultPassword) {
    host = defaultHost; port = defaultPort; password = defaultPassword;
  } else {
    host = await vscode.window.showInputBox({
      prompt: 'RCON Host', value: defaultHost ?? '127.0.0.1', placeHolder: 'e.g., 127.0.0.1 or mc.example.com'
    });
    if (!host) { throw new Error('Host is required'); }

    const portInput = await vscode.window.showInputBox({
      prompt: 'RCON Port', value: String(defaultPort ?? 25575), placeHolder: 'e.g., 25575'
    });
    if (!portInput) { throw new Error('Port is required'); }
    port = parseInt(portInput, 10);

    // Cancelling the box (undefined) aborts like host/port do; an explicitly
    // empty password (plain Enter) is allowed — some servers use one.
    const passwordInput = await vscode.window.showInputBox({
      prompt: 'RCON Password', password: true, value: defaultPassword ?? '', placeHolder: 'Enter your server RCON password'
    });
    if (passwordInput === undefined) { throw new Error('Password is required'); }
    password = passwordInput;
  }

  const minerconPath = context.asAbsolutePath(path.join('dist', 'minercon.js'));

  const profile = new vscode.TerminalProfile({
    name: `RCON: ${host}:${port}`,
    // Run the built minercon CLI as the terminal's process. process.execPath
    // is the Node runtime bundled with VS Code itself — ELECTRON_RUN_AS_NODE
    // makes it execute minerconPath as a plain node script rather than
    // launching another VS Code window, so this works without requiring the
    // user to have node on their PATH.
    shellPath: process.execPath,
    shellArgs: [minerconPath, host, String(port)],
    env: {
      ELECTRON_RUN_AS_NODE: '1',
      MCRCON_PASSWORD: password,
      MCRCON_HISTORY_SIZE: String(historySize),
    },
  });

  return {
    profile,
    connectionInfo: { host, port, password }
  };
}

async function connectToRcon(
  logger: ConsolaInstance,
  context: vscode.ExtensionContext,
  useDefaults: boolean = true
): Promise<{ host: string; port: number; password: string } | undefined> {
  try {
    const { profile, connectionInfo } = await createRconTerminalProfile(context, useDefaults);
    const terminal = vscode.window.createTerminal({
      ...profile.options,
      iconPath: {
        light: vscode.Uri.file(path.join(context.extensionPath, 'images', 'light.png')),
        dark: vscode.Uri.file(path.join(context.extensionPath, 'images', 'dark.png'))
      }
    });

    terminal.show();
    vscode.window.showInformationMessage(`Connecting to Minecraft server...`);

    return connectionInfo;
  } catch (err) {
    const message = errorMessage(err);
    if (!message.includes('required')) {
      logger.error('Connection failed: ' + message);
      vscode.window.showErrorMessage('RCON connection failed: ' + message);
    }
    return undefined;
  }
}

export function deactivate() {
  // Cleanup will happen automatically
}
