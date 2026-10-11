// Test-only preload (`node --import`): the passwd database's home, as the hooks
// read it (`os.userInfo().homedir`, config.mjs), becomes TEST_PASSWD_HOME, so a
// test can give a hook a config anchor of its own. The shipped hooks have no seam
// for this: neither the environment nor argv moves the anchor.

import { syncBuiltinESMExports } from "node:module";
import os from "node:os";

const real = os.userInfo;
os.userInfo = (options) => ({ ...real(options), homedir: process.env.TEST_PASSWD_HOME });
syncBuiltinESMExports();
