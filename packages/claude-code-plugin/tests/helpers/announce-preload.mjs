// A probe for the hook tests, preloaded with `--import`: it says which process it was
// loaded into, on stderr. A configured session's parent loads it; its child, which gets
// no node options, must not.
process.stderr.write(`preloaded in ${process.pid}\n`);
