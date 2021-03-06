import chokidar                               from 'chokidar';
import {Cli, Command}                         from 'clipanion';
import {Daemon, DaemonContext, getColorDepth} from 'griselbrand';
import {setTimeout}                           from 'timers/promises';

type Context = DaemonContext & {
  env: typeof process.env;
};

const start = Date.now();

const cli = new Cli<Context>();
const daemon = new Daemon<Context>({port: 6532});

daemon.onStart.add(async () => {
  const watcher = chokidar.watch(`.`);

  watcher.on(`ready`, () => {
    watcher.on(`all`, () => {
      daemon.restart();
    });
  });
});

daemon.onMessage = async (size: any, {clientStatus, sendClientMessage}) => {
  const data: Array<Buffer> = [];
  const memory = () => process.memoryUsage().arrayBuffers / 1024 / 1024;

  for (let t = 0; t < 1000 && clientStatus.connected; ++t) {
    data.push(Buffer.alloc(size, 0));
    sendClientMessage(memory());
    await setTimeout(1);
  }

  return memory();
};

//Automatically expose start/stop/status commands
for (const command of daemon.getControlCommands())
  cli.register(command);

cli.register(
  class MemoryCommand extends Command<Context> {
    static paths = [[`memory`]];
    async execute() {
      // Note: this command is purposefully more complex than it could. In
      // practice, you'd just make it a regular daemon command, not a custom
      // request.

      const req = await daemon.send(1024 * 1024 * 1024, {
        autoSpawn: true,
      });

      req.onMessage.add(async data => {
        this.context.stdout.write(`Received: ${JSON.stringify(data)} MB\n`);
      });

      await req.done.then(value => {
        this.context.stdout.write(`Returned: ${JSON.stringify(value)} MB\n`);
      });
    }
  },
);

cli.register(
  class UptimeCommand extends Command<Context> {
    static paths = [[`uptime`]];
    execute = daemon.register(async () => {
      this.context.stdout.write(`Uptime: ${Math.floor((Date.now() - start) / 1000)}s\n`);
    });
  },
);

cli.register(
  class LiveCommand extends Command<Context> {
    static paths = [[`live`]];
    execute = daemon.register(async () => {
      const data: Array<Buffer> = [];

      while (this.context.clientStatus.connected) {
        data.push(Buffer.alloc(1024 * 1024 * 1024, 0));
        this.context.stdout.write(`${process.memoryUsage().arrayBuffers / 1024 / 1024} MB (${data.length})\n`);
        await setTimeout(1);
      }
    });
  },
);

cli.register(
  class ThrowCommand extends Command<Context> {
    static paths = [[`throw`]];
    execute = daemon.register(async () => {
      throw new Error(`Foobar`);
    });
  },
);

cli.register(
  class ColorCommand extends Command<Context> {
    static paths = [[`color`]];
    execute = daemon.register(async () => {
      const supportedColorDepth = getColorDepth(this.context.env);
      this.context.stdout.write(`Supported colorset: ${supportedColorDepth}\n`);
    });
  },
);

let counter = 0;

cli.register(
  class CounterCommand extends Command<Context> {
    static paths = [[`counter`]];
    execute = daemon.register(async () => {
      this.context.stdout.write(`Counter: ${counter++}\n`);
    });
  },
);

daemon.runExit(cli, process.argv.slice(2), {
  env: process.env,
});
