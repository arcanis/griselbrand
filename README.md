# <img src="./logo.svg" height="25" /> Clipanion

> Daemon helper for [Clipanion](https://github.com/arcanis/clipanion)

[![npm version](https://img.shields.io/npm/v/griselbrand.svg)](https://yarnpkg.com/package/griselbrand) [![Licence](https://img.shields.io/npm/l/griselbrand.svg)](https://github.com/arcanis/griselbrand#license-mit) [![Yarn](https://img.shields.io/badge/developed%20with-Yarn%202-blue)](https://github.com/yarnpkg/berry)

## Installation

```sh
yarn add griselbrand
```

## What is it?

Griselbrand is a companion library for [Clipanion](https://github.com/arcanis/clipanion). It lets you transparently run some commands of your CLI inside a daemon process, thus preserving the state between calls.

## Overview


Griselbrand is intended to be very simple to use. The main thing is to annotate the commands that need to be run within a daemon context. In the following example, calling the script will cause a counter to be printed on screen, incremented at each invocation thanks to the `daemon.register(execute)` wrapper:

```ts
import {Cli, Command} from 'clipanion';
import {Daemon}       from 'griselbrand';

const daemon = new Daemon({port: 6532});

let counter = 0;

const cli = Cli.from([
  ...daemon.getControlCommands(),
  class MyCommand extends Command {
    execute = daemon.register(async () => {
      this.context.stdout.write(`Counter: ${counter++}\n`);
    });
  },
]);

daemon.runExit(cli, process.argv.slice(2));
```

Adding the commands provided by `daemon.getControlCommands()` to your CLI is optional and will automatically expose CLI commands for `status`/`start`/`stop`/`restart`. You can also implement them yourself by calling the relevant functions from the `daemon` instance.

## License (MIT)

> **Copyright © 2019 Mael Nison**
>
> Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
