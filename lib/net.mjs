// The single choke point for "this line is about to open the network".
//
// Every place in the build (build/collect.mjs) and in the installer that can
// reach the internet -- fetch/download, `git clone`/`git fetch`, `npm
// install` on a cache miss, `pip download` -- calls assertOnline(what) first.
// With IRIS_INSTALLER_OFFLINE=1 in the environment that call throws
// `offline: <what>` *before* the network is touched, which is what
// verify/offline.mjs (Task 9) uses to prove two things:
//
//   * `IRIS_INSTALLER_OFFLINE=1 node build/build.mjs` -- the second build
//     rebuilds the whole payload from _build\cache with zero network calls
//     (any cache miss surfaces loudly as `offline: ...` instead of quietly
//     re-downloading and making the claim untestable).
//   * the installer's `setup` phase runs end to end on a PC with no network.
//
// Deliberately dependency-free and side-effect-free so both the build side
// and the shipped installer side (lib/ travels inside the zip) can import it.

export const OFFLINE_ENV = 'IRIS_INSTALLER_OFFLINE';

export function isOffline(env = process.env) {
  return env[OFFLINE_ENV] === '1';
}

// `what` is a short human description of the network action that was about to
// happen ("download node", "git clone <repo>", "npm install codex@0.154.0",
// "pip download document-mcp-wheelhouse"). It ends up verbatim in the error
// message, so it should name the part, not just the verb.
export function assertOnline(what, env = process.env) {
  if (isOffline(env)) throw new Error(`offline: ${what}`);
}
