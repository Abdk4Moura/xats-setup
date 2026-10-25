import { mainPeer } from '../../lib/peer-cli.mjs';

const [stateDir, ...args] = process.argv.slice(2);
if (!stateDir || !args.length) throw new Error('peer_cli_arguments_required');
mainPeer(args, { stateDir }).catch((error) => {
  console.error(`xats peer: ${error?.message || String(error)}`);
  process.exitCode = 1;
});
