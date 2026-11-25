import { request } from './actions.js';
import * as groups from './groups.js';
import { detachAll, detachSession, resumeDebugger } from './cdp.js';
import { startTransport } from './transport.js';

export const handleToolbarClick = startTransport({
  request,
  rename: groups.rename,
  resume: resumeDebugger,
  detach: detachAll,
  end(session) {
    return Promise.all([groups.end(session), detachSession(session)]);
  },
});

chrome.action.onClicked.addListener(handleToolbarClick);
