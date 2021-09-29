# <img src="./logo.svg" height="25" /> Griselbrand

> Daemon helper for [Clipanion](https://github.com/arcanis/clipanion)

[![npm version](https://img.shields.io/npm/v/griselbrand.svg)](https://yarnpkg.com/package/griselbrand) [![Licence](https://img.shields.io/npm/l/griselbrand.svg)](https://github.com/arcanis/griselbrand#license-mit) [![Yarn](https://img.shields.io/badge/developed%20with-Yarn%202-blue)](https://github.com/yarnpkg/berry)

## Installation

```sh
yarn add griselbrand
```

## Overview

Griselbrand is a companion library for [Clipanion](https://github.com/arcanis/clipanion). It lets you transparently run some commands of your CLI inside a daemon process, thus preserving the state between calls.

## Usage

Griselbrand is intended to be very simple to use. Compared to the typical Clipanion code, here are the changes needed:

- Use `DaemonContext` when creating your CLI instance
- Wrap the `execute` functions from your commands inside `daemon.register`
- Use `daemon.runExit(cli, ...)` instead of `cli.runExit(...)`

And that's it! All commands wrapped by `daemon.register` will be evaluated within a daemon context, with their output being transparently forwarded to the client. For instance, the following example will make a cli that, when called, will cause the script to print a incrementing counter on screen:

```ts
import {Cli, Command}          from 'clipanion';
import {Daemon, DaemonContext} from 'griselbrand';

const cli = new Cli<DaemonContext>();
const daemon = new Daemon<DaemonContext>({port: 6532});

let counter = 0;

cli.register(
  class MyCommand extends Command {
    execute = daemon.register(async () => {
      this.context.stdout.write(`Counter: ${counter++}\n`);
    });
  },
);

daemon.runExit(cli, process.argv.slice(2));
```

## Daemon management

The `Daemon` API provides function to start/stop/restart/get the status of the running daemon. If you wish to expose those features from the CLI, you can either implement yourself commands that leverage this API, or use `daemon.getControlCommands()`. This function will return a set of preconfigured control commands that you can then inject into the CLI. You can also optionally provide an array to the function, which will be prepended to each generated command path (for instance if you wish the `start` command to be exposed as `daemon start` rather than just `start`).

```ts
import {Cli, Command}          from 'clipanion';
import {Daemon, DaemonContext} from 'griselbrand';

const cli = new Cli<DaemonContext>();
const daemon = new Daemon<DaemonContext>({port: 6532});

for (const command of daemon.getControlCommands())
  cli.register(command);

daemon.runExit(cli, process.argv.slice(2));
```

## Cancellations

In some cases you may want to provide long-running commands that don't end by themselves (for instance when displaying a live stream of data). Unless you take special care, users aborting the connection via <kbd>Ctrl+C</kbd> won't cause the long-running commands to be aborted, leading to memory and CPU leaks.

To avoid this issue, Griselbrand provides two ways to be notified when the user disconnects:

- `this.context.clientStatus.connected` is a boolean set to false when the client disconnects
- `this.context.onClientDisconnect` is a set of functions to execute when the client disconnects

You can use any of these mechanisms to decide when to end the command:

```ts
import {Cli, Command}          from 'clipanion';
import {Daemon, DaemonContext} from 'griselbrand';
import {setTimeout}            from 'timers/promises';

const cli = new Cli<DaemonContext>();
const daemon = new Daemon<DaemonContext>({port: 6532});

cli.register(
  class MyCommand extends Command {
    execute = daemon.register(async () => {
      const controller = new AbortController();
      const signal = controller.signal;

      this.context.onClientDisconnect.add(async () => {
        controller.abort();
      });

      while (this.context.clientStatus.current) {
        await fetch(`https://example.org/some/large/payload`, {signal});
        await setTimeout(1000);
      }
    });
  },
);

daemon.runExit(cli, process.argv.slice(2));
```

## Color support

Since the daemon runs within a detached process, tools that attempt to feature-detect whether the current terminal supports colors won't work properly. This can be somewhat mitigated by forwarding the environment to the daemon through the context and detecting the supported colorset there, using [`getColorDepth`](https://nodejs.org/api/tty.html#tty_writestream_getcolordepth_env). For convenience, Griselbrand re-export it:

```ts
import {Cli, Command}                         from 'clipanion';
import {Daemon, DaemonContext, getColorDepth} from 'griselbrand';

type Context = DaemonContext & {
  env: typeof process.env;
};

const cli = new Cli<Context>();
const daemon = new Daemon<Context>({port: 6532});

cli.register(
  class MyCommand extends Command<Context> {
    execute = daemon.register(async () => {
      const supportedColorDepth = getColorDepth(this.context.env);
      this.context.stdout.write(`Supported colorset: ${supportedColorDepth}\n`);
    });
  },
);

daemon.runExit(cli, process.argv.slice(2), {
  env: process.env,
});
```

## Custom messages

Messages can be sent to the daemon without going through the CLI using `daemon.send`. It'll return an object with a promise that resolves once the daemon finished processing the request, and an `onMessage` handler called at will by daemon via the `sendClientMessage` function:

```ts
import {Daemon} from 'griselbrand';

const daemon = new Daemon({port: 6532});

daemon.onMessage = async ([a, b], {sendClientMessage}) => {
  send(`foo`);
  send(`bar`);
  return a + b;
};

if (!daemon.isInsideDaemon) {
  const request = daemon.send([10, 20]);
  
  request.onMessage.add(async () => {
    console.log(`Daemon sent ${res}`)
  });

  request.done.then(res => {
    console.log(`Daemon answered with ${res}`);
  });
}
```

Custom message handlers have also access to `clientStatus` and `onClientDisconnect`, which you can use to stop processing once the client disconnects (see [Cancellations](#Cancellations) for details).

## Development

Daemons need to run as detached process, outside of any tty, making them somewhat difficult to debug. To mitigate this issue, Griselbrand lets you easily spawn the daemon yourself as a regular process:

```
CLIPANION_DAEMON=1 node ./path/to/cli.js
```

You'll then be able to run commands as usual, which will execute within the context of the process you started.

## Watch support

Griselbrand doesn't provide watch support by default, but you can easily add it by using the `onStart` API:

```ts
import chokidar                from 'chokidar';
import {Cli, Command}          from 'clipanion';
import {Daemon, DaemonContext} from 'griselbrand';

const cli = new Cli<DaemonContext>();
const daemon = new Daemon<DaemonContext>({port: 6532});

daemon.onStart.add(async () => {
  const watcher = chokidar.watch(`.`);

  // Don't forget to wrap into the `ready` event, otherwise chokidar
  // will cause your daemon to keep restarting itself
  watcher.on(`ready`, () => {
    watcher.on(`all`, () => {
      daemon.restart();
    });
  });
});

cli.register(
  class MyCommand extends Command {
    execute = daemon.register(async () => {
      this.context.stdout.write(`Counter: ${counter++}\n`);
    });
  },
);

daemon.runExit(cli, process.argv.slice(2));
```

Note that this implementation doesn't work with the `CLIPANION_DAEMON=1` trick mentioned in the previous section, as it will cause the process to be exited and respawned as a detached process. In this particular case, tools like [`nodemon`](https://github.com/remy/nodemon) may be a better fit.

## License (MIT)

> **Copyright © 2021 Mael Nison**
>
> Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
