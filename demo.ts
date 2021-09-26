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
], {
  binaryVersion: `1.0.0`,
});

daemon.runExit(cli, process.argv.slice(2));
