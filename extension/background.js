import { request } from './actions.js';
import * as groups from './groups.js';
import { detachSession, resumeDebugger } from './cdp.js';
import { startTransport } from './transport.js';

startTransport({
  request,
  rename: groups.rename,
  resume: resumeDebugger,
  end(session) {
    return Promise.all([groups.end(session), detachSession(session)]);
  },
});
