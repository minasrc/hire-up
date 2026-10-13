import assert from 'node:assert/strict';
import test from 'node:test';
import { workspaceNavigationUrl } from '../../src/app/staff/workspace-navigation-model.js';
const input = { href: '/staff/candidates?q=engineer', currentUrl: 'https://synthetic.test/staff' };
test('ordinary staff navigation receives a full-document destination', () => {
    assert.equal(workspaceNavigationUrl(input), 'https://synthetic.test/staff/candidates?q=engineer');
    assert.equal(workspaceNavigationUrl({ ...input, href: '/staff/workspaces' }), 'https://synthetic.test/staff/workspaces');
});
test('modified clicks, new tabs, downloads, local anchors and unrelated links retain native behavior', () => {
    for (const change of [{ metaKey: true }, { ctrlKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }, { defaultPrevented: true }, { target: '_blank' }, { download: true }, { preview: true }, { href: '#section' }, { href: '/staff#section' }, { href: '/staff-other' }, { href: '/jobs' }, { href: 'https://other.test/staff' }]) {
        assert.equal(workspaceNavigationUrl({ ...input, ...change }), null, JSON.stringify(change));
    }
    assert.equal(workspaceNavigationUrl({ ...input, target: '_self' }), 'https://synthetic.test/staff/candidates?q=engineer');
});
