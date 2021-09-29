import {fork}                                                        from 'child_process';
import {BaseContext, Cli, Command, CommandClass, Option, UsageError} from 'clipanion';
import {PassThrough}                                                 from 'stream';
import tty                                                           from 'tty';
import WebSocket, {WebSocketServer}                                  from 'ws';

type MakeOptional<T, Keys extends keyof T> = Omit<T, Keys> & Partial<Pick<T, Keys>>;
type VoidIfEmpty<T> = keyof T extends never ? void : never;

const log = (...data: Array<any>) => {
  if (process.env.DEBUG_DAEMON === `1`) {
    console.log(process.pid, data);
  }
};

const isInsideDaemon = process.env.CLIPANION_DAEMON === `1`;
log(process.pid, `is daemon?`, isInsideDaemon);

export const getColorDepth = tty.WriteStream.prototype.getColorDepth;
export const hasColors = tty.WriteStream.prototype.hasColors;

export type ClientStatus = {
  connected: boolean;
};

export type DaemonContext = BaseContext & {
  onClientDisconnect: Set<() => Promise<void>>;
  clientStatus: ClientStatus;
};

export type DaemonOptions = {
  port: number;
};

export class Daemon<Context extends DaemonContext = DaemonContext> {
  public port: number;

  public readonly env: Record<string, string> = {};

  public readonly onStart = new Set<() => Promise<void>>();
  public readonly onStop = new Set<() => Promise<void>>();

  public onMessage?: (message: unknown, opts: {
    clientStatus: ClientStatus;
    onClientDisconnect: Set<() => Promise<void>>,
    sendClientMessage: (response: unknown) => void,
  }) => Promise<unknown>;

  private wss?: WebSocketServer;

  private rebootInProgress = false;

  private messages = new Map<number, {
    onMessage: Set<(data: unknown) => Promise<void>>;
    resolve: (data: unknown) => void;
    reject: (err: Error) => void;
  }>();

  constructor({port}: DaemonOptions) {
    this.port = port;
  }

  get isInsideDaemon() {
    return isInsideDaemon;
  }

  getControlCommands(mountPath: Array<string> = []): Array<CommandClass<Context>> {
    const daemon = this;

    return [
      class StartCommand extends Command<Context> {
        static paths = [[...mountPath, `status`]];

        static usage = Command.Usage({
          category: `Daemon-related commands`,
          description: `Display the daemon version`,
        });

        json = Option.Boolean(`--json`);

        async execute() {
          const version = await daemon.status();
          if (this.json) {
            this.context.stdout.write(`${JSON.stringify(version)}\n`);
          } else {
            if (version === null) {
              this.context.stdout.write(`The daemon is down\n`);
            } else {
              this.context.stdout.write(`${version}\n`);
            }
          }
        }
      },

      class StartCommand extends Command<Context> {
        static paths = [[...mountPath, `start`]];

        static usage = Command.Usage({
          category: `Daemon-related commands`,
          description: `Start the daemon`,
        });

        async execute() {
          await daemon.start();
        }
      },

      class StopCommand extends Command<Context> {
        static paths = [[...mountPath, `stop`]];

        static usage = Command.Usage({
          category: `Daemon-related commands`,
          description: `Stop the daemon`,
        });

        async execute() {
          await daemon.stop();
        }
      },

      class RestartCommand extends Command<Context> {
        static paths = [[...mountPath, `restart`]];

        static usage = Command.Usage({
          category: `Daemon-related commands`,
          description: `Restart the daemon`,
        });

        async execute() {
          await daemon.restart();
        }
      },
    ];
  }

  async status() {
    let ws: WebSocket;
    try {
      ws = await this.open({autoSpawn: false});
    } catch (err: any) {
      if (err.message.startsWith(`connect ECONNREFUSED`)) {
        return null;
      } else {
        throw err;
      }
    }

    ws.send(JSON.stringify({
      type: `status`,
    }));

    try {
      return await new Promise<string>((resolve, reject) => {
        setTimeout(() => {
          reject(new Error(`Timeout reached`));
        }, 3000).unref();

        ws.on(`message`, message => {
          const payload = JSON.parse(message as any);

          switch (payload.type) {
            case `status`: {
              resolve(payload.version);
            } break;
          }
        });
      });
    } finally {
      ws.close();
    }
  }

  async start() {
    if (isInsideDaemon)
      throw new Error(`Cannot call .start() from within the daemon process`);

    const ws = await this.open();
    ws.close();
  }

  async send(data: unknown, {autoSpawn = false}: {autoSpawn?: boolean} = {}) {
    if (isInsideDaemon)
      throw new Error(`Cannot call .message() from within the daemon process`);

    let id: number;
    do {
      id = Math.floor(Math.random() * 0x100000000);
    } while (this.messages.has(id));

    const onMessage = new Set<(data: unknown) => Promise<void>>();
    const done = this.open({autoSpawn}).then(ws => {
      const done = new Promise<unknown>((resolve, reject) => {
        this.messages.set(id, {onMessage, resolve, reject});
        ws.send(JSON.stringify({type: `message`, id, data}));
      });

      return done.finally(() => {
        ws.close();
      });
    });

    return {onMessage, done};
  }

  async stop() {
    if (isInsideDaemon) {
      this.wss?.close();
      return;
    }

    let ws: WebSocket;
    try {
      ws = await this.open({autoSpawn: false});
    } catch (err: any) {
      if (err.message.startsWith(`connect ECONNREFUSED`)) {
        return;
      } else {
        throw err;
      }
    }

    ws.send(JSON.stringify({type: `stop`}));
    ws.close();
  }

  async restart() {
    if (isInsideDaemon) {
      if (!this.rebootInProgress) {
        this.rebootInProgress = true;
        this.wss?.close();
        await this.spawn();
      }
    } else {
      await this.stop();
      await this.start();
    }
  }

  register(fn: () => Promise<number | void>): () => Promise<number | void> {
    if (isInsideDaemon) {
      return async function (this: Command) {
        log(`executing the command`, this.path);
        return await fn();
      };
    }

    const daemon = this;

    return async function (this: Command) {
      const ws = await daemon.open();

      const {stdin, stdout, stderr, ...context} = this.context;

      ws.send(JSON.stringify({
        type: `cli`,
        args: process.argv.slice(2),
        version: this.cli.binaryVersion,
        context,
      }));

      return await new Promise((resolve, reject) => {
        ws.on(`message`, message => {
          const payload = JSON.parse(message as any);
          log(`server payload received`, JSON.stringify(payload));

          switch (payload.type) {
            case `stdout`: {
              this.context.stdout.write(Buffer.from(payload.data, `base64`));
            } break;

            case `error`: {
              ws.close();
              reject(serializableToError(payload.error));
            } break;

            case `exit`: {
              ws.close();
              resolve(payload.exitCode);
            } break;
          }
        });
      });
    };
  }

  async runExit(cli: Cli<Context>, argv: Array<string>, context: VoidIfEmpty<Omit<Context, keyof DaemonContext>>): Promise<void>;
  async runExit(cli: Cli<Context>, argv: Array<string>, context: MakeOptional<Context, keyof DaemonContext>): Promise<void>;
  async runExit(cli: Cli<Context>, argv: Array<string>, context: any) {
    if (!isInsideDaemon) {
      log(`running the cli`);
      return cli.runExit(argv, {...context, clientStatus: {connected: false}, onClientDisconnect: new Set()});
    }

    if (typeof this.wss !== `undefined`)
      throw new Error(`Daemons can only start once`);

    log(`server starting`);
    return new Promise<void>((resolve, reject) => {
      const wss = this.wss = new WebSocketServer({
        port: this.port,
      });

      wss.on(`listening`, async () => {
        for (const fn of this.onStart)
          await fn();

        process.send?.(`ready`);
      });

      wss.on(`connection`, ws => {
        const onClientDisconnect = new Set<() => Promise<void>>();
        const clientStatus: ClientStatus = {connected: true};

        ws.on(`close`, async () => {
          clientStatus.connected = false;

          for (const fn of onClientDisconnect)
            await fn();

          resolve();
        });

        ws.on(`message`, async message => {
          const send = (data: any) => {
            ws.send(JSON.stringify(data));
          };

          const sendError = (error: unknown) => {
            send({type: `error`, error: errorToSerializable(error)});
          };

          let payload: any;
          try {
            payload = JSON.parse(message as any);
          } catch {
            log(`invalid json data received`, JSON.stringify(message));
            ws.close();
            return;
          }

          log(`client payload received`, JSON.stringify(payload));

          switch (payload.type) {
            case `message`: {
              const sendClientMessage = (data: unknown) => send({type: `message/yield`, id: payload.id, data});

              let res: any, error: any, success = false;
              try {
                res = await this.onMessage?.(payload.data, {sendClientMessage, onClientDisconnect, clientStatus});
                success = true;
              } catch (err) {
                error = err;
                success = false;
              }

              if (success) {
                send({type: `message/resolve`, id: payload.id, data: res});
              } else {
                send({type: `message/reject`, id: payload.id, error: errorToSerializable(error)});
              }
            } break;

            case `status`: {
              send({type: `status`, version: cli.binaryVersion ?? `<unknown>`});
            } break;

            case `stop`: {
              wss.close();
            } break;

            case `cli`: {
              const stdout = new PassThrough();
              stdout.on(`data`, data => send({type: `stdout`, data: data.toString(`base64`)}));

              if (payload.version != cli.binaryVersion) {
                sendError(new UsageError(`Mismatched binary versions (cli is ${payload.version}, whereas the daemon is ${cli.binaryVersion})`));
                return;
              }

              cli.run(payload.args, {
                ...payload.context,
                onClientDisconnect,
                stdout,
              }).then(exitCode => {
                send({type: `exit`, exitCode});
              }, err => {
                sendError(err);
              });
            } break;
          }
        });
      });

      wss.on(`error`, error => {
        process.stdout.write(cli.error(error));
      });

      wss.on(`close`, async () => {
        for (const fn of this.onStop)
          await fn();

        resolve();
      });
    });
  }

  private async open({autoSpawn = true}: {autoSpawn?: boolean} = {}) {
    try {
      return await this.request();
    } catch (err: any) {
      if (err.message.startsWith(`connect ECONNREFUSED`) && autoSpawn) {
        await this.spawn();
        return await this.request();
      } else {
        throw err;
      }
    }
  }

  private async spawn() {
    return new Promise<void>((resolve, reject) => {
      log(`spawning a server`);

      const child = fork(process.argv[1], process.argv.slice(2), {
        detached: true,
        stdio: [`ignore`, `ignore`, `ignore`, `ipc`],
        env: {
          ...process.env,
          ...this.env,
          CLIPANION_DAEMON: `1`,
        },
      });

      child.unref();

      child.on(`error`, reject);
      child.on(`message`, message => {
        log(`server handshake received:`, message);
        child.disconnect();
        resolve();
      });
    });
  }

  private async request() {
    let ws: WebSocket;
    try {
      ws = await new Promise<WebSocket>((resolve, reject) => {
        log(`attempting a connection`);
        const ws = new WebSocket(`ws://localhost:${this.port}`);

        ws.on(`error`, err => reject(err));
        ws.on(`open`, () => resolve(ws));
      });
    } catch (err: any) {
      log(`websocket creation failed:`, err.message);
      throw err;
    }

    ws.on(`message`, async message => {
      const payload = JSON.parse(message as any);

      switch (payload.type) {
        case `message/yield`: {
          const message = this.messages.get(payload.id);
          if (typeof message === `undefined`)
            break;

          for (const fn of message.onMessage) {
            await fn(payload.data);
          }
        } break;

        case `message/resolve`: {
          const message = this.messages.get(payload.id);
          if (typeof message === `undefined`)
            break;

          this.messages.delete(payload.id);
          message.resolve(payload.data);
        } break;

        case `message/reject`: {
          const message = this.messages.get(payload.id);
          if (typeof message === `undefined`)
            break;

          this.messages.delete(payload.id);
          message.reject(serializableToError(payload.error));
        } break;
      }
    });

    log(`websocket opened`);
    return ws;
  }
}

type SerializedError = {
  message: string;
  stack?: string;
  isUsage: boolean;
};

function errorToSerializable(data: unknown): SerializedError {
  const error = data instanceof Error
    ? data
    : new Error(`Not an error: ${JSON.stringify(data)}`);

  return {
    message: error.message,
    stack: error.stack,
    isUsage: error instanceof UsageError,
  };
}

function serializableToError(data: SerializedError) {
  const ErrorKlass = data.isUsage ? UsageError : Error;
  const error = new ErrorKlass(data.message);
  error.stack = data.stack;
  return error;
}
