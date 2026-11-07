import { describe, expect, it } from 'vitest';
import { decideStartup } from './decide';

const base = { debugBuild: false, projectCount: 0, firstRunDone: false, lastSeen: null as string | null, current: '1.1.67', whatsNewCount: 1 };

describe('decideStartup', () => {
  it('decideStartup fresh install', () => {
    expect(decideStartup(base)).toEqual({ openGuide: true, openWhatsNew: false, writeFirstRun: true, writeLastSeen: '1.1.67' });
  });

  it('existing user upgrading into the feature', () => {
    expect(decideStartup({ ...base, projectCount: 3 }))
      .toEqual({ openGuide: false, openWhatsNew: true, writeFirstRun: false, writeLastSeen: '1.1.67' });
  });

  it('no new sections → nothing opens but lastSeen advances', () => {
    expect(decideStartup({ ...base, projectCount: 3, lastSeen: '1.1.66', whatsNewCount: 0 }))
      .toEqual({ openGuide: false, openWhatsNew: false, writeFirstRun: false, writeLastSeen: '1.1.67' });
  });

  it('0 projects but first run already done → no guide', () => {
    expect(decideStartup({ ...base, firstRunDone: true, lastSeen: '1.1.66' }))
      .toEqual({ openGuide: false, openWhatsNew: true, writeFirstRun: false, writeLastSeen: '1.1.67' });
  });

  it('debug build never opens or writes', () => {
    expect(decideStartup({ ...base, debugBuild: true }))
      .toEqual({ openGuide: false, openWhatsNew: false, writeFirstRun: false, writeLastSeen: '' });
    expect(decideStartup({ ...base, debugBuild: true, projectCount: 2 }))
      .toEqual({ openGuide: false, openWhatsNew: false, writeFirstRun: false, writeLastSeen: '' });
  });
});
